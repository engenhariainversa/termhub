// What the "Acompanhando" strip says of a concierge watch (TER-1099, TER-1115): the pieces are structured on
// the wire (`kind`, `events`, `last_event`, `target_state`) so the phone composes them in its own language;
// `label` (the target's name) and `summary` (the concierge's sentence for the person) are data and are shown
// as they come. The concierge's `note` is its own and never shows. A kind or an event a newer server adds
// reads as its raw name rather than breaking the strip.
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
  reminder: tk('Lembrete'),
};

/** Each kind's events, as translation keys: the detailed list, shown unfolded. Per kind: `gone` reads differently on each. */
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

/**
 * TER-1115: the events in plain words, for "te aviso quando terminar, perguntar algo ou der erro". A tab's
 * question, permission and login all read "perguntar algo"; the minor stops (`idle`, `gone`, background
 * work) show only when nothing else is asked. Other kinds read as the detailed list.
 */
const PLAIN_TAB_EVENTS: Record<string, string> = {
  finished: tk('terminar'),
  waiting_input: tk('perguntar algo'),
  waiting_permission: tk('perguntar algo'),
  auth_required: tk('perguntar algo'),
  trust_prompt: tk('perguntar algo'),
  error: tk('der erro'),
  blocked: tk('der erro'),
};
const MINOR_EVENTS = new Set(['idle', 'gone', 'waiting_background']);

/** TER-1115: what already happened, in the past ("terminou às 14:32"). */
const PAST_EVENTS: Record<string, Record<string, string>> = {
  tab: {
    finished: tk('terminou'),
    waiting_input: tk('fez uma pergunta'),
    waiting_permission: tk('pediu permissão'),
    auth_required: tk('pediu login'),
    trust_prompt: tk('pediu confiança na pasta'),
    error: tk('deu erro'),
    blocked: tk('travou'),
    idle: tk('ficou parada'),
    waiting_background: tk('terminou com algo rodando'),
    gone: tk('foi fechada'),
  },
  card: { moved: tk('mudou de coluna'), gone: tk('foi apagado') },
  pr: {
    opened: tk('PR aberto'),
    merged: tk('PR mesclado'),
    closed: tk('PR fechado'),
    ci_failed: tk('CI falhou'),
    ci_passed: tk('CI passou'),
    deploy_ok: tk('deploy concluído'),
    deploy_failed: tk('deploy falhou'),
    release_ok: tk('release concluída'),
    release_failed: tk('release falhou'),
  },
  machine: { online: tk('ficou online'), offline: tk('ficou offline'), gone: tk('foi removida') },
  agent_release: { published: tk('versão publicada') },
  reminder: { due: tk('avisou') },
};

const lookup = (table: Record<string, Record<string, string>>, kind: string, event: string): string | null => {
  const byKind = Object.hasOwn(table, kind) ? table[kind]! : null;
  return byKind && Object.hasOwn(byKind, event) ? byKind[event]! : null;
};

/** "Aba", "PR"…; the raw kind when this app does not know it. */
export function watchKindLabel(kind: string): string {
  const label = Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind] : undefined;
  return label ? t(label) : kind;
}

/** One event in words ("for mergeado"); the raw name when this app does not know it. */
export function watchEventLabel(kind: string, event: string): string {
  const label = lookup(EVENT_LABELS, kind, event);
  return label ? t(label) : event;
}

/** "Quando for mergeado, o CI falhar": the detailed list; empty when the watch lists no event. */
export function watchEventsText(watch: Pick<ChatWatch, 'kind' | 'events'>): string {
  if (watch.events.length === 0) return '';
  return t('Quando {{events}}', { events: watch.events.map((e) => watchEventLabel(watch.kind, e)).join(', ') });
}

/** "a, b ou c" (Hermes has no `Intl.ListFormat`). */
function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return t('{{list}} ou {{last}}', { list: items.slice(0, -1).join(', '), last: items[items.length - 1] });
}

/** "terminar, perguntar algo ou der erro" (TER-1115); empty when it lists no event. */
export function watchPlainEvents(watch: Pick<ChatWatch, 'kind' | 'events'>): string {
  const major = watch.events.filter((e) => !MINOR_EVENTS.has(e));
  const shown = major.length > 0 ? major : watch.events;
  const words = shown.map((e) => {
    const plain = watch.kind === 'tab' && Object.hasOwn(PLAIN_TAB_EVENTS, e) ? PLAIN_TAB_EVENTS[e] : undefined;
    return plain ? t(plain) : watchEventLabel(watch.kind, e);
  });
  return orList([...new Set(words)]);
}

