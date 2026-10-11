// The subagents panel (spec 2026-09-26 §4): a line-for-line port of the web's `lib/subagents.ts`
// (design spec §6) — same labels, same elapsed-time wording, same list op, so the two clients read
// identically.
import { t } from '@/i18n';
import type { SubagentStatus, SubagentView } from './types';

/** The subagents panel (spec 2026-09-26 §4): the status line for each row, in the language the app
 * shows when it is read (each entry is a getter). */
export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
  get running() { return t('rodando'); },
  get stopping() { return t('cancelando…'); },
  get completed() { return t('concluído'); },
  get failed() { return t('falhou'); },
  get stopped() { return t('cancelado'); },
  get interrupted() { return t('interrompido'); },
};

/** Still doing something (or being asked to stop) — the only ones the header button counts. */
export const isActive = (s: SubagentView): boolean => s.status === 'running' || s.status === 'stopping';

/** Whole minutes, or null under one ("menos de 1 min"). */
const wholeMinutes = (ms: number): number | null => {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? null : minutes;
};

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
  const n = wholeMinutes(ms);
  if (running) return n === null ? t('há menos de 1 min') : t('há {{n}} min', { n });
  return n === null ? t('levou menos de 1 min') : t('levou {{n}} min', { n });
}

/** Replaces a row by id, or prepends a new one — the panel's own newest-first order. */
export function upsertSubagent(list: SubagentView[], s: SubagentView): SubagentView[] {
  const idx = list.findIndex((x) => x.id === s.id);
  if (idx === -1) return [s, ...list];
  const next = list.slice();
  next[idx] = s;
  return next;
}
