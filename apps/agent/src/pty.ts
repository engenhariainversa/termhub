import fs from 'node:fs';
import path from 'node:path';
import { clampSize, ptyEnv } from '@termhub/machine-ops';
import type { PtyOpenParams } from '@termhub/agent-protocol';
import type { AgentSocket } from './client.js';
import type { PtyManager } from './dispatch.js';
import { agentEnv, tmuxPath } from './exec.js';
import { ensureSpawnHelperExecutable, type SpawnHelperStatus } from './pty-health.js';

/**
 * The slice of node-pty's `IPty` this module actually uses. Kept narrow (rather than importing
 * `IPty` itself) so tests can inject a fake process without pulling in node-pty's native module —
 * `IPty` is a structural supertype of this, so the real `pty.spawn` still satisfies `SpawnFn`.
 */
export interface PtyLike {
  pid: number;
  onData(cb: (data: string) => void): Disposable;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** node-pty's `IDisposable`: the handle `onData`/`onExit` return to remove the listener. */
export interface Disposable {
  dispose(): void;
}

export interface SpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => PtyLike;

export interface PtyManagerDeps {
  /** Defaults to node-pty's `spawn`, imported lazily so tests never load the native module. */
  spawn?: SpawnFn;
  tmuxPath?: string;
  log: (msg: string, meta?: object) => void;
  /** Defaults to fixing node-pty's spawn-helper exec bit (see pty-health.ts). */
  repairSpawnHelper?: () => SpawnHelperStatus;
  /** How long after a kill a PTY that has not reported its exit gets logged. Defaults to 10 s. */
  killGraceMs?: number;
}

/** `~` / `~/…` expanded against `HOME`; anything else passed through unchanged. */
function expandHome(rawCwd: string, home: string): string {
  if (rawCwd === '~') return home;
  if (rawCwd.startsWith('~/')) return path.join(home, rawCwd.slice(2));
  return rawCwd;
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves the tmux `-c` / spawn cwd: the requested dir if it exists (after `~` expansion), else HOME. */
function resolveCwd(rawCwd: string): string {
  const home = process.env.HOME || '/';
  const expanded = expandHome(rawCwd, home);
  return existsDir(expanded) ? expanded : home;
}

/** node-pty's error when its spawn-helper cannot be executed (usually a lost exec bit). */
function isSpawnHelperFailure(err: unknown): boolean {
  return /posix_spawnp failed/.test(err instanceof Error ? err.message : String(err));
}

function isEnoent(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e?.code === 'ENOENT') return true;
  const message = e instanceof Error ? e.message : String(err);
  return /ENOENT/.test(message);
}

/**
 * Attaches PTY channels to tmux sessions on this machine, mirroring the server's local spawn
 * (`apps/server/src/terminal/pty-session.ts`'s `local` branch of `buildSpawn`): same argv
 * (`-u new-session -A -s <session> -c <cwd>`), same UTF-8 env, same HOME cwd fallback.
 */
/**
 * A channel's slot, taken synchronously by open() before its first await. While `opening`, the
 * PTY does not exist yet; close()/closeAll() cancel it by dropping the slot, and open() checks the
 * slot is still its own before (and right after) spawning. Only a live opening becomes `open`.
 */
type Channel = OpeningChannel | OpenChannel;

interface OpeningChannel {
  state: 'opening';
  /** Sends `closed` to the server at most once (shared with the OpenChannel it becomes). */
  sendClosed(code: number | null): void;
}

interface OpenChannel {
  state: 'open';
  proc: PtyLike;
  /** Set (before the kill) by close()/closeAll(): output the pty still emits is dropped. */
  closed: boolean;
  sendClosed(code: number | null): void;
  /** Stops forwarding and kills the PTY, once; a no-op after the process exited. */
  terminate(): void;
}

export function createPtyManager(deps: PtyManagerDeps): PtyManager {
  const channels = new Map<number, Channel>();
  const tmux = deps.tmuxPath ?? tmuxPath();
  const repairSpawnHelper = deps.repairSpawnHelper ?? (() => ensureSpawnHelperExecutable());
  const killGraceMs = deps.killGraceMs ?? 10_000;
  let spawnFn: SpawnFn | undefined = deps.spawn;

  async function resolveSpawn(): Promise<SpawnFn> {
    if (!spawnFn) {
      const nodePty = await import('node-pty');
      spawnFn = nodePty.spawn as unknown as SpawnFn;
    }
    return spawnFn;
  }

  /** Live entries only: an opening channel has no PTY to write to or resize yet. */
  function openEntry(ch: number): OpenChannel | undefined {
    const entry = channels.get(ch);
    return entry?.state === 'open' ? entry : undefined;
  }

  /**
   * Wires the PTY's listeners and returns its entry, whose `terminate` stops forwarding,
   * kills the process once and logs it if it has not exited `killGraceMs` later. The exit
   * listener stays until the process exits, so that log line can tell "kill requested" apart
   * from "process gone".
   */
  function attach(ch: number, proc: PtyLike, sendClosed: (code: number | null) => void, socket: AgentSocket): OpenChannel {
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let dataDisposed = false;
    const stopData = () => {
      if (dataDisposed) return;
      dataDisposed = true;
      dataListener.dispose();
    };

    const entry: OpenChannel = {
      state: 'open',
      proc,
      closed: false,
      sendClosed,
      terminate: () => {
        if (entry.closed) return;
        entry.closed = true;
        if (exited) return;
        stopData();
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        if (exited) return; // node-pty may report the exit synchronously
        killTimer = setTimeout(() => {
          deps.log('pty did not exit after kill', { ch, pid: proc.pid, waitedMs: killGraceMs });
        }, killGraceMs);
        killTimer.unref?.();
      },
    };

    const dataListener = proc.onData((data) => {
      // After close() the server has already dropped its side of the channel: whatever tmux
      // still emits on the way out ("[lost tty]", resets) must not be forwarded.
      if (entry.closed) return;
      try {
        socket.sendStream(ch, Buffer.from(data, 'utf8'));
      } catch (err) {
        deps.log('pty stream send failed', { ch, error: err instanceof Error ? err.message : String(err) });
      }
    });
    const exitListener = proc.onExit(({ exitCode }) => {
      if (exited) return;
      exited = true;
      if (killTimer) clearTimeout(killTimer);
      stopData();
      exitListener.dispose();
      // A later open() may have taken this channel number again (close() already dropped this
      // entry); only the live entry owns the slot. `closed` is deduped by sendClosed either way.
      if (channels.get(ch) === entry) channels.delete(ch);
      const code = exitCode ?? null;
      deps.log('pty exited', { ch, code });
      entry.sendClosed(code);
    });

    return entry;
  }

  return {
    async open(ch, params: PtyOpenParams, socket: AgentSocket): Promise<void> {
      if (channels.has(ch)) {
        socket.sendControl({ type: 'open_error', ch, error: { code: 'invalid', message: 'channel in use' } });
        return;
      }

      // Reserve the slot before the first await, so a concurrent open of the same channel is
      // rejected above and close()/closeAll() can cancel this one while it is still in flight.
      let closedSent = false;
      const sendClosed = (code: number | null) => {
        if (closedSent) return;
        closedSent = true;
        try {
          socket.sendControl({ type: 'closed', ch, code });
        } catch (err) {
          deps.log('pty closed send failed', { ch, error: err instanceof Error ? err.message : String(err) });
        }
      };
      const reservation: OpeningChannel = { state: 'opening', sendClosed };
      channels.set(ch, reservation);
      const cancelled = () => channels.get(ch) !== reservation;

      // Everything that can throw before the PTY exists — size clamping, cwd resolution, env
      // building (`agentEnv()` can throw if `REMOTE_PATH_PREFIX` is ever malformed), resolving
      // the lazy `spawn` import, and the spawn call itself — stays inside this one try so no
      // exception can ever escape `open()` unreported.
      let proc: PtyLike | undefined;
      let cols: number;
      let rows: number;
      try {
        ({ cols, rows } = clampSize(params));
        const cwd = resolveCwd(params.cwd);
        const env = {
          ...ptyEnv(agentEnv(), process.env.SHELL ?? '/bin/sh'),
          TERMHUB_TAB_ID: params.session,
          TERMHUB_SESSION: params.session,
        };
        const spawn = await resolveSpawn();
        if (cancelled()) {
          deps.log('pty open cancelled before spawn', { ch, session: params.session });
          return;
        }
        const spawnTmux = () => spawn(tmux, ['-u', 'new-session', '-A', '-s', params.session, '-c', cwd], { name: 'xterm-256color', cols, rows, cwd, env });
        try {
          proc = spawnTmux();
        } catch (err) {
          // The startup repair is not enough when node-pty is reinstalled under a running agent
          // (`npm i -g` without a restart brings a helper without its exec bit): repair and retry once.
          if (!isSpawnHelperFailure(err)) throw err;
          const helper = repairSpawnHelper();
          if (!helper.repaired) throw err;
          deps.log('spawn-helper exec bit repaired on open', { path: helper.path });
          proc = spawnTmux();
        }
      } catch (err) {
        // The wire message stays generic; the local log keeps the real reason (no PTY bytes here).
        deps.log('pty open failed', { ch, session: params.session, tmux, cwd: params.cwd, error: err instanceof Error ? err.message : String(err) });
        // A cancelled opening was already answered (close() acked it) or has no session left.
        if (cancelled()) return;
        channels.delete(ch);
        socket.sendControl({
          type: 'open_error',
          ch,
          error: isEnoent(err) ? { code: 'no_tmux', message: 'tmux not found' } : { code: 'internal', message: 'failed to start pty' },
        });
        return;
      }

      const entry = attach(ch, proc, sendClosed, socket);
      if (cancelled()) {
        // close()/closeAll() landed while spawn was handing the PTY back: nobody owns it now.
        deps.log('pty open cancelled after spawn', { ch, session: params.session, pid: proc.pid });
        entry.terminate();
        return;
      }
      channels.set(ch, entry);
      deps.log('pty opened', { ch, session: params.session, cols, rows });

      try {
        socket.sendControl({ type: 'opened', ch });
      } catch (err) {
        deps.log('pty opened send failed', { ch, error: err instanceof Error ? err.message : String(err) });
      }
    },

    write(ch, data): void {
      const entry = openEntry(ch);
      if (!entry) return;
      entry.proc.write(data.toString('utf8'));
    },

    resize(ch, cols, rows): void {
      const entry = openEntry(ch);
      if (!entry) return;
      const size = clampSize({ cols, rows });
      try {
        entry.proc.resize(size.cols, size.rows);
      } catch {
        /* pty already exited */
      }
    },

    close(ch): void {
      const entry = channels.get(ch);
      if (!entry) return;
      // Drop the slot before the kill, so output/exit the kill triggers (sync or async) is
      // treated as the tail of this close, not as live traffic. For an opening, dropping the
      // slot is the cancel: open() sees it and never spawns or announces the PTY.
      channels.delete(ch);
      if (entry.state === 'open') entry.terminate();
      // Always ack: the server keeps the channel number reserved until it sees `closed`.
      // node-pty may report the exit later (or never, if the kill fails) — the ack must not
      // depend on it; sendClosed dedupes so the later onExit doesn't send a second one.
      entry.sendClosed(null);
    },

    closeAll(): void {
      // Session is over (socket gone): no acks to send, just stop forwarding, cancel openings
      // and kill.
      for (const [ch, entry] of channels) {
        channels.delete(ch);
        if (entry.state === 'open') entry.terminate();
      }
    },
  };
}
