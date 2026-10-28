import { i18n, tk } from '../../i18n';
import { formatDateTime, formatList, formatTime } from '../../lib/format';
import type { ChatWatch } from '../../lib/types';

/** What each kind of watch follows (TER-1099), as the "Acompanhando" strip names it. */
const WATCH_KIND_LABEL: Record<string, string> = {
  tab: tk('Aba'),
  card: tk('Card'),
  pr: tk('PR'),
  machine: tk('Máquina'),
  agent_release: tk('Versão do agent'),
  reminder: tk('Lembrete'),
};

/** The events of every kind (server: `chat/watches/kinds.ts`), in words: the detailed list, shown unfolded. */
const WATCH_EVENT_LABEL: Record<string, string> = {
  // tab
  finished: tk('terminou'),
  waiting_input: tk('esperando resposta'),
  waiting_permission: tk('pedindo permissão'),
  idle: tk('sem atividade'),
  error: tk('erro'),
  blocked: tk('bloqueio'),
  auth_required: tk('pedindo login'),
  trust_prompt: tk('pedindo confiança na pasta'),
  waiting_background: tk('esperando tarefa em segundo plano'),
  gone: tk('sumiu'),
  // card
  moved: tk('mudou de coluna'),
  // pr
  opened: tk('abriu'),
  merged: tk('merge'),
  closed: tk('fechou'),
  ci_failed: tk('CI vermelho'),
  ci_passed: tk('CI verde'),
  merge_blocked: tk('merge parado'),
  deploy_ok: tk('deploy concluído'),
  deploy_failed: tk('deploy falhou'),
  release_ok: tk('release concluída'),
  release_failed: tk('release falhou'),
  // machine
  online: tk('online'),
  offline: tk('offline'),
  // agent_release
  published: tk('publicou'),
};

/**
 * TER-1115: the events in plain words, for "te aviso quando terminar, perguntar algo ou der erro". Several
 * stops of a tab read the same to the person (a question, a permission, a login are all "perguntar algo"),
 * and the minor ones (`idle`, `gone`, background work) only show when nothing else is asked. Per kind:
 * `gone` reads differently on each.
 */
const PLAIN_EVENT: Record<string, Record<string, string>> = {
  tab: {
    finished: tk('terminar'),
    waiting_input: tk('perguntar algo'),
    waiting_permission: tk('perguntar algo'),
    auth_required: tk('perguntar algo'),
    trust_prompt: tk('perguntar algo'),
    error: tk('der erro'),
    blocked: tk('der erro'),
    idle: tk('ficar parada'),
    waiting_background: tk('deixar algo rodando'),
    gone: tk('for fechada'),
  },
  card: { moved: tk('mudar de coluna'), gone: tk('for apagado') },
  pr: {
    opened: tk('o PR abrir'),
    merged: tk('o PR for mesclado'),
    closed: tk('o PR for fechado'),
    ci_failed: tk('o CI falhar'),
    ci_passed: tk('o CI passar'),
    merge_blocked: tk('o merge ficar esperando você'),
    deploy_ok: tk('o deploy terminar'),
    deploy_failed: tk('o deploy falhar'),
    release_ok: tk('a release sair'),
    release_failed: tk('a release falhar'),
  },
  machine: { online: tk('ficar online'), offline: tk('ficar offline'), gone: tk('for removida') },
  agent_release: { published: tk('a versão sair') },
};
const MINOR_EVENTS = new Set(['idle', 'gone', 'waiting_background']);

