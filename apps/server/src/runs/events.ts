/**
 * Normalized run events (TER-1176, spec "Normalized events"): one shape for every provider, so a caller of
 * `/api/v1/runs` reads Claude Code and Codex runs the same way. Adapters (`adapters/*.ts`) turn each raw
 * stdout line of a CLI into these; the run service adds `started` and `done`, stores them in order and
 * streams them over SSE.
 *
 * Events carry the run's output, which is the owner's own data: never log them (run id, seq, type and
 * sizes only).
 */

export type Provider = 'claude' | 'codex';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type RunErrorCode = 'account_limited' | 'cli_failed' | 'timeout' | 'agent_offline' | 'permission_denied';

/** What a run may do: `read` (the default) only reads; `edit` changes files; `run_commands` runs a shell. */
export type Capability = 'read' | 'edit' | 'run_commands';

/** Where the run works: the project's folder (read-only runs) or a disposable worktree (edit runs). */
export interface Workspace {
  kind: 'project' | 'worktree';
  path: string;
  branch: string | null;
}

/** Tokens so far (cumulative), and the cost when the CLI reports it (Claude Code does, Codex does not). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number;
}

/** Normalized tool names; anything else is `other:<raw name>`. */
export type ToolName = 'read' | 'edit' | 'shell' | 'search' | 'web' | `other:${string}`;

export type RunEvent =
  | { type: 'started'; provider: Provider; model: string | null; machine: string; account: string; workspace: Workspace }
  | { type: 'text_delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: ToolName; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string }
  /** Reserved: v1 runs are non-interactive and never emit it. */
  | { type: 'question'; text: string; options: string[] }
  | { type: 'usage'; input_tokens: number; output_tokens: number; cost_usd?: number }
  | { type: 'error'; code: RunErrorCode; message: string }
  | { type: 'done'; status: RunStatus; result: string | null; usage: Usage | null };

export type RunEventType = RunEvent['type'];

/** What an adapter has gathered when the process ends: the final text, the usage, and whether the CLI
 *  reported success. The service turns it (with the exit code) into the `done` event. */
export interface AdapterOutcome {
  result: string | null;
  usage: Usage | null;
  ok: boolean;
}

/**
 * One per run: `parse` takes one raw stdout line and returns the events it maps to — `[]` for a line it
 * does not know (a newer CLI, a log line, garbage), never a throw, so the run keeps going and still gets
 * its `done`.
 */
export interface Adapter {
  parse(line: string): RunEvent[];
  finish(): AdapterOutcome;
}

/** The most a `tool_use` input takes once serialized (spec: truncated to 2 KB). */
export const TOOL_INPUT_MAX_BYTES = 2048;
/** The most a `tool_result` summary or an `error` message takes. */
export const SUMMARY_MAX_CHARS = 500;

/** A JSON object out of a raw line, or null for anything else (garbage, a bare value, an array). */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Text cut to `max` characters (code points), with an ellipsis when cut. */
export function clip(text: string, max = SUMMARY_MAX_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join('') + '…';
}

/**
 * A tool input as stored: unchanged when its JSON fits in 2 KB, else `{ truncated: true, preview }` with
 * the start of its JSON, the whole thing still within 2 KB.
 */
export function truncateInput(input: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(input ?? null);
  } catch {
    return { truncated: true, preview: '' };
  }
  if (Buffer.byteLength(json, 'utf8') <= TOOL_INPUT_MAX_BYTES) return input ?? null;
  let preview = Array.from(json);
  let cut = TOOL_INPUT_MAX_BYTES - 40;
  preview = preview.slice(0, cut);
  for (;;) {
    const candidate = { truncated: true, preview: preview.join('') };
    const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    if (size <= TOOL_INPUT_MAX_BYTES) return candidate;
    cut = Math.max(0, preview.length - (size - TOOL_INPUT_MAX_BYTES) - 1);
    preview = preview.slice(0, cut);
  }
}

/** Whether an error text reads as the account's limit (rate limit, usage limit, quota). */
export function looksLikeLimit(message: string): boolean {
  return /rate[ _-]?limit|usage limit|limit reached|hit your limit|quota|too many requests|\b429\b/i.test(message);
}
