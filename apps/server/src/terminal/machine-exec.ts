import { execFile, spawn } from 'node:child_process';
import { config } from '../config.js';
import type { Machine } from '../db/repositories/types.js';
import { DETECT_SCRIPT, REMOTE_PATH_PREFIX, assertSessionName, parseDetect } from '@termhub/machine-ops';
import { agentRpc, toHttpError } from '../agent/errors.js';
import { AgentOfflineError, agents } from '../agent/registry.js';

export { DETECT_TOOLS, REMOTE_PATH_PREFIX, assertSessionName, shellQuote } from '@termhub/machine-ops';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function sshBaseArgs(machine: Machine, connectTimeout = 5): string[] {
  if (machine.type === 'agent') throw new Error('Máquina do tipo agente não executa shell');
  if (machine.type !== 'ssh' || !machine.host) throw new Error('Máquina não é SSH');
  const target = machine.ssh_user ? `${machine.ssh_user}@${machine.host}` : machine.host;
  return [
    '-p',
    String(machine.ssh_port || 22),
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${connectTimeout}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    target,
  ];
}

/**
 * Executa um comando (sem PTY) na máquina. Para "ssh", o comando é uma string
 * interpretada pelo shell remoto; para "local", executa tmux diretamente com args.
 */
export function runOnMachine(
  machine: Machine,
  local: { file: string; args: string[] },
  remoteCommand: string,
  timeoutMs = 8000,
): Promise<ExecResult> {
  if (machine.type === 'agent') throw new Error('Máquina do tipo agente não executa shell');
  const [file, args] =
    machine.type === 'local' ? [local.file, local.args] : ['ssh', [...sshBaseArgs(machine), '--', remoteCommand]];

  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, env: process.env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: !!e?.killed || e?.signal === 'SIGTERM',
      });
    });
  });
}

/**
 * Como runOnMachine, mas envia `input` pelo stdin do processo (local ou do ssh).
 * Usado para copiar arquivos para a máquina sem depender de scp.
 */
export function runOnMachineWithInput(
  machine: Machine,
  local: { file: string; args: string[] },
  remoteCommand: string,
  input: Buffer,
  timeoutMs = 30000,
): Promise<ExecResult> {
  if (machine.type === 'agent') throw new Error('Máquina do tipo agente não executa shell');
  const [file, args] =
    machine.type === 'local' ? [local.file, local.args] : ['ssh', [...sshBaseArgs(machine, 10), '--', remoteCommand]];

  return new Promise((resolve) => {
    const child = spawn(file, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    };
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {
      /* EPIPE se o remoto fechar antes: 'close' reporta o código */
    });
    child.stdin.end(input);
  });
}

const tmux = () => config.terminal.tmuxPath;

export interface MachineStatus {
  online: boolean;
  tmux: boolean;
  os: string | null;
  /** ferramentas encontradas no PATH de login: claude, gh, git, node, xcodebuild, ... */
  capabilities: string[];
}

/** Testa conectividade, tmux, SO e ferramentas disponíveis na máquina. */
export async function machineStatus(machine: Machine): Promise<MachineStatus> {
  // Agent: status comes from the registry's own connection state, never a shell exec.
  if (machine.type === 'agent') {
    // A colour that just started has not met its agents yet (a deploy): give the one on its way the time to attach.
    await agents.awaitHandover(machine);
    const info = agents.info(machine.id);
    return { online: agents.isOnline(machine.id), tmux: info?.tools.includes('tmux') ?? false, os: machine.os, capabilities: machine.capabilities };
  }
  // Local: roda via shell de login para ter o PATH do usuário (claude em ~/.local/bin, brew...)
  const r = await runOnMachine(
    machine,
    { file: '/bin/sh', args: ['-lc', DETECT_SCRIPT] },
    // Remoto: o ssh já usa shell de login; garante ~/.local/bin e brew no PATH
    `${REMOTE_PATH_PREFIX}${DETECT_SCRIPT}`,
    8000,
  );
  const online = machine.type === 'local' || r.code === 0;
  const det = online ? parseDetect(r.stdout) : { os: null, capabilities: [] };
  return { online, tmux: det.capabilities.includes('tmux'), ...det };
}

/** The hidden tmux sessions an AI CLI login runs in (TER-1047): never a tab's, so never listed as one. */
export const AI_LOGIN_SESSION_PREFIX = 'termhub-login-';

/** A machine's session names, without the hidden login sessions. */
function sessionSet(names: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const name of names) if (name && !name.startsWith(AI_LOGIN_SESSION_PREFIX)) set.add(name);
  return set;
}

function parseSessions(stdout: string): Set<string> {
  return sessionSet(stdout.split('\n').map((line) => line.trim()));
}

/** Lista as sessões tmux ativas na máquina (vazio se o servidor tmux não está rodando). */
export async function listTmuxSessions(machine: Machine): Promise<Set<string>> {
  if (machine.type === 'agent') {
    try {
      const { sessions } = await agents.rpc(machine.id, 'tmux.list', {});
      return sessionSet(sessions);
    } catch (err) {
      // Same behaviour as the shell path returning a non-zero exit: no sessions, no error.
      if (err instanceof AgentOfflineError) return new Set();
      throw toHttpError(err);
    }
  }
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['list-sessions', '-F', '#{session_name}'] },
    `${REMOTE_PATH_PREFIX}tmux list-sessions -F '#{session_name}' 2>/dev/null || true`,
  );
  if (r.code !== 0) return new Set();
  return parseSessions(r.stdout);
}

export interface TmuxProbe {
  /** false = the machine could not be asked at all; `sessions` is then empty and means nothing */
  reachable: boolean;
  sessions: Set<string>;
  /** short, metadata-only reason for `reachable: false` — safe to log, never command output */
  cause?: string;
}

