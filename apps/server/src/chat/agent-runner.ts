import { CAPABILITY_CLAUDE, type ClaudeOpenParams } from '@termhub/agent-protocol';
import { ChannelLimitError, type AgentChannel, type ChannelClosedReason, type ChannelHandlers } from '../agent/connection.js';
import { agents } from '../agent/registry.js';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import type { RunnerClient, RunnerInput, RunStream } from './service.js';

/**
 * Deadline for a whole run, one minute past the agent's own 10-minute kill
 * (`apps/agent/src/claude/run.ts`), so the agent's cleaner path normally wins and this only fires
 * when the machine stops answering without the socket noticing. Without it such a run holds the
 * per-conversation lock for ever and every later message answers 409 until the server restarts.
 */
const RUN_DEADLINE_MS = 11 * 60_000;

/** One minute past the agent's own 60-minute kill of a streamed run (apps/agent/src/claude/run.ts). */
const STREAM_RUN_DEADLINE_MS = 61 * 60_000;

/** The slice of the agent registry this runner uses, so a test can drive a channel by hand instead
 *  of standing up a socket, a handshake and an agent. */
export interface ClaudeChannelHost {
  capabilities(machineId: string): string[] | null;
  openClaude(machineId: string, params: ClaudeOpenParams, handlers: ChannelHandlers): Promise<AgentChannel>;
}

/**
 * Why a run ended badly, as this runner names it. The agent's own labels travel through untouched
 * (`missing_session` above all: `ChatService` retries once on a fresh session when it sees it, and
 * that self-healing must be one path for both runners, not one each). The two added here are the
 * ones only the server can see: the machine is not there, and its agent is too old to run a chat.
 */
type RunFailureReason = ChannelClosedReason | 'host_gone' | 'agent_too_old' | 'host_busy';

/**
 * The line a failed run ends with, in the exact shape the container's own stream uses
 * (`apps/concierge/src/index.ts`): both runners speak one format, so `parseFrame` and the service
 * above it stay untouched. The reason is a label, never text from the machine — stderr can carry the
 * prompt back and never leaves the host it ran on (spec §7.1).
 */
const failureLine = (reason: RunFailureReason, code: number | null): string => JSON.stringify({ type: 'termhub_error', code, reason });

/** How a channel ended, as the handlers saw it. */
interface ChannelEnd {
  code: number | null;
  reason?: ChannelClosedReason;
}

/**
 * What to say about a channel that ended: `null` for a run that finished on its own terms, where the
 * CLI's own `result` frame has already said everything.
 *
 * `opened` is not proof the CLI ran — the agent acknowledges the channel before it knows whether
 * `claude` exists, because only `closed` can carry `cli_missing` — so this is the only place a run's
 * outcome is decided.
 */
function endOfRun(end: ChannelEnd): string | null {
  if (end.reason) return failureLine(end.reason, end.code);
  if (end.code === 0) return null;
  // Nothing said and no exit code: the channel did not end, it was lost — the connection went with
  // the run still on it (a laptop that slept, a network that dropped). That is the host, not the run,
  // and the difference is what lets the chat say the machine went away instead of blaming the answer.
  if (end.code === null) return failureLine('host_gone', null);
  return failureLine('run_failed', end.code);
}

/** What `write` and the run share: the open channel, the lines written before it opened, and
 *  whether the run is over. */
interface InputLink {
  channel: AgentChannel | null;
  pending: string[];
  ended: boolean;
}

/**
 * Runs the conversation on a machine of the user's own, through the agent already installed there:
 * opens a `claude` channel, writes the prompt, and yields the CLI's `stream-json` back a line at a
 * time — the same contract `httpRunner` has with the container, so nothing above `RunnerClient`
 * (the busy lock, the gate, the cards, the fresh-session retry, the bus) can tell the two apart.
 *
 * Which machine to use is decided elsewhere: this takes an id and drives it.
 */
export function agentRunner(machineId: string, opts: { host?: ClaudeChannelHost; deadlineMs?: number } = {}): RunnerClient {
  const host = opts.host ?? agents;
  return {
    run: (input: RunnerInput): RunStream => {
      // The CLI runs on the user's machine, so it reaches termhub over the public MCP endpoint —
      // the one exposed outside Cloudflare Access. Without it there is nothing to run against, and
      // that is a server that is not set up rather than an answer that failed: the same 503 the
      // container path answers, thrown from `run()` for the same reason it is thrown there.
      const mcpUrl = config.mcpUrl;
      if (!mcpUrl) throw new HttpError(503, 'O chat não está configurado neste servidor', 'CONCIERGE_DISABLED');
      const link: InputLink = { channel: null, pending: [], ended: false };
      const deadline = opts.deadlineMs ?? (input.stream_input ? STREAM_RUN_DEADLINE_MS : RUN_DEADLINE_MS);
      const lines = runOnAgent(machineId, host, input, mcpUrl, deadline, link);
      return Object.assign(lines, {
        write: (line: string): boolean => {
          if (link.ended) return false;
          const data = `${line}\n`;
          if (link.channel) link.channel.write(Buffer.from(data, 'utf8'));
          else link.pending.push(data);
          return true;
        },
      });
    },
  };
}

