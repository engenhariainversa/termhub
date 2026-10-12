import { Prisma } from '../../generated/prisma/client.js';

/**
 * Where a decision holds (TER-1014): only in the chat conversation it was taken in, only in its
 * project, or everywhere for its user. With `expires_at`, it also stops holding at that moment.
 */
export const DECISION_SCOPES = ['conversation', 'project', 'user'] as const;
export type DecisionScope = (typeof DECISION_SCOPES)[number];

/**
 * Where a decision is about to be read: a card's project and conversation when it would back an
 * answer, or a search's. `projectId` undefined means "any project" (a search not held to one);
 * `conversationId` undefined or null means no conversation, so a `conversation` decision never holds.
 */
export interface DecisionPlace {
  projectId?: string | null;
  conversationId?: string | null;
}

/** The scope a row without one gets (rows written before TER-1014, or by the previous release during
 *  a blue/green overlap): a note tied to a project holds in that project, anything else everywhere. */
export const inferScope = (projectId: string | null): DecisionScope => (projectId ? 'project' : 'user');

export const isExpired = (expiresAt: string | null, now = new Date()): boolean => expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();

/** Whether a decision of `scope` holds at `place` (the pure twin of `scopeHoldsSql`). */
export function scopeHolds(row: { scope: DecisionScope; project_id: string | null; conversation_id: string | null }, place: DecisionPlace): boolean {
  if (row.scope === 'user') return true;
  if (row.scope === 'project') return place.projectId === undefined || (row.project_id !== null && row.project_id === place.projectId);
  return !!place.conversationId && row.conversation_id === place.conversationId;
}

/** Not expired and in scope: the only decisions that may serve as a precedent at `place`. */
export const holdsAt = (row: { scope: DecisionScope; project_id: string | null; conversation_id: string | null; expires_at: string | null }, place: DecisionPlace, now = new Date()): boolean =>
  !isExpired(row.expires_at, now) && scopeHolds(row, place);

/**
 * SQL for `holdsAt` over one aliased row: `scope`, `project_id`, `conversation_id` and `expires_at`
 * are the row's column expressions. `includeExpired` keeps expired rows (a search that asks for them).
 */
export function holdsAtSql(cols: { scope: Prisma.Sql; projectId: Prisma.Sql; conversationId: Prisma.Sql; expiresAt: Prisma.Sql }, place: DecisionPlace, includeExpired = false): Prisma.Sql {
  const notExpired = includeExpired ? Prisma.sql`TRUE` : Prisma.sql`(${cols.expiresAt} IS NULL OR ${cols.expiresAt} > now())`;
  const project = place.projectId === undefined ? Prisma.sql`TRUE` : Prisma.sql`${cols.projectId} = ${place.projectId}`;
  const conversation = place.conversationId ? Prisma.sql`${cols.conversationId} = ${place.conversationId}` : Prisma.sql`FALSE`;
  return Prisma.sql`(${notExpired} AND (${cols.scope} = 'user' OR (${cols.scope} = 'project' AND ${project}) OR (${cols.scope} = 'conversation' AND ${conversation})))`;
}