/** TER-1115: what already happened, in the past ("terminou às 14:32"). */
const PAST_EVENT: Record<string, Record<string, string>> = {
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
    merge_blocked: tk('merge ficou esperando você'),
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

/** The kind in words; a kind a newer server adds shows as it came. */
export const watchKindLabel = (kind: string): string => (Object.hasOwn(WATCH_KIND_LABEL, kind) ? i18n.t(WATCH_KIND_LABEL[kind]!) : kind);

/** "merge, CI vermelho": the events, each in words, an unknown one as it came. */
export const watchEventsLabel = (events: string[]): string => events.map((e) => (Object.hasOwn(WATCH_EVENT_LABEL, e) ? i18n.t(WATCH_EVENT_LABEL[e]!) : e)).join(', ');

/** What it follows: "Aba api", "Máquina jarvis"; a PR's own name already says "PR #511". */
const targetLabel = (w: Pick<ChatWatch, 'kind' | 'label'>): string => (w.kind === 'pr' ? w.label : `${watchKindLabel(w.kind)} ${w.label}`);

/** "terminar, perguntar algo ou der erro" (TER-1115); empty when it lists no event. */
export function watchPlainEvents(w: Pick<ChatWatch, 'kind' | 'events'>): string {
  const major = w.events.filter((e) => !MINOR_EVENTS.has(e));
  const shown = major.length > 0 ? major : w.events;
  const words = [...new Set(shown.map((e) => lookup(PLAIN_EVENT, w.kind, e) ?? e))];
  return formatList(words.map((k) => i18n.t(k)), 'disjunction');
}

/** A time today as "14:32", tomorrow as "amanhã 14:32", another day with its date. */
function whenLabel(at: Date, now: Date): string {
  if (at.toDateString() === now.toDateString()) return formatTime(at);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) return i18n.t('amanhã {{time}}', { time: formatTime(at) });
  return formatDateTime(at, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const dateOf = (iso: string | null | undefined): Date | null => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** "até 14:32" today, "até amanhã 16:00", or "até <data e hora>": a watch can last for days. */
export function watchUntilLabel(w: Pick<ChatWatch, 'expires_at'>, now = new Date()): string {
  const end = dateOf(w.expires_at);
  return end ? i18n.t('até {{time}}', { time: whenLabel(end, now) }) : '';
}

/**
 * The one line the person reads (TER-1115). The concierge's own `summary` when it wrote one; else, for a
 * watch made before it, "Aba api: te aviso quando terminar…" composed here. A reminder reads
 * "Às 18:00: conferir o build". Never the concierge's note.
 */
export function watchHeadline(w: ChatWatch, now = new Date()): string {
  if (w.kind === 'reminder') {
    const next = dateOf(w.next_at);
    const what = w.summary ?? '';
    if (!next) return what || watchKindLabel('reminder');
    const at = whenLabel(next, now);
    return what ? i18n.t('Às {{time}}: {{what}}', { time: at, what }) : i18n.t('Lembrete às {{time}}', { time: at });
  }
  if (w.summary) return w.summary;
  const target = targetLabel(w);
  const events = watchPlainEvents(w);
  return events ? i18n.t('{{target}}: te aviso quando {{events}}', { target, events }) : target;
}

/**
 * What already happened and how it stands, newest first: "trabalhando agora · terminou às 14:32 · avisou 2×
 * · até amanhã 16:00". A tab's state now comes from the server (`target_state`); a reminder says its pace.
 */
export function watchStatus(w: ChatWatch, now = new Date()): string {
  const parts: string[] = [];
  if (w.kind === 'tab' && w.target_state) parts.push(w.target_state === 'working' ? i18n.t('trabalhando agora') : i18n.t('parada agora'));
  const fired = dateOf(w.last_fired_at);
  if (w.last_event && fired) {
    const what = lookup(PAST_EVENT, w.kind, w.last_event);
    parts.push(i18n.t('{{what}} às {{time}}', { what: what ? i18n.t(what) : w.last_event, time: whenLabel(fired, now) }));
  }
  if (w.fire_count > 1) parts.push(i18n.t('avisou {{n}}×', { n: w.fire_count }));
  if (w.kind === 'reminder') {
    if (w.every_minutes) parts.push(i18n.t('a cada {{n}} min', { n: w.every_minutes }));
    if (w.recurring) parts.push(watchUntilLabel(w, now));
  } else {
    parts.push(watchUntilLabel(w, now));
  }
  return parts.filter(Boolean).join(' · ');
}

/** The detailed list, shown only unfolded: what it follows, every event it asked for, and whether it repeats. */
export function watchDetails(w: ChatWatch): string {
  if (w.kind === 'reminder') return w.recurring ? i18n.t('Repete até o fim do prazo') : i18n.t('Uma vez');
  return [
    targetLabel(w),
    w.events.length > 0 ? i18n.t('avisa em: {{events}}', { events: watchEventsLabel(w.events) }) : null,
    w.recurring ? i18n.t('toda vez') : i18n.t('uma vez'),
  ]
    .filter(Boolean)
    .join(' · ');
}