/** A time today as "14:32", tomorrow as "amanhã 14:32", another day with its date. */
function whenLabel(at: Date, now: Date): string {
  if (at.toDateString() === now.toDateString()) return formatTime(at);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) return t('amanhã {{time}}', { time: formatTime(at) });
  return formatDateTime(at, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const dateOf = (iso: string | null | undefined): Date | null => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** "até 14:32" today, "até amanhã 16:00", "até 23/10, 09:05" on another day; empty for a date it cannot read. */
export function watchUntilLabel(expiresAt: string, now = new Date()): string {
  const end = dateOf(expiresAt);
  return end ? t('até {{date}}', { date: whenLabel(end, now) }) : '';
}

/** What it follows: "Aba api", "Máquina jarvis"; a PR's own name already says "PR #511". */
const targetLabel = (watch: Pick<ChatWatch, 'kind' | 'label'>): string => (watch.kind === 'pr' ? watch.label : `${watchKindLabel(watch.kind)} ${watch.label}`);

/**
 * The one line the person reads (TER-1115): the concierge's own `summary`; for a watch made before it, "Aba
 * api: te aviso quando terminar…" composed here. A reminder reads "Às 18:00: conferir o build". Never the note.
 */
export function watchHeadline(watch: ChatWatch, now = new Date()): string {
  if (watch.kind === 'reminder') {
    const next = dateOf(watch.next_at);
    const what = watch.summary ?? '';
    if (!next) return what || watchKindLabel('reminder');
    const at = whenLabel(next, now);
    return what ? t('Às {{time}}: {{what}}', { time: at, what }) : t('Lembrete às {{time}}', { time: at });
  }
  if (watch.summary) return watch.summary;
  const target = targetLabel(watch);
  const events = watchPlainEvents(watch);
  return events ? t('{{target}}: te aviso quando {{events}}', { target, events }) : target;
}

/**
 * What already happened and how it stands: "trabalhando agora · terminou às 14:32 · avisou 2× · até amanhã
 * 16:00". A tab's state now comes from the server (`target_state`); a reminder says its pace.
 */
export function watchStatus(watch: ChatWatch, now = new Date()): string {
  const parts: string[] = [];
  if (watch.kind === 'tab' && watch.target_state) parts.push(watch.target_state === 'working' ? t('trabalhando agora') : t('parada agora'));
  const fired = dateOf(watch.last_fired_at);
  if (watch.last_event && fired) {
    const what = lookup(PAST_EVENTS, watch.kind, watch.last_event);
    parts.push(t('{{what}} às {{time}}', { what: what ? t(what) : watch.last_event, time: whenLabel(fired, now) }));
  }
  if (watch.fire_count > 1) parts.push(t('avisou {{n}}×', { n: watch.fire_count }));
  if (watch.kind === 'reminder') {
    if (watch.every_minutes) parts.push(t('a cada {{n}} min', { n: watch.every_minutes }));
    if (watch.recurring) parts.push(watchUntilLabel(watch.expires_at, now));
  } else {
    parts.push(watchUntilLabel(watch.expires_at, now));
  }
  return parts.filter(Boolean).join(' · ');
}

/** The detailed list, shown only unfolded: what it follows, every event it asked for, and whether it repeats. */
export function watchDetails(watch: ChatWatch): string {
  if (watch.kind === 'reminder') return watch.recurring ? t('Repete até o fim do prazo') : t('Uma vez');
  return [targetLabel(watch), watchEventsText(watch), watch.recurring ? t('Recorrente') : t('Uma vez')].filter(Boolean).join(' · ');
}

/** The list without `id`, and where it was (to put it back if the cancel fails); `index` is -1 when absent. */
export function withoutWatch(list: ChatWatch[], id: string): { list: ChatWatch[]; index: number; watch: ChatWatch | null } {
  const index = list.findIndex((w) => w.id === id);
  if (index < 0) return { list, index, watch: null };
  return { list: list.filter((w) => w.id !== id), index, watch: list[index]! };
}
