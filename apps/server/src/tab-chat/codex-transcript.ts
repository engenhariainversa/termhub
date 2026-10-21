import { createHash } from 'node:crypto';
import type { Parsed, TabChatItem } from './transcript.js';

/**
 * Codex session lines (`rollout-*.jsonl`, as `transcript.read` returns them) turned into the items of a
 * conversation (TER-1095), the Codex side of `transcript.ts`. Only `event_msg` lines are read: they are
 * what the Codex screen shows (the person's prompts, the agent's messages, the commands and edits it
 * ran), while `response_item` lines also carry the instructions Codex injects into the model's context.
 * The format is internal to Codex and changes without notice, so every function here is total: an odd
 * shape is counted as `unknown`, never thrown. Pure: nothing is logged or stored.
 *
 * Checked against codex-cli 0.159.3 (`fixtures/codex-0.159.3-rollout.jsonl`): every screen item is an
 * `item_completed` event. Older releases wrote `user_message` / `agent_message` events instead; those are
 * read too.
 */

/** The line types the server asks the agent for. */
export const CODEX_TRANSCRIPT_TYPES = ['event_msg'] as const;

const SUMMARY_MAX = 300;
const PREVIEW_MAX = 2000;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

const hashOf = (raw: string) => createHash('sha256').update(raw).digest('hex').slice(0, 16);

/** The text parts of an item's `content` (`text` in a UserMessage, `Text` in an AgentMessage), or null when it is not a list. */
function contentOf(content: unknown): { text: string; images: number } | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  let images = 0;
  for (const b of content) {
    const block = asRecord(b);
    if (!block) continue;
    const kind = str(block.type)?.toLowerCase();
    if (kind === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (kind === 'image' || kind === 'local_image' || kind === 'localimage') images++;
  }
  return { text: texts.join('\n'), images };
}

/** The command line a CommandExecution ran: the script of `bash -lc <script>`, else the words joined. */
function commandOf(command: unknown): string | null {
  if (typeof command === 'string') return command.slice(0, SUMMARY_MAX);
  if (!Array.isArray(command) || !command.every((w) => typeof w === 'string')) return null;
  const words = command as string[];
  const shell = words.length === 3 && /(^|\/)(ba|z)?sh$/.test(words[0]) && (words[1] === '-lc' || words[1] === '-c');
  return (shell ? words[2] : words.join(' ')).slice(0, SUMMARY_MAX);
}

function previewOf(...outputs: unknown[]): string | null {
  const text = outputs.map(str).find((s) => s !== null && s.trim() !== '');
  return text ? text.slice(0, PREVIEW_MAX) : null;
}

/** A status as one word, whatever its case and separators: `in_progress`, `inProgress` and `InProgress` are one. */
const statusWord = (status: string): string => status.toLowerCase().replace(/[_\s-]/g, '');

/** The statuses that say a tool call did not go through; any other one (a newer spelling of "completed") is not an error (TER-1102). */
const FAILED = new Set(['failed', 'declined', 'error', 'rejected', 'cancelled', 'canceled']);

/** A tool call's result, once Codex says how it ended. */
function resultOf(id: string, at: string, status: string | null, failed: boolean, preview: string | null): TabChatItem[] {
  if (status === null || statusWord(status) === 'inprogress') return [];
  return [{ kind: 'tool_result', id: `${id}:result`, at, tool_id: id, error: failed || FAILED.has(statusWord(status)), preview }];
}

/** Items of one `item_completed` item, or null when it matched no rule. */
function itemOf(item: Record<string, unknown>, raw: string, at: string): TabChatItem[] | null {
  const type = str(item.type);
  if (!type) return null;
  const id = str(item.id) ?? hashOf(raw);
  const status = str(item.status);
  switch (type) {
    case 'UserMessage': {
      const c = contentOf(item.content);
      if (!c) return null;
      return c.text.trim() || c.images ? [{ kind: 'user', id, at, text: c.text, images: c.images }] : [];
    }
    case 'AgentMessage': {
      const c = contentOf(item.content);
      if (!c) return null;
      return c.text.trim() ? [{ kind: 'assistant', id, at, text: c.text.trim() }] : [];
    }
    case 'CommandExecution': {
      const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
      return [
        { kind: 'tool', id, at, name: 'Bash', summary: commandOf(item.command) },
        ...resultOf(id, at, status, exit !== null && exit !== 0, previewOf(item.aggregated_output, item.formatted_output, item.stdout, item.stderr)),
      ];
    }
    case 'FileChange': {
      const changes = asRecord(item.changes);
      const paths = changes ? Object.keys(changes) : [];
      const summary = paths.length ? `${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1})` : ''}`.slice(0, SUMMARY_MAX) : null;
      return [{ kind: 'tool', id, at, name: 'apply_patch', summary }, ...resultOf(id, at, status, false, previewOf(item.stdout, item.stderr))];
    }
    case 'McpToolCall': {
      const server = str(item.server);
      const tool = str(item.tool);
      return [{ kind: 'tool', id, at, name: server && tool ? `mcp__${server}__${tool}` : (tool ?? 'mcp'), summary: null }, ...resultOf(id, at, status, false, null)];
    }
    case 'WebSearch':
      return [{ kind: 'tool', id, at, name: 'web_search', summary: str(item.query)?.slice(0, SUMMARY_MAX) ?? null }];
    default:
      // Reasoning, plans and whatever a newer Codex adds: not part of the conversation.
      return [];
  }
}

/** Items of one `event_msg` payload, or null when it matched no rule. */
function eventOf(payload: Record<string, unknown>, raw: string, at: string): TabChatItem[] | null {
  const type = str(payload.type);
  if (!type) return null;
  switch (type) {
    case 'item_completed': {
      const item = asRecord(payload.item);
      return item ? itemOf(item, raw, at) : null;
    }
    case 'user_message': {
      const text = str(payload.message);
      if (text === null) return null;
      const images = Array.isArray(payload.images) ? payload.images.length : 0;
      return text.trim() || images ? [{ kind: 'user', id: hashOf(raw), at, text, images }] : [];
    }
    case 'agent_message': {
      const text = str(payload.message);
      if (text === null) return null;
      return text.trim() ? [{ kind: 'assistant', id: hashOf(raw), at, text: text.trim() }] : [];
    }
    case 'turn_aborted':
      return [{ kind: 'notice', id: hashOf(raw), at, notice: 'interrupted' }];
    case 'context_compacted':
      return [{ kind: 'notice', id: hashOf(raw), at, notice: 'compacted' }];
    default:
      // task_started, task_complete, token_count, settings…: bookkeeping, not conversation.
      return [];
  }
}

export function parseCodexLines(lines: string[]): Parsed {
  const out: Parsed = { items: [], mode: null, known: 0, unknown: 0 };
  for (const raw of lines) {
    let o: Record<string, unknown> | null;
    try {
      o = asRecord(JSON.parse(raw));
    } catch {
      o = null;
    }
    if (!o) {
      out.unknown++;
      continue;
    }
    const at = str(o.timestamp) ?? '';
    if (o.termhub_dropped === true) {
      out.items.push({ kind: 'notice', id: hashOf(raw), at, notice: 'truncated' });
      out.known++;
      continue;
    }
    if (o.type !== 'event_msg') {
      out.known++;
      continue;
    }
    const payload = asRecord(o.payload);
    const items = payload ? eventOf(payload, raw, at) : null;
    if (items === null) {
      out.unknown++;
      continue;
    }
    out.known++;
    out.items.push(...items);
  }
  return out;
}
