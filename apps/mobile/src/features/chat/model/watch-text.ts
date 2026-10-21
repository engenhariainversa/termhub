// What the "Acompanhando" strip says of a concierge watch (TER-1099): the pieces are structured on the
// wire (`kind`, `events`) so the phone composes them in its own language; `label` and `note` are data
// (the target's name, the concierge's own note) and are shown as they come. A kind or an event a newer
// server adds reads as its raw name rather than breaking the strip.
import { t, tk } from '@/i18n';
import { formatDateTime, formatTime } from '@/i18n/format';
import type { ChatWatch } from './types';

/** The target's kind, as a translation key (`t(label)` where shown). */
const KIND_LABELS: Record<string, string> = {
  tab: tk('Aba'),
  card: tk('Card'),
  pr: tk('PR'),
  machine: tk('Máquina'),
  agent_release: tk('Versão do agent'),
};

/** Each kind's events, as translation keys. `gone` reads differently per kind, so the table is per kind. */
const EVENT_LABELS: Record<string, Record<string, string>> = {
  tab: {
    finished: tk('terminar'),
    waiting_input: tk('esperar resposta'),
    waiting_permission: tk('pedir permissão'),
    idle: tk('ficar ociosa'),
    error: tk('der erro'),
    blocked: tk('travar'),
    auth_required: tk('pedir login'),
    trust_prompt: tk('pedir confiança na pasta'),
    waiting_background: tk('esperar tarefa em segundo plano'),
    gone: tk('for fechada'),
  },
  card: {
    moved: tk('mudar de coluna'),
    gone: tk('for apagado'),
  },
  pr: {
    opened: tk('for aberto'),
    merged: tk('for mergeado'),
    closed: tk('for fechado'),
    ci_failed: tk('o CI falhar'),
    ci_passed: tk('o CI passar'),
    deploy_ok: tk('o deploy concluir'),
    deploy_failed: tk('o deploy falhar'),
    release_ok: tk('a release sair'),
    release_failed: tk('a release falhar'),
  },
  machine: {
    online: tk('ficar online'),
    offline: tk('ficar offline'),
    gone: tk('for removida'),
  },
  agent_release: {
    published: tk('for publicada'),
  },
};

/** "Aba", "PR"…; the raw kind when this app does not know it. */
export function watchKindLabel(kind: string): string {
  const label = KIND_LABELS[kind];
  return label ? t(label) : kind;
}

/** One event in words ("for mergeado"); the raw name when this app does not know it. */
export function watchEventLabel(kind: string, event: string): string {
  const label = EVENT_LABELS[kind]?.[event];
  return label ? t(label) : event;
}

/** "Quando for mergeado, o CI falhar"; empty when the watch lists no event. */
export function watchEventsText(watch: Pick<ChatWatch, 'kind' | 'events'>): string {
  if (watch.events.length === 0) return '';
  return t('Quando {{events}}', { events: watch.events.map((e) => watchEventLabel(watch.kind, e)).join(', ') });
}

/** "até 14:32" today, "até 23/10, 09:05" on another day; empty for a date it cannot read. */
export function watchUntilLabel(expiresAt: string, now = new Date()): string {
  const end = new Date(expiresAt);
  if (Number.isNaN(end.getTime())) return '';
  if (end.toDateString() === now.toDateString()) return t('até {{time}}', { time: formatTime(end) });
  return t('até {{date}}', { date: formatDateTime(end, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) });
}

/** The list without `id`, and where it was (to put it back if the cancel fails); `index` is -1 when absent. */
export function withoutWatch(list: ChatWatch[], id: string): { list: ChatWatch[]; index: number; watch: ChatWatch | null } {
  const index = list.findIndex((w) => w.id === id);
  if (index < 0) return { list, index, watch: null };
  return { list: list.filter((w) => w.id !== id), index, watch: list[index]! };
}
