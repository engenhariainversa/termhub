import { Prisma } from '../generated/prisma/client.js';

/**
 * Where a decision or a concierge note stands (TER-1013), as the Memória screen shows it:
 * `current` (vigente), `outdated` (desatualizada: `expires_at` reached), `wrong` (errada) or
 * `superseded` (substituída por outro item, whose `supersedes` names this one). Anything but `current`
 * is out of the default search and never a precedent.
 */
export type MemoryStatus = 'current' | 'outdated' | 'wrong' | 'superseded';

export const MEMORY_STATUSES = ['current', 'outdated', 'wrong', 'superseded'] as const satisfies readonly MemoryStatus[];

/** The status columns, as both repositories read them. */
export interface StatusColumns {
  expires_at: Date | null;
  wrong_at: Date | null;
  superseded_at: Date | null;
}

/** The most decisive mark wins: errada, then substituída, then desatualizada. */
export function statusOf(r: StatusColumns, now = new Date()): MemoryStatus {
  if (r.wrong_at) return 'wrong';
  if (r.superseded_at) return 'superseded';
  if (r.expires_at && r.expires_at.getTime() <= now.getTime()) return 'outdated';
  return 'current';
}

/** `statusOf` in SQL, for the row alias `a` (`d` for decisions, `m` for memory items): true when the
 *  row is current — the condition every default search and precedent query adds. */
export const currentSql = (a: 'd' | 'm'): Prisma.Sql =>
  Prisma.raw(`(${a}.wrong_at IS NULL AND ${a}.superseded_at IS NULL AND (${a}.expires_at IS NULL OR ${a}.expires_at > now()))`);

/** Which rows a search may return besides the current ones: every status (`includeInactive`, TER-1013)
 *  or only the replaced ones too (`includeSuperseded`, TER-1015). */
export interface StatusSearch {
  includeInactive?: boolean;
  includeSuperseded?: boolean;
}

/** A search's status condition for the row alias `a`: `currentSql` by default, nothing with
 *  `includeInactive`, and current-or-superseded with `includeSuperseded`. */
export const statusSearchSql = (a: 'd' | 'm', opts: StatusSearch): Prisma.Sql =>
  opts.includeInactive
    ? Prisma.raw('TRUE')
    : opts.includeSuperseded
      ? Prisma.raw(`(${a}.wrong_at IS NULL AND (${a}.expires_at IS NULL OR ${a}.expires_at > now()))`)
      : currentSql(a);
