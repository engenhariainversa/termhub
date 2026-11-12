import type { AgentMessage, RunOpenParams } from '@termhub/agent-protocol';
import { HEADER_BYTES, MAX_FRAME } from '@termhub/agent-protocol';
import { buildCodexExecArgs, buildHeadlessArgs, classifyHeadlessFailure, EMPTY_MCP_CONFIG, resolveConfigDir } from '@termhub/claude-cli';
import { buildGuardSettings, GUARD_SCRIPT, GUARD_SCRIPT_REL } from '@termhub/machine-ops';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentSocket } from '../client.js';
import type { RunManager } from '../dispatch.js';
import { agentEnv } from '../exec.js';

/** How long a killed run gets to exit on SIGTERM before it is taken out with SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** How long a run waits for the prompt, which the server sends right after `opened`. */
const PROMPT_TIMEOUT_MS = 30_000;
/** Largest line a frame can carry (the newline this manager appends counts): above it the server's
 *  `maxPayload` would close the machine's whole socket, every terminal with it. */
const MAX_LINE_BYTES = MAX_FRAME - HEADER_BYTES - 1;
/** How much of stderr is kept to classify the failure by — never forwarded, never logged. */
const STDERR_TAIL_BYTES = 4_000;

type ClosedReason = NonNullable<Extract<AgentMessage, { type: 'closed' }>['reason']>;

export interface RunManagerDeps {
  log: (msg: string, meta?: object) => void;
  /** Base environment; defaults to the agent's PATH-widened env (`agentEnv`). */
  env?: NodeJS.ProcessEnv;
  /** Where the per-run private directory is created; defaults to the OS temp dir. */
  tmpDir?: string;
  promptTimeoutMs?: number;
}

