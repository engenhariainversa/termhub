import type { AgentMessage, ClaudeOpenParams } from '@termhub/agent-protocol';
import { HEADER_BYTES, MAX_FRAME, STREAM_END_INPUT_LINE } from '@termhub/agent-protocol';
import { buildClaudeArgs, classifyFailure, mcpConfig } from '@termhub/claude-cli';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSocket } from '../client.js';
import type { ClaudeManager } from '../dispatch.js';
import { agentEnv } from '../exec.js';

/** Same deadline the container runs with (`apps/concierge/src/run.ts`): a run that overstays it is
 *  killed, so a CLI that hangs cannot keep running on someone's laptop for the rest of the day. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** A streamed run hosts the chat's background subagents, which can take far longer than one answer. */
const STREAM_TIMEOUT_MS = 60 * 60 * 1000;
/** Input not yet framed into a line: a server that never sends a newline cannot grow this for ever. */
const MAX_PENDING_INPUT_BYTES = 256 * 1024;
/** How long a killed run gets to exit on SIGTERM before it is taken out with SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** How long a run waits for the prompt the server sends right after `opened`. Seconds, because it
 *  travels in the frame that follows the open: a channel nobody writes to would otherwise hold the
 *  token-bearing config on disk (and a CLI on stdin) for the whole run deadline. */
const PROMPT_TIMEOUT_MS = 30_000;
/** Largest line a frame can carry: above this the server's `maxPayload` closes the whole socket
 *  (1009), which would drop every terminal on this machine, not just the chat. The newline this
 *  manager appends counts towards it. */
const MAX_LINE_BYTES = MAX_FRAME - HEADER_BYTES - 1;
/** How much of stderr is kept to classify the failure by — never forwarded, never logged. */
const STDERR_TAIL_BYTES = 4_000;
/** The CLI, resolved from the run's PATH like every other tool the agent runs — and what the log
 *  says is missing when this machine does not have it. */
const CLI = 'claude';

/** The protocol's closed set of end-of-run reasons (task-2 ruling R1), read off the message type so
 *  this file cannot drift from it. It is a superset of `ClaudeFailureReason`, which is what lets
 *  `classifyFailure`'s label travel to the server unchanged instead of being narrowed here. */
type ClosedReason = NonNullable<Extract<AgentMessage, { type: 'closed' }>['reason']>;

