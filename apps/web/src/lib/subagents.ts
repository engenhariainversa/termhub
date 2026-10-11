import { i18n, tk } from '../i18n';
import type { SubagentStatus, SubagentView } from './types';

/** The subagents panel (spec 2026-09-26 §4): status line for each row (pt-BR keys: translate with `t()` where shown). */
export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
  running: tk('rodando'),
  stopping: tk('cancelando…'),
  completed: tk('concluído'),
  failed: tk('falhou'),
  stopped: tk('cancelado'),
  interrupted: tk('interrompido'),
};

/** Still doing something (or being asked to stop) — the only ones the toolbar button counts. */
export const isActive = (s: SubagentView): boolean => s.status === 'running' || s.status === 'stopping';


/**
 * How long a row has been at it: "há N min" while it is still running (or being cancelled), "levou N
 * min" once it ended — both "menos de 1 min" under a minute, prefixed the same way ("há menos de 1
 * min" / "levou menos de 1 min").
 */
export function elapsedLabel(s: SubagentView, now: number): string {
  const running = isActive(s);
  const start = new Date(s.started_at).getTime();
  const end = running ? now : s.ended_at !== null ? new Date(s.ended_at).getTime() : now;
  const ms = Math.max(0, end - start);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return running ? i18n.t('há menos de 1 min') : i18n.t('levou menos de 1 min');
  return running ? i18n.t('há {{n}} min', { n: minutes }) : i18n.t('levou {{n}} min', { n: minutes });
}

/** Replaces a row by id, or prepends a new one — the panel's own newest-first order. */
export function upsertSubagent(list: SubagentView[], s: SubagentView): SubagentView[] {
  const idx = list.findIndex((x) => x.id === s.id);
  if (idx === -1) return [s, ...list];
  const next = list.slice();
  next[idx] = s;
  return next;
}
