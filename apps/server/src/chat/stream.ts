import type { ChannelClosedReason } from '../agent/connection.js';

/** What the chat cares about in one `stream-json` line. Everything else is ignored on purpose:
 * the CLI's frame set grows, and an unknown frame must never break a conversation. */
export type ChatFrame =
  | { type: 'text'; delta: string }
  | { type: 'action'; tool: string; tool_use_id: string; args: unknown }
  | { type: 'action_result'; tool_use_id: string; ok: boolean }
  | { type: 'done'; session_id?: string; usage?: unknown }
  /** `reason` is the runner's machine-readable classification of the failure (never stderr's
   * text): `missing_session` is the one the service acts on, by retrying on a fresh CLI session.
   * `session_id` is carried for the same reason as on `done`: a run can fail with its session, and
   * its whole transcript, safely on disk. */
  | {
      type: 'error';
      message: string;
      reason?: ChatFailureReason;
      session_id?: string;
      /** true for a turn that failed inside a run that goes on (a result with is_error); absent when
       *  the run itself ended. */
      turn_ended?: boolean;
    }
  /** A message written to a streamed run started its turn: the CLI replays it (`isReplay`) with the
   *  `uuid` the server gave it, which is how an answer is matched to its question. */
  | { type: 'turn_started'; uuid: string }
  /** How many background subagents the session has now (`background_tasks_changed`). */
  | { type: 'background'; count: number };

/**
 * Every label a runner may end a failed run with: the container's `FailureReason`, the protocol's
 * `closedReason` (what a run on the user's own machine reports) and the three only the server can see
 * — the machine is not there, its agent is too old to run a chat, and it is there and healthy with
 * every channel already taken (`host_busy`, which must never read as a machine that went away). One set, so a label a runner
 * takes the trouble to name is never dropped one layer above it; an unknown one still is, rather than
 * being guessed at.
 */
// `reset` (a tcp channel's local socket reset) is included only to keep this list covering the
// protocol's whole `closedReason` set per PROTOCOL_REASONS_COVERED below — a chat run's pty/claude
// channel never actually reports it.
const REASONS = ['missing_session', 'cli_rejected', 'run_failed', 'cli_missing', 'killed', 'host_gone', 'agent_too_old', 'host_busy', 'reset'] as const;

/** Written exactly once: the type and the runtime check below are both derived from `REASONS`, so a
 *  label added to the list cannot be accepted by one and dropped by the other — the silent drift this
 *  whole chain of tasks keeps closing. */
export type ChatFailureReason = (typeof REASONS)[number];

/**
 * What a stored failure says. Every label a runner can end a run with becomes a code of its own —
 * `Uppercase<ChatFailureReason>`, derived from the one list above, so a new reason reaches the row
 * (and the screen) without anyone remembering to extend a mapping here. CLI_REJECTED is our own
 * flags being refused, MISSING_SESSION a session the account no longer has, CLI_MISSING a machine
 * with no `claude` installed, HOST_GONE the machine going away mid-run. The two that are not a
 * runner's label: TOKEN_FAILED (the server could not even mint a credential) and RUNNER_FAILED (the
 * stream ended with nothing said about why).
 */
export type ChatErrorCode = 'TOKEN_FAILED' | 'RUNNER_FAILED' | Uppercase<ChatFailureReason> | null;

export const codeForReason = (reason?: ChatFailureReason): ChatErrorCode => (reason ? (reason.toUpperCase() as Uppercase<ChatFailureReason>) : 'RUNNER_FAILED');

/**
 * …and the other half of that drift, which cost this branch its first review finding: a label added to
 * the protocol's `closedReason` and forgotten here parses fine, reaches `toReason`, and is dropped in
 * silence — `cli_rejected` lived one layer below a sentence nobody could ever read. The compiler checks
 * it now: when `ChannelClosedReason` gains a member `REASONS` does not have, the conditional resolves to
 * `never`, `true` no longer satisfies it, and this file stops compiling. The value is never read; the
 * type is the whole point. (The classifier's `ClaudeFailureReason` is a subset of the protocol's set,
 * so covering that set covers both runners.)
 */
const PROTOCOL_REASONS_COVERED = true satisfies (ChannelClosedReason extends ChatFailureReason ? true : never);
void PROTOCOL_REASONS_COVERED;

const KNOWN = new Set<string>(REASONS);

const toReason = (raw: unknown): ChatFailureReason | undefined => (typeof raw === 'string' && KNOWN.has(raw) ? (raw as ChatFailureReason) : undefined);

/** `mcp__termhub__list_tabs` -> `list_tabs`; anything else is kept as it came. */
const toolName = (raw: string) => (raw.startsWith('mcp__termhub__') ? raw.slice('mcp__termhub__'.length) : raw);

export function parseFrame(line: string): ChatFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const f = parsed as Record<string, unknown>;
  const type = f.type;

  // A subagent's own frames (its text, its tool calls) are its business: the person hears what the
  // concierge relays, not the subagent's raw work. Its launch and its notification are the
  // concierge's own frames and still go through.
  if (typeof f.parent_tool_use_id === 'string') return null;

  if (type === 'stream_event') {
    const event = f.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) return { type: 'text', delta: event.delta.text };
    return null;
  }
  if (type === 'assistant') {
    const content = (f.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as { type?: string; id?: string; name?: string; input?: unknown }[]) {
      if (block.type === 'tool_use' && block.id && block.name) return { type: 'action', tool: toolName(block.name), tool_use_id: block.id, args: block.input ?? {} };
    }
    return null;
  }
  if (type === 'user') {
    if (f.isReplay === true) return typeof f.uuid === 'string' ? { type: 'turn_started', uuid: f.uuid } : null;
    const content = (f.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as { type?: string; tool_use_id?: string; is_error?: boolean }[]) {
      if (block.type === 'tool_result' && block.tool_use_id) return { type: 'action_result', tool_use_id: block.tool_use_id, ok: block.is_error !== true };
    }
    return null;
  }
  if (type === 'system' && f.subtype === 'background_tasks_changed') return { type: 'background', count: Array.isArray(f.tasks) ? f.tasks.length : 0 };
  if (type === 'result') {
    // A `result` frame is not by itself an answer: `is_error` marks a run that ended badly (max
    // turns, an API error, every tool denied). Treating it as `done` stored it as a clean message
    // — often an empty one, which the page then showed as "pensando…" forever.
    // The session id is kept: the run failed, but the session it ran in is still on disk with the
    // whole conversation in it, and the next message must resume that thread.
    if (f.is_error === true) return { type: 'error', message: 'run ended with is_error', reason: 'run_failed', session_id: typeof f.session_id === 'string' ? f.session_id : undefined, turn_ended: true };
    return { type: 'done', session_id: typeof f.session_id === 'string' ? f.session_id : undefined, usage: f.usage };
  }
  if (type === 'termhub_error') return { type: 'error', message: String(f.message ?? 'runner failed'), reason: toReason(f.reason) };
  return null;
}