export interface ClaudeManagerDeps {
  log: (msg: string, meta?: object) => void;
  /** Base environment for the run; defaults to the agent's PATH-widened env (see `agentEnv`),
   *  which is how a service-managed agent finds a CLI installed under ~/.local/bin or Homebrew. */
  env?: NodeJS.ProcessEnv;
  /** Where the per-run private directory is created; defaults to the OS temp dir. */
  tmpDir?: string;
  timeoutMs?: number;
  promptTimeoutMs?: number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Run {
  child: ChildProcess;
  /** The prompt already went in — and closed stdin with it, so later frames have nowhere to go. */
  promptSent: boolean;
  /** Kills the CLI and everything it started, escalating to SIGKILL after the grace period —
   *  `hard` sends SIGKILL right away, for a shutdown that will not be around to escalate. */
  kill(hard?: boolean): void;
  /** Cancels the wait for the prompt; called once it arrives. */
  promptArrived(): void;
  /** Streamed input (`stream_input`): stdin stays open and takes one line per message. */
  stream: boolean;
  /** Bytes after the last newline of a streamed run's input. */
  inputTail: string;
  /** The end-of-input line arrived: stdin is closed, and anything after it is dropped. */
  inputEnded: boolean;
  /** Sends `closed` (once) and removes the run's private directory. `notify: false` for a session
   *  that is already gone, where there is nobody left to ack to. */
  settle(code: number | null, reason?: ClosedReason, notify?: boolean): void;
}

/**
 * Runs headless Claude sessions for the server, one per channel: spawns the CLI, feeds it the
 * prompt on stdin, streams its stdout back a line per frame, and ends the channel with `closed`.
 *
 * Same shape as the PTY manager (`src/pty.ts`), so the dispatcher routes by kind and learns
 * nothing else: nothing here knows what a chat is, only how to run a CLI and stream it.
 */
export function createClaudeManager(deps: ClaudeManagerDeps): ClaudeManager {
  const runs = new Map<number, Run>();

  return {
    // Synchronous from end to end (the promise is for symmetry with the PTY manager), so no
    // `close` for this channel can interleave before the run is in `runs` and killable.
    async open(ch: number, params: ClaudeOpenParams, socket: AgentSocket): Promise<void> {
      if (runs.has(ch)) {
        socket.sendControl({ type: 'open_error', ch, error: { code: 'invalid', message: 'channel in use' } });
        return;
      }

      // The MCP config holds a live token of this user's, so it goes in a directory only they can
      // enter (mkdtemp is 0700) in a file only they can read, and it is removed on every way out of
      // this run: a normal exit, a kill, a dropped session, a spawn that never started.
      let dir: string | undefined;
      let mcpConfigPath: string;
      try {
        dir = mkdtempSync(join(deps.tmpDir ?? tmpdir(), 'termhub-claude-'));
        mcpConfigPath = join(dir, 'termhub-mcp.json');
        writeFileSync(mcpConfigPath, mcpConfig(params.mcp_url, params.token), { mode: 0o600 });
      } catch (err) {
        deps.log('claude run could not prepare its mcp config', { ch, error: message(err) });
        if (dir) rmSync(dir, { recursive: true, force: true });
        socket.sendControl({ type: 'open_error', ch, error: { code: 'internal', message: 'failed to prepare the claude run' } });
        return;
      }
      const runDir = dir;

      // The channel is acknowledged before the CLI is known to exist. A machine without `claude`
      // is the likeliest first failure of this feature and it has an end-of-run reason of its own
      // (`cli_missing`) that only `closed` can carry — answering `open_error` instead would settle
      // the open as a generic rejection and throw that reason away.
      socket.sendControl({ type: 'opened', ch });
      const stream = params.stream_input === true;
      deps.log('claude run starting', { ch, resume: params.resume, model: params.model ?? null, stream });

      const env = { ...(deps.env ?? agentEnv()) };
      // `null` means "the account this machine uses by default", which is not the account the agent
      // process itself happens to be pointed at: the inherited value must not stand in for it.
      if (params.config_dir === null) delete env.CLAUDE_CONFIG_DIR;
      else env.CLAUDE_CONFIG_DIR = params.config_dir;

      const args = buildClaudeArgs({
        session_id: params.session_id,
        resume: params.resume,
        mcp_config_path: mcpConfigPath,
        model: params.model ?? null,
        append_system_prompt: params.append_system_prompt ?? null,
        stream_input: stream,
      });

      let child: ChildProcess;
      try {
        // `detached` makes the CLI its own process group leader so a kill can take whatever it
        // started with it (an MCP server, a helper): a SIGTERM to the leader alone would leave
        // those running on the user's machine, which is the failure this design must not introduce.
        child = spawn(CLI, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      } catch (err) {
        deps.log('claude run could not be started', { ch, cli: CLI, error: message(err) });
        rmSync(runDir, { recursive: true, force: true });
        socket.sendControl({ type: 'closed', ch, code: null, reason: 'run_failed' });
        return;
      }

      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let stderr = '';
      let stderrBytes = 0;
      let buffer = '';
      /** Inside a line too long to frame: dropped as it arrives rather than buffered whole. */
      let overlong = false;
      let droppedLines = 0;

      function signalRun(signal: NodeJS.Signals): void {
        try {
          // A negative pid signals the whole process group `detached` put this child at the head of.
          if (child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The group is gone already (ESRCH), or the platform refused the group kill: fall back to
          // the child alone rather than leaving it alive.
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
          // The agent itself is stopping (a shutdown, and on every machine an auto-update is the
          // most frequent one): `process.exit` follows this call, so no escalation timer would ever
          // fire and a CLI that traps SIGTERM — or just takes a moment — would be left orphaned on
          // the person's laptop. The group gets SIGKILL now, while there is still a process here.
          signalRun('SIGKILL');
          return;
        }
        if (escalation) return;
        // A CLI that ignores SIGTERM must not survive the channel that asked for it to stop.
        escalation = setTimeout(() => signalRun('SIGKILL'), KILL_GRACE_MS);
        escalation.unref();
      }

      function settle(code: number | null, reason?: ClosedReason, notify = true): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(promptTimer);
        if (runs.get(ch) === run) runs.delete(ch);
        try {
          rmSync(runDir, { recursive: true, force: true }); // the 0600 config holds a live token
        } catch (err) {
          // Settling runs from a child-process event: an unremovable directory must be a log line,
          // never an exception that reaches the event loop and takes the agent down.
          deps.log('claude run dir could not be removed', { ch, error: message(err) });
        }
        if (!notify) return;
        try {
          socket.sendControl(reason ? { type: 'closed', ch, code, reason } : { type: 'closed', ch, code });
        } catch (err) {
          deps.log('claude closed send failed', { ch, error: message(err) });
        }
      }

      /** One stdout line: dropped when blank (stream-json never emits one) or too big to frame. */
      function emitLine(line: string): void {
        if (!line.trim()) return;
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
          droppedLines += 1;
          // The size, never the line: a frame this big would close the machine's whole socket.
          deps.log('claude stdout line too large to frame, dropped', { ch, bytes: Buffer.byteLength(line, 'utf8') });
          return;
        }
        sendLine(line);
      }

      function sendLine(line: string): void {
        // After the channel ended (a kill, a dropped session) the server has already let go of it:
        // whatever the CLI still writes on its way out must not be forwarded.
        if (settled) return;
        try {
          // The newline travels with the line: the server reassembles the stream by newline, as the
          // container's reader does, so a frame must never silently glue two lines together.
          socket.sendStream(ch, Buffer.from(`${line}\n`, 'utf8'));
        } catch (err) {
          deps.log('claude stream send failed', { ch, error: message(err) });
        }
      }

      const timeoutMs = deps.timeoutMs ?? (stream ? STREAM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
      const timer = setTimeout(() => {
        deps.log('claude run timed out', { ch, timeoutMs });
        killRun();
      }, timeoutMs);
      timer.unref();

      const promptTimer = setTimeout(() => {
        deps.log('claude run got no prompt', { ch, promptTimeoutMs: deps.promptTimeoutMs ?? PROMPT_TIMEOUT_MS });
        killRun();
        settle(null, 'run_failed');
      }, deps.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
      promptTimer.unref();

      const run: Run = {
        child,
        promptSent: false,
        kill: killRun,
        promptArrived: () => clearTimeout(promptTimer),
        settle,
        stream,
        inputTail: '',
        inputEnded: false,
      };
      runs.set(ch, run);

      // A CLI that exits before reading the prompt (a rejected `--resume` fails at startup) turns
      // the stdin write into EPIPE; unhandled, that `error` event would take the whole agent down.
      child.stdin?.on('error', () => {});

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl === -1) break;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          // The tail of a line whose head was already dropped for its size.
          if (overlong) overlong = false;
          else emitLine(line);
        }
        if (Buffer.byteLength(buffer, 'utf8') <= MAX_LINE_BYTES) return;
        // Neither framed nor held in memory: a CLI writing an endless line must not grow this buffer
        // until the agent dies with it.
        if (!overlong) {
          overlong = true;
          droppedLines += 1;
          deps.log('claude stdout line too large to frame, dropped', { ch, bytes: Buffer.byteLength(buffer, 'utf8') });
        }
        buffer = '';
      });

      // stderr is drained (a chatty CLI would otherwise block on a full pipe) and a tail of it is
      // kept for one purpose: `classifyFailure` reads it to name the outcome. The text itself never
      // leaves this machine and never reaches a log — it can carry the prompt back and terminal
      // content with it (spec §7.1) — but a label is not text, and without it a local history that
      // was pruned or rotated would make every message in the conversation fail for ever instead of
      // being retried once on a fresh session.
      child.stderr?.on('data', (data: Buffer) => {
        stderrBytes += data.length;
        stderr = (stderr + data.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        const missing = err.code === 'ENOENT';
        // Named, not generic: "this machine has no `claude`" is something the person can act on,
        // where "run failed" would send them hunting.
        deps.log(missing ? `claude cli not found on this machine (${CLI})` : 'claude run failed to start', { ch, cli: CLI, error: err.message });
        killRun();
        settle(null, missing ? 'cli_missing' : 'run_failed');
      });

      // `close`, not `exit`: by then every stdout chunk has been delivered, so nothing the CLI
      // wrote is lost to the channel ending a beat too early.
      child.on('close', (code: number | null) => {
        if (escalation) clearTimeout(escalation);
        if (!overlong) emitLine(buffer);
        buffer = '';
        deps.log('claude run ended', { ch, code, stderrBytes, droppedLines });
        // A run we killed ourselves has already settled (`killed`, or `cli_missing` on a spawn that
        // never happened); this decides only the outcome of a run that ended on its own terms.
        if (code === 0) settle(0);
        // The label only, and whichever one the classifier reached — never narrowed to two: the
        // server has a sentence for each, and collapsing `cli_rejected` into `run_failed` here would
        // leave the person retrying for ever instead of reading "update claude on that machine".
        // `missing_session` is the one the server acts on rather than renders (it retries once on a
        // fresh session), and it is the difference between a pruned local history costing one
        // message and it ending the conversation for good.
        else settle(code, classifyFailure(stderr));
      });
    },

    write(ch: number, data: Buffer): boolean {
      const run = runs.get(ch);
      if (!run) return false; // not one of ours: the caller routes the frame to the pty manager
      if (!run.stream) {
        if (run.promptSent) {
          // The size, never the content: this is the prompt.
          deps.log('extra data on a claude channel ignored', { ch, bytes: data.length });
          return true;
        }
        run.promptSent = true;
        run.promptArrived();
        // The prompt goes in on stdin and nowhere else: argv is visible to every process on this
        // machine, and a prompt beginning with `-` would be read as a flag there. It arrives as one
        // frame and is the CLI's whole input, so stdin closes with it — `claude -p` waits for EOF.
        run.child.stdin?.end(data);
        return true;
      }
      // Streamed input: every complete line is one message for the CLI, written as it arrives; the
      // end-of-input line closes stdin. The CLI then finishes its turns and background subagents.
      run.promptSent = true;
      run.promptArrived();
      if (run.inputEnded) {
        deps.log('claude input after its end ignored', { ch, bytes: data.length });
        return true;
      }
      run.inputTail += data.toString('utf8');
      for (;;) {
        const nl = run.inputTail.indexOf('\n');
        if (nl === -1) break;
        const line = run.inputTail.slice(0, nl);
        run.inputTail = run.inputTail.slice(nl + 1);
        if (line === STREAM_END_INPUT_LINE) {
          run.inputEnded = true;
          if (run.inputTail.length > 0) deps.log('claude input after its end ignored', { ch, bytes: Buffer.byteLength(run.inputTail, 'utf8') });
          run.inputTail = '';
          run.child.stdin?.end();
          return true;
        }
        if (line.trim()) run.child.stdin?.write(`${line}\n`);
      }
      if (Buffer.byteLength(run.inputTail, 'utf8') > MAX_PENDING_INPUT_BYTES) {
        deps.log('claude input line too large, dropped', { ch, bytes: Buffer.byteLength(run.inputTail, 'utf8') });
        run.inputTail = '';
      }
      return true;
    },

    close(ch: number): void {
      const run = runs.get(ch);
      if (!run) return;
      run.kill();
      // Always ack, like the pty manager: the server keeps the channel number reserved until it
      // sees `closed`, and the process exit may come later — or never, if the kill fails.
      run.settle(null, 'killed');
    },

    closeAll(): void {
      // The session is over (the socket is gone, or the agent itself is stopping): nobody is left to
      // ack to, and nothing may be left running either — this is the one kill nobody will be around
      // to escalate, so it goes all the way now.
      for (const run of [...runs.values()]) {
        run.kill(true);
        run.settle(null, 'killed', false);
      }
    },
  };
}
