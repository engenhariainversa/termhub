// The session screen's timeline (spec 2026-10-01 tab chat §6): the items the server read from the
// session's transcript, merged by id, then folded into the rows the screen draws. Pure: no React.
import { t, tk } from '@/i18n';
import type { TTabChatItem } from '@/services/api/contract';

export interface ToolRow {
  id: string;
  name: string;
  summary: string | null;
  status: 'running' | 'done' | 'error';
  preview: string | null;
}

export type Row =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; images: number; at: string }
  | { kind: 'tools'; id: string; tools: ToolRow[] }
  | { kind: 'line'; id: string; text: string };

const NOTICE_TEXT = {
  compacted: tk('Conversa compactada'),
  interrupted: tk('Interrompido'),
  truncated: tk('Parte do histórico foi omitida por ser grande demais'),
} as const;

/**
 * `incoming` into `current`, by id. `append` (a live frame): an item already there is replaced where
 * it is, the rest goes at the end. `prepend` (an earlier page): the items not there yet go before.
 * Order is otherwise kept as given.
 */
export function mergeItems(current: TTabChatItem[], incoming: TTabChatItem[], where: 'append' | 'prepend'): TTabChatItem[] {
  if (incoming.length === 0) return current;
  const known = new Map(current.map((item, index) => [item.id, index]));
  if (where === 'prepend') {
    const older = incoming.filter((item, index) => !known.has(item.id) && incoming.findIndex((i) => i.id === item.id) === index);
    return older.length === 0 ? current : [...older, ...current];
  }
  const next = current.slice();
  for (const item of incoming) {
    const index = known.get(item.id);
    if (index !== undefined) {
      next[index] = item;
    } else {
      known.set(item.id, next.length);
      next.push(item);
    }
  }
  return next;
}

/**
 * The rows of `items`: `user`/`assistant` are messages; consecutive tools fold into one row (their
 * results, which give no row of their own, do not break the run); a result marks its tool; a tool
 * with no result is running while the tab works (`working`) and done otherwise. A result whose tool
 * is on a page not loaded gives nothing. Commands, their output and notices are small lines.
 */
export function buildRows(items: TTabChatItem[], working: boolean): Row[] {
  const results = new Map<string, Extract<TTabChatItem, { kind: 'tool_result' }>>();
  for (const item of items) if (item.kind === 'tool_result') results.set(item.tool_id, item);

  const rows: Row[] = [];
  let tools: Extract<Row, { kind: 'tools' }> | null = null;
  for (const item of items) {
    if (item.kind === 'tool_result') continue;
    if (item.kind === 'tool') {
      const r = results.get(item.id);
      const row: ToolRow = {
        id: item.id,
        name: item.name,
        summary: item.summary,
        status: r ? (r.error ? 'error' : 'done') : working ? 'running' : 'done',
        preview: r?.preview ?? null,
      };
      if (tools) {
        tools.tools.push(row);
      } else {
        tools = { kind: 'tools', id: `tools:${item.id}`, tools: [row] };
        rows.push(tools);
      }
      continue;
    }
    tools = null;
    switch (item.kind) {
      case 'user':
        rows.push({ kind: 'message', id: item.id, role: 'user', text: item.text, images: item.images, at: item.at });
        break;
      case 'assistant':
        rows.push({ kind: 'message', id: item.id, role: 'assistant', text: item.text, images: 0, at: item.at });
        break;
      case 'command':
        rows.push({ kind: 'line', id: item.id, text: item.args ? `${item.name} ${item.args}` : item.name });
        break;
      case 'command_output':
        rows.push({ kind: 'line', id: item.id, text: item.text });
        break;
      case 'notice':
        rows.push({ kind: 'line', id: item.id, text: t(NOTICE_TEXT[item.notice]) });
        break;
    }
  }
  return rows;
}
