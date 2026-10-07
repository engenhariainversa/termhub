// A Claude Code tab read as a conversation in the web (TER-1003), as the phone's session screen reads it
// (spec 2026-10-01 tab chat §6): the items the server read from the session's transcript, merged by id,
// then folded into the rows the view draws. Pure: no React, no DOM.
import { i18n, tk } from '../i18n';
import type { TabChatItem, TabChatSummary } from './types';

export interface ToolRow {
  id: string;
  name: string;
  summary: string | null;
  status: 'running' | 'done' | 'error';
  preview: string | null;
}

export type TabChatRow =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; images: number; at: string }
  | { kind: 'tools'; id: string; tools: ToolRow[] }
  /** A subagent (`Agent`/`Task` call): its description, and its report once it returned. */
  | { kind: 'subagent'; id: string; tool: ToolRow }
  | { kind: 'line'; id: string; text: string };

/** The tools that start a subagent: their call and result are the subagent's whole trace in the main thread (spec D9). */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

const NOTICE_TEXT = {
  compacted: tk('Conversa compactada'),
  interrupted: tk('Interrompido'),
  truncated: tk('Parte do histórico foi omitida por ser grande demais'),
} as const;

/**
 * `incoming` into `current`, by id. `append` (a live frame): an item already there is replaced where
 * it is, the rest goes at the end. `prepend` (an earlier page): the items not there yet go before.
 */
export function mergeItems(current: TabChatItem[], incoming: TabChatItem[], where: 'append' | 'prepend'): TabChatItem[] {
  if (incoming.length === 0) return current;
  const known = new Map(current.map((item, index) => [item.id, index]));
  if (where === 'prepend') {
    const seen = new Set<string>();
    const older = incoming.filter((item) => {
      if (known.has(item.id) || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
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
 * results give no row of their own and do not break the run); a subagent call is a row of its own; a
 * result marks its tool; a tool with no result is running while the tab works and done otherwise.
 * Commands, their output and notices are small lines.
 */
export function buildRows(items: TabChatItem[], working: boolean): TabChatRow[] {
  const results = new Map<string, Extract<TabChatItem, { kind: 'tool_result' }>>();
  for (const item of items) if (item.kind === 'tool_result') results.set(item.tool_id, item);

  const rows: TabChatRow[] = [];
  let tools: Extract<TabChatRow, { kind: 'tools' }> | null = null;
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
      if (SUBAGENT_TOOLS.has(item.name)) {
        tools = null;
        rows.push({ kind: 'subagent', id: `subagent:${item.id}`, tool: row });
        continue;
      }
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
        rows.push({ kind: 'line', id: item.id, text: i18n.t(NOTICE_TEXT[item.notice]) });
        break;
    }
  }
  return rows;
}

const MODE_LABEL: Record<string, string> = {
  default: tk('Padrão'),
  acceptEdits: tk('Aceitar edições'),
  plan: tk('Plano'),
  bypassPermissions: tk('Sem confirmações'),
  auto: tk('Automático'),
};

/** Claude Code's permission mode as the header shows it. A mode this build does not know reads as
 *  itself; `unknown` (the footer could not be read) and no mode at all read as nothing. */
export function modeLabel(mode: string | null): string | null {
  if (mode === null || mode === 'unknown' || mode === '') return null;
  return Object.prototype.hasOwnProperty.call(MODE_LABEL, mode) ? i18n.t(MODE_LABEL[mode]!) : mode;
}

const AVAILABILITY_TEXT: Record<string, string> = {
  offline: tk('Máquina offline'),
  agent_outdated: tk('Atualize o agente desta máquina'),
  no_session: tk('Sem sessão do Claude nesta aba'),
  unsupported_tool: tk('Só Claude Code por enquanto'),
  unsupported_machine: tk('Esta máquina não usa o agente do termhub'),
};

/** Why the tab cannot be read as a conversation; `null` for `ready`. A value a newer server adds reads as the generic line. */
export function availabilityText(availability: string): string | null {
  if (availability === 'ready') return null;
  return Object.prototype.hasOwnProperty.call(AVAILABILITY_TEXT, availability) ? i18n.t(AVAILABILITY_TEXT[availability]!) : i18n.t('Indisponível no momento');
}

/** Whether the composer can send: typing goes through tmux, which needs the machine but not the
 *  transcript, so only an offline machine stops it (spec 2026-10-01 tab chat §7). */
export function canType(availability: string): boolean {
  return availability !== 'offline';
}

/** The tab's state in one short line: "Esperando você", "Trabalhando · Bash", "Em segundo plano", "Erro", "Concluído", "Parado". */
export function stateLine(tab: Pick<TabChatSummary, 'state' | 'background' | 'finished' | 'needs_you' | 'activity'>): string {
  if (tab.needs_you || tab.state === 'waiting_input' || tab.state === 'waiting_permission') return i18n.t('Esperando você');
  if (tab.state === 'working') {
    if (tab.background) return i18n.t('Em segundo plano');
    return tab.activity ? i18n.t('Trabalhando · {{activity}}', { activity: tab.activity }) : i18n.t('Trabalhando');
  }
  if (tab.state === 'error') return i18n.t('Erro');
  if (tab.state === 'idle' && tab.finished) return i18n.t('Concluído');
  return i18n.t('Parado');
}

/** A file picked in the composer, saved on the tab's machine: the message carries its path, as a paste in the terminal does. */
export function withAttachedPaths(text: string, paths: readonly string[]): string {
  const body = text.trim();
  if (paths.length === 0) return body;
  const list = paths.join(' ');
  return body ? `${body}\n\n${list}` : list;
}
