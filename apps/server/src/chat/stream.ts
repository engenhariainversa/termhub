import type { ChannelClosedReason } from '../agent/connection.js';
import { MODEL_RE } from '../setup/schema.js';

/** Status of a subagent task in the CLI. */
export type SubagentStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted';

/** What the chat cares about in one `stream-json` line. Everything else is ignored on purpose:
 * the CLI's frame set grows, and an unknown frame must never break a conversation. */
export type ChatFrame =
  | { type: 'text'; delta: string }
  | { type: 'action'; tool: string; tool_use_id: string; args: unknown }
  | { type: 'action_result'; tool_use_id: string; ok: boolean }
  /** `context`: how full the session is after this turn (see `contextUsage`), when the CLI said. */
  | { type: 'done'; session_id?: string; usage?: unknown; context?: ContextFill }
  /** `/compact` finished (`compact_boundary`): the context before and after, when the CLI said. */
  | { type: 'compacted'; tokens_before?: number; tokens?: number }
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
  | { type: 'background'; count: number }
  /** A subagent task was started. Carries the description the subagent's launcher provided, capped at 200 chars. */
  | { type: 'subagent_started'; task_id: string; tool_use_id: string; description: string; subagent_type: string | null }
  /** A subagent task's status changed to a terminal state. */
  | { type: 'subagent_status'; task_id: string; status: 'completed' | 'failed' | 'stopped' }
  /** A subagent used a termhub MCP tool (how a gated proposal is traced back to the subagent that made it). */
  | { type: 'subagent_tool'; parent_tool_use_id: string; tool_use_id: string; tool: string }
  /** A control request completed or failed. */
  | { type: 'control_response'; request_id: string; ok: boolean }
  /** Why the turn failed, in the CLI's own words (`error` on its synthetic assistant message, TER-588):
   *  the `result` that follows only says `is_error`. Only the failures the person can act on are named. */
  | { type: 'api_error'; reason: ChatFailureReason }
  /** The account hit its usage limit (`rate_limit_event` rejected); `resets_at` is ISO, or null when not said. */
  | { type: 'usage_limit'; resets_at: string | null }
  /** From `init`: where this run's session lives on the machine (`<config dir>/projects/<cwd slug>`), and
   *  the model it runs on (an id, e.g. "claude-opus-5-5"; TER-837). Either may be null when not said. */
  | { type: 'init'; dir: string | null; model: string | null };

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
// `usage_limit`, `model_unavailable` and `auth_failed` are read from the CLI's stream by `parseFrame`
// (TER-588): the CLI reports them on stdout with an empty stderr, so no runner can name them.
const REASONS = ['missing_session', 'cli_rejected', 'run_failed', 'cli_missing', 'killed', 'host_gone', 'agent_too_old', 'host_busy', 'reset', 'usage_limit', 'model_unavailable', 'auth_failed'] as const;

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

/** Maps a CLI task status to a subagent-terminal status, or returns null if it is not a terminal state. */
export function cliTaskStatus(raw: unknown): 'completed' | 'failed' | 'stopped' | null {
  if (raw === 'completed' || raw === 'failed') return raw;
  if (raw === 'killed' || raw === 'stopped' || raw === 'cancelled') return 'stopped';
  return null;
}

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

/** How full a session's context is: tokens in it, and the model's window (null when not reported). */
export interface ContextFill {
  tokens: number;
  window: number | null;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const TOKEN_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'] as const;
const tokensOf = (u: Record<string, unknown>) => TOKEN_FIELDS.reduce((sum, k) => sum + count(u[k]), 0);

/**
 * The context fill a `result` frame reports (TER-315). `usage` adds up every API call of the turn, so
 * it overcounts a turn that used tools (twice the cache reads for one tool call, see the tool-call
 * fixture); `usage.iterations` holds the turn's last call (Claude Code 2.1.283), whose input (fresh,
 * cached and cache-written) plus its output is what the session holds now. An empty list is a turn
 * with no API call (`/compact`'s own result): nothing to say. A CLI without the list gives the total,
 * exact for a turn of one call. The window is `modelUsage`'s: the largest one listed, since a
 * subagent on a smaller model shows up there too.
 */
export function contextUsage(result: Record<string, unknown>): ContextFill | undefined {
  const usage = result.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const iterations = (usage as { iterations?: unknown }).iterations;
  let tokens: number;
  if (Array.isArray(iterations)) {
    const last = iterations[iterations.length - 1];
    if (typeof last !== 'object' || last === null) return undefined;
    tokens = tokensOf(last as Record<string, unknown>);
  } else tokens = tokensOf(usage as Record<string, unknown>);
  if (tokens === 0) return undefined;
  const models = typeof result.modelUsage === 'object' && result.modelUsage !== null ? Object.values(result.modelUsage as Record<string, unknown>) : [];
  const windows = models.map((m) => count((m as { contextWindow?: unknown } | null)?.contextWindow)).filter((w) => w > 0);
  return { tokens, window: windows.length ? Math.max(...windows) : null };
}

const positive = (v: unknown): number | undefined => (count(v) > 0 ? (v as number) : undefined);

const toReason = (raw: unknown): ChatFailureReason | undefined => (typeof raw === 'string' && KNOWN.has(raw) ? (raw as ChatFailureReason) : undefined);

/** The CLI's `error` on a synthetic assistant message (Claude Code 2.1.285) → the reason stored for the
 *  turn. Anything else (`server_error`, `invalid_request`, `billing_error`, …) stays `run_failed`. */
const API_ERRORS: Record<string, ChatFailureReason> = { rate_limit: 'usage_limit', model_not_found: 'model_unavailable', authentication_failed: 'auth_failed' };
/** A `result` with no assistant frame before it: its HTTP status is all there is. */
const STATUS_REASONS: Record<number, ChatFailureReason> = { 429: 'usage_limit', 401: 'auth_failed' };

/** `<dir>/projects/<slug>/memory/` → `<dir>/projects/<slug>`: absolute, or nothing. */
function sessionDirOf(auto: unknown): string | undefined {
  if (typeof auto !== 'string' || !auto.startsWith('/') || /[\0-\x1f]/.test(auto)) return undefined;
  const parts = auto.replace(/\/+$/, '').split('/');
  if (parts.length < 5 || parts.at(-1) !== 'memory' || parts.at(-3) !== 'projects' || parts.some((s) => s === '..')) return undefined;
  return parts.slice(0, -1).join('/');
}

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
  if (typeof f.parent_tool_use_id === 'string') {
    // A subagent's own frames stay out of the chat. Only its termhub tool calls are read: they are
    // how a gated proposal is traced back to the subagent that made it (spec 2026-09-26 panel §5.1).
    if (type !== 'assistant') return null;
    const content = (f.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as { type?: string; id?: string; name?: string }[]) {
      if (block.type === 'tool_use' && block.id && block.name?.startsWith('mcp__termhub__')) return { type: 'subagent_tool', parent_tool_use_id: f.parent_tool_use_id, tool_use_id: block.id, tool: toolName(block.name) };
    }
    return null;
  }

