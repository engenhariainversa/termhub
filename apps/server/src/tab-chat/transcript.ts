import { createHash } from 'node:crypto';

/**
 * Claude Code transcript lines (JSONL, as `transcript.read` returns them) turned into the items of a
 * conversation (spec 2026-10-01 tab chat §5.1). The format is internal to Claude Code and changes
 * without notice, so every function here is total: an odd shape is counted as `unknown`, never thrown.
 * Pure: nothing is logged or stored.
 */

/** The line types the server asks the agent for. */
export const TRANSCRIPT_TYPES = ['user', 'assistant', 'system', 'permission-mode'] as const;

/** Kept in step with `tabChatItem` of `@termhub/mobile-api` by `contract-parity.test.ts`. */
export type TabChatItem =
  | { kind: 'user'; id: string; at: string; text: string; images: number }
  | { kind: 'assistant'; id: string; at: string; text: string }
  | { kind: 'tool'; id: string; at: string; name: string; summary: string | null }
  | { kind: 'tool_result'; id: string; at: string; tool_id: string; error: boolean; preview: string | null }
  | { kind: 'command'; id: string; at: string; name: string; args: string | null }
  | { kind: 'command_output'; id: string; at: string; text: string }
  | { kind: 'notice'; id: string; at: string; notice: 'compacted' | 'interrupted' | 'truncated' };

export interface Parsed {
  items: TabChatItem[];
  /** the last `permission-mode` read, or null */
  mode: string | null;
  /** lines that produced an item or hit a documented skip */
  known: number;
  /** lines of an asked type that matched no rule */
  unknown: number;
}

const SUMMARY_MAX = 300;
const PREVIEW_MAX = 2000;

/** User lines that are only one of these wrappers are Claude Code's own bookkeeping, not a prompt. */
const WRAPPERS = ['task-notification', 'system-reminder', 'local-command-caveat'];

/** Which input field names what a tool call is about. */
const SUMMARY_KEY: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
  Agent: 'description',
  Task: 'description',
  WebFetch: 'url',
  WebSearch: 'query',
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function idOf(o: Record<string, unknown>, raw: string): string {
  return str(o.uuid) ?? createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function onlyWrapper(text: string): boolean {
  const t = text.trim();
  return WRAPPERS.some((tag) => t.startsWith(`<${tag}>`));
}

function summaryOf(name: string, input: unknown): string | null {
  const key = SUMMARY_KEY[name];
  if (!key) return null;
  const value = str(asRecord(input)?.[key]);
  return value === null ? null : value.slice(0, SUMMARY_MAX);
}

function previewOf(content: unknown): string | null {
  if (typeof content === 'string') return content.slice(0, PREVIEW_MAX);
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((b) => {
    const block = asRecord(b);
    const text = block?.type === 'text' ? str(block.text) : null;
    return text === null ? [] : [text];
  });
  return texts.length ? texts.join('\n').slice(0, PREVIEW_MAX) : null;
}

function tagged(text: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1] : null;
}

/** The item a user text gives, or null for a documented skip. */
function userText(o: Record<string, unknown>, id: string, at: string, text: string, images: number): TabChatItem | null {
  if (o.isCompactSummary === true) return { kind: 'notice', id, at, notice: 'compacted' };
  const command = tagged(text, 'command-name');
  if (command !== null) {
    const args = tagged(text, 'command-args')?.trim() ?? '';
    return { kind: 'command', id, at, name: command.trim(), args: args || null };
  }
  const t = text.trim();
  if (t.startsWith('<local-command-stdout>')) return { kind: 'command_output', id, at, text: tagged(t, 'local-command-stdout') ?? '' };
  if (t.startsWith('<local-command-stderr>')) return { kind: 'command_output', id, at, text: tagged(t, 'local-command-stderr') ?? '' };
  if (t.startsWith('[Request interrupted by user')) return { kind: 'notice', id, at, notice: 'interrupted' };
  if (onlyWrapper(t)) return null;
  if (!t && images === 0) return null;
  return { kind: 'user', id, at, text, images };
}

/** Items of one user line, or null when the line matched no rule. */
function userLine(o: Record<string, unknown>, id: string, at: string): TabChatItem[] | null {
  const message = asRecord(o.message);
  if (!message) return null;
  const content = message.content;
  if (typeof content === 'string') {
    const item = userText(o, id, at, content, 0);
    return item ? [item] : [];
  }
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  let images = 0;
  let matched = content.length === 0;
  const results: TabChatItem[] = [];
  content.forEach((b, index) => {
    const block = asRecord(b);
    if (!block) return;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      matched = true;
    } else if (block.type === 'image') {
      images++;
      matched = true;
    } else if (block.type === 'tool_result') {
      results.push({
        kind: 'tool_result',
        id: `${id}:${index}`,
        at,
        tool_id: str(block.tool_use_id) ?? '',
        error: block.is_error === true,
        preview: previewOf(block.content),
      });
      matched = true;
    }
  });
  if (!matched) return null;
  const item = texts.length || images ? userText(o, id, at, texts.join('\n'), images) : null;
  return item ? [item, ...results] : results;
}

/** Items of one assistant line, or null when the line matched no rule. */
function assistantLine(o: Record<string, unknown>, id: string, at: string): TabChatItem[] | null {
  const content = asRecord(o.message)?.content;
  if (!Array.isArray(content)) return null;
  const items: TabChatItem[] = [];
  let matched = false;
  content.forEach((b, index) => {
    const block = asRecord(b);
    if (!block) return;
    if (block.type === 'text' && typeof block.text === 'string') {
      items.push({ kind: 'assistant', id: `${id}:${index}`, at, text: block.text });
      matched = true;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      items.push({ kind: 'tool', id: str(block.id) ?? `${id}:${index}`, at, name: block.name, summary: summaryOf(block.name, block.input) });
      matched = true;
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      matched = true;
    }
  });
  return matched ? items : null;
}

export function parseLines(lines: string[]): Parsed {
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
    if (o.type === 'permission-mode') {
      out.mode = str(o.permissionMode) ?? out.mode;
      continue;
    }
    const id = idOf(o, raw);
    const at = str(o.timestamp) ?? '';
    if (o.termhub_dropped === true) {
      out.items.push({ kind: 'notice', id, at, notice: 'truncated' });
      out.known++;
      continue;
    }
    if (o.isSidechain === true || o.isMeta === true) {
      out.known++;
      continue;
    }
    let items: TabChatItem[] | null = null;
    if (o.type === 'user') items = userLine(o, id, at);
    else if (o.type === 'assistant') items = assistantLine(o, id, at);
    else if (o.type === 'system') items = o.subtype === 'compact_boundary' ? [{ kind: 'notice', id, at, notice: 'compacted' }] : [];
    if (items === null) {
      out.unknown++;
      continue;
    }
    out.known++;
    out.items.push(...items);
  }
  return out;
}

/** More than half of the lines matched no rule: the format probably changed. */
export function isDegraded(p: Pick<Parsed, 'known' | 'unknown'>): boolean {
  return p.unknown > (p.known + p.unknown) / 2;
}