interface Run {
  child: ChildProcess;
  promptSent: boolean;
  promptArrived(): void;
  kill(hard?: boolean): void;
  settle(code: number | null, reason?: ClosedReason, notify?: boolean): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Brings the guard script (`~/.termhub/bin/termhub-guard`) up to what this agent carries, the way the
 *  hooks heal does on reconnect: a guard hook whose script is missing exits 127, which Claude Code
 *  reads as a non-blocking error, and the run would go unguarded. */
function ensureGuardScript(home: string): void {
  const file = join(home, GUARD_SCRIPT_REL);
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    /* not there yet */
  }
  if (current === GUARD_SCRIPT) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.termhub-new`;
  writeFileSync(tmp, GUARD_SCRIPT, { encoding: 'utf8', mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, file);
}

/**
 * Headless runs of the personal runs API (TER-1176), one per `run` channel. The server sends a
 * structured spec and the agent builds the argv itself (`buildHeadlessArgs`, `buildCodexExecArgs`):
 * nothing the server sends becomes an argument as is. The prompt is the channel's first data frame
 * and goes to stdin; stdout comes back a line per frame, untouched (the server adapts it); stderr is
 * kept in memory only, to name the outcome in `closed.reason`.
 *
 * Same shape as the Claude chat manager (`../claude/run.ts`), which stays as it is.
 */
export function createRunManager(deps: RunManagerDeps): RunManager {
  const runs = new Map<number, Run>();

  return {
    async open(ch: number, params: RunOpenParams, socket: AgentSocket): Promise<void> {
      if (runs.has(ch)) {
        socket.sendControl({ type: 'open_error', ch, error: { code: 'invalid', message: 'channel in use' } });
        return;
      }

      const env = { ...(deps.env ?? agentEnv()) };
      const home = env.HOME || homedir();
      const configVar = params.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
      // null is the machine's default login, not whatever the agent process happens to point at.
      if (params.config_dir === null) delete env[configVar];
      else env[configVar] = resolveConfigDir(params.config_dir, home);

      // The run's own files (the empty MCP config, the guard settings) live in a 0700 directory that
      // goes away on every way out of the run.
      let runDir: string | undefined;
      let cli: string;
      let args: string[];
      try {
        if (params.provider === 'claude') {
          runDir = mkdtempSync(join(deps.tmpDir ?? tmpdir(), 'termhub-run-'));
          const mcpConfigPath = join(runDir, 'mcp.json');
          writeFileSync(mcpConfigPath, EMPTY_MCP_CONFIG, { mode: 0o600 });
          let settingsPath: string | null = null;
          if (params.guard) {
            ensureGuardScript(home);
            settingsPath = join(runDir, 'guard.json');
            writeFileSync(settingsPath, buildGuardSettings(params.guard.branch, params.guard.worktree), { mode: 0o600 });
          }
          cli = 'claude';
          args = buildHeadlessArgs({ tools: params.tools ?? ['Read', 'Grep', 'Glob'], model: params.model, settingsPath, mcpConfigPath });
        } else {
          cli = 'codex';
          args = buildCodexExecArgs({ cwd: params.cwd, sandbox: params.sandbox ?? 'read-only', model: params.model });
        }
      } catch (err) {
        deps.log('headless run could not be prepared', { ch, provider: params.provider, error: message(err) });
        if (runDir) rmSync(runDir, { recursive: true, force: true });
        socket.sendControl({ type: 'open_error', ch, error: { code: 'internal', message: 'failed to prepare the run' } });
        return;
      }
      const dir = runDir;
      const removeDir = () => {
        if (!dir) return;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          deps.log('headless run dir could not be removed', { ch, error: message(err) });
        }
      };

      // Acknowledged before the CLI is known to exist, so a missing CLI ends as `closed cli_missing`.
      socket.sendControl({ type: 'opened', ch });
      deps.log('headless run starting', { ch, provider: params.provider, model: params.model, tools: params.tools?.length ?? null, sandbox: params.sandbox ?? null, guard: params.guard !== null });

      let child: ChildProcess;
      try {
        // Its own process group, so a kill takes whatever the CLI started (a shell, a subprocess).
        child = spawn(cli, args, { cwd: params.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      } catch (err) {
        deps.log('headless run could not be started', { ch, cli, error: message(err) });
        removeDir();
        socket.sendControl({ type: 'closed', ch, code: null, reason: 'run_failed' });
        return;
      }

      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let stderr = '';
      let stderrBytes = 0;
      let buffer = '';
      let overlong = false;
      let droppedLines = 0;
      let lines = 0;

      function signalRun(signal: NodeJS.Signals): void {
        try {
          if (child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* already dead */
          }
        }
      }

      function killRun(hard = false): void {
        if (child.exitCode !== null || child.signalCode !== null) return;
        signalRun('SIGTERM');
        if (hard) {
          // The agent is stopping: no timer would be around to escalate.
          signalRun('SIGKILL');
          return;
        }
        if (escalation) return;
        escalation = setTimeout(() => signalRun('SIGKILL'), KILL_GRACE_MS);
        escalation.unref();
      }

      function settle(code: number | null, reason?: ClosedReason, notify = true): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(promptTimer);
        if (runs.get(ch) === run) runs.delete(ch);
        removeDir();
        if (!notify) return;
        try {
          socket.sendControl(reason ? { type: 'closed', ch, code, reason } : { type: 'closed', ch, code });
        } catch (err) {
          deps.log('headless closed send failed', { ch, error: message(err) });
        }
      }

      function emitLine(line: string): void {
        if (settled || !line.trim()) return;
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
          droppedLines += 1;
          deps.log('headless stdout line too large to frame, dropped', { ch, bytes: Buffer.byteLength(line, 'utf8') });
          return;
        }
        lines += 1;
        try {
          socket.sendStream(ch, Buffer.from(`${line}\n`, 'utf8'));
        } catch (err) {
          deps.log('headless stream send failed', { ch, error: message(err) });
        }
      }

      const timer = setTimeout(() => {
        deps.log('headless run timed out', { ch, timeoutMs: params.timeout_ms });
        killRun();
        settle(null, 'timeout');
      }, params.timeout_ms);
      timer.unref();

      const promptTimeoutMs = deps.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
      const promptTimer = setTimeout(() => {
        deps.log('headless run got no prompt', { ch, promptTimeoutMs });
        killRun();
        settle(null, 'run_failed');
      }, promptTimeoutMs);
      promptTimer.unref();

      const run: Run = { child, promptSent: false, promptArrived: () => clearTimeout(promptTimer), kill: killRun, settle };
      runs.set(ch, run);

      // A CLI that exits before reading stdin turns the write into EPIPE; unhandled, it would take the agent down.
      child.stdin?.on('error', () => {});

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl === -1) break;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (overlong) overlong = false;
          else emitLine(line);
        }
        if (Buffer.byteLength(buffer, 'utf8') <= MAX_LINE_BYTES) return;
        if (!overlong) {
          overlong = true;
          droppedLines += 1;
          deps.log('headless stdout line too large to frame, dropped', { ch, bytes: Buffer.byteLength(buffer, 'utf8') });
        }
        buffer = '';
      });

      // Drained so a chatty CLI never blocks on a full pipe; the tail only names the outcome. It can
      // carry the prompt or file contents back, so it never leaves this machine and never reaches a log.
      child.stderr?.on('data', (data: Buffer) => {
        stderrBytes += data.length;
        stderr = (stderr + data.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        const missing = err.code === 'ENOENT';
        deps.log(missing ? `${cli} cli not found on this machine` : 'headless run failed to start', { ch, cli, error: err.message });
        killRun();
        settle(null, missing ? 'cli_missing' : 'run_failed');
      });

      child.on('close', (code: number | null) => {
        if (escalation) clearTimeout(escalation);
        if (!overlong) emitLine(buffer);
        buffer = '';
        deps.log('headless run ended', { ch, provider: params.provider, code, lines, stderrBytes, droppedLines });
        if (code === 0) settle(0);
        else settle(code, classifyHeadlessFailure(stderr));
      });
    },

    write(ch: number, data: Buffer): boolean {
      const run = runs.get(ch);
      if (!run) return false;
      if (run.promptSent) {
        // The size, never the content.
        deps.log('extra data on a run channel ignored', { ch, bytes: data.length });
        return true;
      }
      run.promptSent = true;
      run.promptArrived();
      // stdin only: argv is visible to every process on the machine. Both CLIs read until EOF.
      run.child.stdin?.end(data);
      return true;
    },

    close(ch: number): void {
      const run = runs.get(ch);
      if (!run) return;
      run.kill();
      run.settle(null, 'killed');
    },

    closeAll(): void {
      for (const run of [...runs.values()]) {
        run.kill(true);
        run.settle(null, 'killed', false);
      }
    },
  };
}
