import { i18n, tk } from '../../i18n';
import { formatDateTime, formatTime } from '../../lib/format';
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

/** The events of every kind (server: `chat/watches/kinds.ts`), in words. */
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

/** The kind in words; a kind a newer server adds shows as it came. */
export const watchKindLabel = (kind: string): string => (Object.hasOwn(WATCH_KIND_LABEL, kind) ? i18n.t(WATCH_KIND_LABEL[kind]!) : kind);

/** "merge, CI vermelho": the events, each in words, an unknown one as it came. */
export const watchEventsLabel = (events: string[]): string => events.map((e) => (Object.hasOwn(WATCH_EVENT_LABEL, e) ? i18n.t(WATCH_EVENT_LABEL[e]!) : e)).join(', ');

/** A time today as "14:32", another day with its date. */
const timeOrDateTime = (at: Date, now: Date): string =>
  at.toDateString() === now.toDateString() ? formatTime(at) : formatDateTime(at, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * A reminder (TER-1100) in words: "às 18:00 · a cada 10 min · até 20:00". Its only event is its time, so
 * the "avisa em" of the other watches would say nothing; `next_at` says when.
 */
export function reminderDetails(w: Pick<ChatWatch, 'next_at' | 'every_minutes' | 'recurring' | 'expires_at'>, now = new Date()): string {
  const next = w.next_at ? new Date(w.next_at) : null;
  return [
    next && !Number.isNaN(next.getTime()) ? i18n.t('às {{time}}', { time: timeOrDateTime(next, now) }) : null,
    w.every_minutes ? i18n.t('a cada {{n}} min', { n: w.every_minutes }) : null,
    w.recurring ? watchUntilLabel(w, now) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "até 14:32" today, or "até <data e hora>": a watch can last for days, unlike a grant. */
export function watchUntilLabel(w: Pick<ChatWatch, 'expires_at'>, now = new Date()): string {
  const end = new Date(w.expires_at);
  if (end.toDateString() === now.toDateString()) return i18n.t('até {{time}}', { time: formatTime(end) });
  return i18n.t('até {{time}}', { time: formatDateTime(end, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) });
}