async function* runOnAgent(
  machineId: string,
  host: ClaudeChannelHost,
  input: RunnerInput,
  mcpUrl: string,
  deadlineMs: number,
  link: InputLink,
): AsyncGenerator<string> {
  try {
    const capabilities = host.capabilities(machineId);
    // Refused before a channel is minted, and told apart: a machine nobody is connected from, and a
    // machine whose agent has simply not updated yet. Opening anything on the second one would answer
    // `open_error` with no reason at all, which reads as a bug in the chat rather than an update.
    if (capabilities === null) {
      yield failureLine('host_gone', null);
      return;
    }
    if (!capabilities.includes(CAPABILITY_CLAUDE)) {
      yield failureLine('agent_too_old', null);
      return;
    }

    /** Lines the agent has sent and the caller has not read yet, and how the channel ended. Held on
     *  an object because both are written from the channel's callbacks, not from this generator's
     *  body. */
    const stream = {
      lines: [] as string[],
      /** Bytes after the last newline: the agent frames a line at a time, but a reader that assumed
       *  so would be one framing change away from gluing two lines together. */
      tail: '',
      /** Set only when the channel itself ended — which also means it no longer exists to be closed. */
      end: null as ChannelEnd | null,
      /** Set when the deadline gave up on a channel that is, as far as anyone here knows, still open. */
      expired: false,
      wake: null as (() => void) | null,
    };
    const notify = (): void => {
      const wake = stream.wake;
      stream.wake = null;
      wake?.();
    };
    const handlers: ChannelHandlers = {
      onData: (data) => {
        stream.tail += data.toString('utf8');
        const parts = stream.tail.split('\n');
        stream.tail = parts.pop() ?? '';
        for (const line of parts) if (line.trim()) stream.lines.push(line);
        notify();
      },
      onExit: (code, reason) => {
        stream.end = { code, reason };
        // The channel is gone the moment the agent says so — its number may already be handed to a
        // new terminal or a new run by the time this generator gets around to draining what is left
        // to yield. `write` must stop reaching it right here, not wait for the outer `finally`: that
        // one only runs once the consumer has drained the remaining lines, and a write in that
        // window would land on whatever now holds this channel number.
        link.ended = true;
        link.channel = null;
        notify();
      },
    };

    const params: ClaudeOpenParams = {
      session_id: input.session_id,
      resume: input.resume,
      // The account the run uses, as the caller resolved it; `null` is the machine's default one.
      config_dir: input.config_dir,
      mcp_url: mcpUrl,
      // Minted for this run and revoked when the next one starts; it travels in the open frame
      // because the channel does not exist yet when the agent needs it.
      token: input.token,
      model: input.model ?? null,
      append_system_prompt: input.append_system_prompt ?? null,
      ...(input.stream_input ? { stream_input: true } : {}),
    };

    let channel: AgentChannel;
    try {
      channel = await host.openClaude(machineId, params, handlers);
    } catch (err) {
      // The machine went offline between the capability check and the open, the agent refused the
      // channel, or it never answered: either way nothing is running there, so there is nothing to
      // close and the run is over. Never the error's own text — it is the agent's, not the user's.
      //
      // Except when the machine is perfectly fine and simply has no channel left (64 terminals open):
      // told apart, because "a sua máquina saiu do ar" about a healthy machine sends the person looking
      // for a problem that is not there, and the thing to do — close a few tabs — is nothing like
      // waking a laptop up.
      yield failureLine(err instanceof ChannelLimitError ? 'host_busy' : 'host_gone', null);
      return;
    }

    // What `httpRunner` expresses with AbortSignal.timeout: here it ends the iteration and the
    // `finally` closes the channel, which kills the CLI on the machine too. A plain failed run —
    // there is no frame to read a reason from when the run simply never finished.
    const deadline = setTimeout(() => {
      stream.expired = true;
      notify();
    }, deadlineMs);
    deadline.unref();

    try {
      // Channel data, never an open parameter: `claudeOpenParams` has no prompt field and its
      // safeParse strips unknown keys, so a prompt put in the open frame is dropped in silence and
      // the run hangs until a deadline. It is also the first of the CLI's input.
      channel.write(Buffer.from(input.text, 'utf8'));

      // Lines written while the channel was being opened, in the order they were written; from here
      // on `write` frames them straight onto the channel.
      link.channel = channel;
      for (const data of link.pending.splice(0)) channel.write(Buffer.from(data, 'utf8'));

      for (;;) {
        while (stream.lines.length > 0) yield stream.lines.shift() as string;
        if (stream.end || stream.expired) break;
        await new Promise<void>((resolve) => (stream.wake = resolve));
      }
      // A last line the agent framed without its newline; the container's reader keeps it too.
      if (stream.tail.trim()) yield stream.tail;
      const last = stream.end ? endOfRun(stream.end) : failureLine('run_failed', null);
      if (last) yield last;
    } finally {
      // Every way out passes here — the deadline, an exception, a write that failed, and above all
      // the caller walking away (a `break` or a `return` inside its `for await` calls this
      // generator's `return`, which runs this block). Without it a CLI would keep running on
      // someone's laptop with nobody listening.
      clearTimeout(deadline);
      // Only a channel that is still open: a channel that reported its own end is gone from the
      // connection, and its number is free for the next terminal on that machine to be given —
      // closing it by number now could close that terminal instead.
      if (!stream.end) channel.close();
    }
  } finally {
    link.ended = true;
    link.channel = null;
  }
}
