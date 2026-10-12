import type { MemoryTrust } from '../db/repositories/memory-items.js';
import type { MemoryRefKind } from './refs.js';

/**
 * Authority weights for `search_memory` (TER-1012), applied after reciprocal rank fusion: the fused
 * score is multiplied by every factor that applies to a hit, so similarity still leads and authority
 * breaks the close calls. Every weight lives here, and only here.
 */
export const AUTHORITY_WEIGHTS = {
  /** A decision the person answered themselves (`trust: 'person'`). */
  personDecision: 1.5,
  /** A note still in force: neither superseded nor expired. */
  currentNote: 1.3,
  /** A lesson the person marked verified. */
  verifiedLesson: 1.3,
  /** A hit from the project the query was made in. */
  sameProject: 1.25,
  /** Kinds that record what happened rather than what was decided. */
  lowKinds: { action: 0.7, task: 0.7 } as Partial<Record<MemoryRefKind, number>>,
  /** A superseded or expired hit: its score is multiplied by this, then held to at most `inactiveCap`
   *  of the best current hit's score, so it never comes first while a current hit exists. */
  inactive: 0.5,
  inactiveCap: 0.5,
} as const;

export interface AuthorityHit {
  key: string;
  /** The fused (RRF) score. */
  score: number;
  kind: MemoryRefKind;
  trust: MemoryTrust;
  projectId: string | null;
  verified?: boolean;
  /** Superseded by another item, or past its `expires_at`. */
  inactive: boolean;
}

/** The factor `AUTHORITY_WEIGHTS` gives one hit; `queryProjectId` is the project the search was held to, if any. */
export function authorityFactor(hit: Omit<AuthorityHit, 'key' | 'score'>, queryProjectId: string | undefined): number {
  const w = AUTHORITY_WEIGHTS;
  let f = 1;
  if (hit.kind === 'decision' && hit.trust === 'person') f *= w.personDecision;
  if (hit.kind === 'note' && !hit.inactive) f *= w.currentNote;
  if (hit.kind === 'lesson' && hit.verified) f *= w.verifiedLesson;
  if (queryProjectId && hit.projectId === queryProjectId) f *= w.sameProject;
  f *= w.lowKinds[hit.kind] ?? 1;
  if (hit.inactive) f *= w.inactive;
  return f;
}

/**
 * Re-ranks fused hits by authority: each score times `authorityFactor`, then every inactive hit capped
 * at `inactiveCap` × the best current hit's score. Best first; equal scores keep the fused order.
 */
export function rankByAuthority<T extends AuthorityHit>(hits: T[], queryProjectId: string | undefined): (T & { authority: number })[] {
  const weighted = hits.map((h, i) => ({ h, i, s: h.score * authorityFactor(h, queryProjectId) }));
  const bestCurrent = Math.max(0, ...weighted.filter((w) => !w.h.inactive).map((w) => w.s));
  if (bestCurrent > 0) {
    const cap = bestCurrent * AUTHORITY_WEIGHTS.inactiveCap;
    for (const w of weighted) if (w.h.inactive) w.s = Math.min(w.s, cap);
  }
  return weighted.sort((a, b) => b.s - a.s || a.i - b.i).map((w) => ({ ...w.h, authority: w.s }));
}

/**
 * Whether a decision or item is no longer in force: marked on the Memória screen (`status` other than
 * `current`: desatualizada, errada or substituída, TER-1013), superseded (`superseded_at` set, TER-1015)
 * or past its `expires_at` (TER-1014). Read structurally, so a row without those columns counts as current.
 */
export function isInactive(row: object, now: Date = new Date()): boolean {
  const r = row as { status?: string; superseded_at?: string | Date | null; expires_at?: string | Date | null };
  if (r.status !== undefined && r.status !== 'current') return true;
  if (r.superseded_at) return true;
  return r.expires_at != null && new Date(r.expires_at).getTime() <= now.getTime();
}