  if (type === 'stream_event') {
    const event = f.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) return { type: 'text', delta: event.delta.text };
    return null;
  }
  if (type === 'assistant') {
    if (typeof f.error === 'string') {
      const reason = API_ERRORS[f.error];
      return reason ? { type: 'api_error', reason } : null;
    }
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
  if (type === 'system' && f.subtype === 'task_started') {
    if (typeof f.task_id !== 'string' || typeof f.tool_use_id !== 'string') return null;
    return { type: 'subagent_started', task_id: f.task_id, tool_use_id: f.tool_use_id, description: String(f.description ?? '').slice(0, 200), subagent_type: typeof f.subagent_type === 'string' ? f.subagent_type : null };
  }
  if (type === 'system' && (f.subtype === 'task_updated' || f.subtype === 'task_notification')) {
    const raw = f.subtype === 'task_updated' ? (f.patch as { status?: unknown } | undefined)?.status : f.status;
    const status = cliTaskStatus(raw);
    return typeof f.task_id === 'string' && status ? { type: 'subagent_status', task_id: f.task_id, status } : null;
  }
  if (type === 'control_response') {
    const r = f.response as { subtype?: unknown; request_id?: unknown } | undefined;
    return typeof r?.request_id === 'string' ? { type: 'control_response', request_id: r.request_id, ok: r.subtype === 'success' } : null;
  }
  if (type === 'system' && f.subtype === 'compact_boundary') {
    const meta = (f.compact_metadata ?? {}) as { pre_tokens?: unknown; post_tokens?: unknown };
    return { type: 'compacted', tokens_before: positive(meta.pre_tokens), tokens: positive(meta.post_tokens) };
  }
  if (type === 'rate_limit_event') {
    const info = (f.rate_limit_info ?? {}) as { status?: unknown; resetsAt?: unknown };
    if (info.status !== 'rejected') return null;
    return { type: 'usage_limit', resets_at: count(info.resetsAt) > 0 ? new Date((info.resetsAt as number) * 1000).toISOString() : null };
  }
  if (type === 'system' && f.subtype === 'init') {
    const dir = sessionDirOf((f.memory_paths as { auto?: unknown } | undefined)?.auto) ?? null;
    const model = typeof f.model === 'string' && MODEL_RE.test(f.model) ? f.model : null;
    return dir || model ? { type: 'init', dir, model } : null;
  }
  if (type === 'system' && f.subtype === 'background_tasks_changed') return { type: 'background', count: Array.isArray(f.tasks) ? f.tasks.length : 0 };
  if (type === 'result') {
    // A `result` frame is not by itself an answer: `is_error` marks a run that ended badly (max
    // turns, an API error, every tool denied). Treating it as `done` stored it as a clean message
    // — often an empty one, which the page then showed as "pensando…" forever.
    // The session id is kept: the run failed, but the session it ran in is still on disk with the
    // whole conversation in it, and the next message must resume that thread.
    // Its reason is only the status code's guess: the assistant frame before it (`api_error`) names the
    // failure, and the consumers let that win.
    if (f.is_error === true) return { type: 'error', message: 'run ended with is_error', reason: (typeof f.api_error_status === 'number' && STATUS_REASONS[f.api_error_status]) || 'run_failed', session_id: typeof f.session_id === 'string' ? f.session_id : undefined, turn_ended: true };
    const context = contextUsage(f);
    return { type: 'done', session_id: typeof f.session_id === 'string' ? f.session_id : undefined, usage: f.usage, ...(context ? { context } : {}) };
  }
  if (type === 'termhub_error') return { type: 'error', message: String(f.message ?? 'runner failed'), reason: toReason(f.reason) };
  return null;
}