/** tmux answering "there is no server" — the machine replied, it simply has no sessions. */
const NO_TMUX_SERVER = /no server running|error connecting to|no sessions/i;

/**
 * Like `listTmuxSessions`, but tells "could not ask the machine" from "asked, nothing is running".
 * `listTmuxSessions` cannot: an offline agent, a timed-out ssh and a machine with no sessions all
 * answer the same empty set, so a caller that draws state from it reads every tab as dead. The
 * office snapshot uses this instead; `listTmuxSessions` keeps its behaviour for its own callers.
 */
export async function probeTmuxSessions(machine: Machine): Promise<TmuxProbe> {
  const unreachable = (cause: string): TmuxProbe => ({ reachable: false, sessions: new Set(), cause });
  if (machine.type === 'agent') {
    // the registry's own connection state, as control/inventory.ts checks it; an agent on its way from the
    // other colour (a deploy) is waited for, or this answer would sit in the memo as "unreachable" for a minute
    if (!(await agents.awaitHandover(machine))) return unreachable('agent offline');
    try {
      const { sessions } = await agents.rpc(machine.id, 'tmux.list', {});
      return { reachable: true, sessions: sessionSet(sessions) };
    } catch (err) {
      return unreachable(err instanceof AgentOfflineError ? 'agent offline' : 'agent rpc failed');
    }
  }
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['list-sessions', '-F', '#{session_name}'] },
    `${REMOTE_PATH_PREFIX}tmux list-sessions -F '#{session_name}' 2>/dev/null || true`,
  );
  if (r.code === 0) return { reachable: true, sessions: parseSessions(r.stdout) };
  if (r.timedOut) return unreachable('timeout');
  // The remote command swallows tmux's own failure (`2>/dev/null || true`), so over ssh a non-zero
  // exit is ssh failing. Locally tmux runs directly, and "no server running" is its normal answer
  // when nothing is up — that is a reachable machine with zero sessions, not a failure.
  if (machine.type === 'local' && NO_TMUX_SERVER.test(r.stderr)) return { reachable: true, sessions: new Set() };
  return unreachable(`exit ${r.code ?? 'null'}`);
}

/** How long a probe answer is reused. An unreachable machine is asked again less often: over ssh it costs a timeout. */
export const PROBE_TTL_MS = { reachable: 15_000, unreachable: 60_000 } as const;

/**
 * How long even a `fresh` call is served from the memo. One tab opened on a machine makes EVERY
 * open browser tab watching it ask for a fresh read, and they arrive one after the other — without
 * this grace each of them starts its own ssh probe of the same machine for the same answer.
 */
export const FRESH_GRACE_MS = 2_000;

const probeMemo = new Map<string, { at: number; probe: TmuxProbe }>();
const probesInFlight = new Map<string, Promise<TmuxProbe>>();

/**
 * `probeTmuxSessions` behind a per-machine memo: the office city asks every machine every minute
 * from every open browser tab, and they can all share one round-trip. Only the probe is reused —
 * callers read projects, tabs and tasks from the database every time. `fresh` skips the memo (a
 * tab was just opened and must not read as "no session yet") and refreshes it, but not an answer
 * that is only seconds old — see FRESH_GRACE_MS. Concurrent callers share one in-flight probe.
 */
export function probeTmuxSessionsCached(machine: Machine, opts: { fresh?: boolean; now?: () => number } = {}): Promise<TmuxProbe> {
  const now = opts.now ?? Date.now;
  const hit = probeMemo.get(machine.id);
  const ttl = opts.fresh ? FRESH_GRACE_MS : hit?.probe.reachable ? PROBE_TTL_MS.reachable : PROBE_TTL_MS.unreachable;
  if (hit && now() - hit.at < ttl) return Promise.resolve(hit.probe);
  const running = probesInFlight.get(machine.id);
  if (running) return running;
  const started = probeTmuxSessions(machine)
    .then((probe) => {
      probeMemo.set(machine.id, { at: now(), probe });
      return probe;
    })
    .finally(() => probesInFlight.delete(machine.id));
  probesInFlight.set(machine.id, started);
  return started;
}

/**
 * The memo's current answer for a machine, without ever starting or joining a probe — a cold or
 * expired entry answers `undefined`, not a round-trip. For a caller that must not trigger an ssh
 * connection on someone else's behalf (the public city, read by anyone with the link), this is the
 * only safe way to consult the memo: `probeTmuxSessionsCached` always probes on a miss.
 */
export function cachedTmuxProbe(machine: Pick<Machine, 'id'> | string, opts: { now?: () => number } = {}): TmuxProbe | undefined {
  const now = opts.now ?? Date.now;
  // By id as well as by row: the public channel only has the machine id a monitor change carries.
  const hit = probeMemo.get(typeof machine === 'string' ? machine : machine.id);
  if (!hit) return undefined;
  const ttl = hit.probe.reachable ? PROBE_TTL_MS.reachable : PROBE_TTL_MS.unreachable;
  return now() - hit.at < ttl ? hit.probe : undefined;
}

/** Tests only. */
export function clearTmuxProbeMemo(): void {
  probeMemo.clear();
  probesInFlight.clear();
}

export async function killTmuxSession(machine: Machine, session: string): Promise<boolean> {
  assertSessionName(session);
  if (machine.type === 'agent') {
    const { killed } = await agentRpc(machine, 'tmux.kill', { session });
    return killed;
  }
  const r = await runOnMachine(
    machine,
    { file: tmux(), args: ['kill-session', '-t', `=${session}`] },
    `${REMOTE_PATH_PREFIX}tmux kill-session -t '=${session}' 2>/dev/null || true`,
  );
  return r.code === 0;
}

