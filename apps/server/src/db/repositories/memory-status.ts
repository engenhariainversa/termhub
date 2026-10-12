import type { PrismaClient } from '../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { MemoryStatus } from '../../memory/status.js';

/** An item the Memória screen can mark (TER-1013): a remembered decision or a concierge note. */
export interface StatusTarget {
  kind: 'decision' | 'note';
  id: string;
}

export const targetRef = (t: StatusTarget): string => `${t.kind}:${t.id}`;

/** Why `setStatus` wrote nothing: the item (or the one picked to replace it) is not this owner's
 *  decision/note, the item would replace itself, the replacement already replaces another item, or
 *  the replacement is itself replaced by this item (a two-item loop). */
export type SetStatusResult = 'ok' | 'not_found' | 'replacement_not_found' | 'self' | 'replacement_taken' | 'cycle';

/** The item that replaces another, as the list shows it ("substituída por …"). */
export interface Superseder {
  ref: string;
  title: string;
}

type Tx = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

/** The row's `supersedes`, after locking it; `undefined` when it is not this owner's decision/note. */
async function lockTarget(tx: Tx, ownerId: string, t: StatusTarget): Promise<{ supersedes: string | null } | undefined> {
  const rows =
    t.kind === 'decision'
      ? await tx.$queryRaw<{ supersedes: string | null }[]>`SELECT supersedes FROM "chat_decisions" WHERE id = ${t.id} AND user_id = ${ownerId} FOR UPDATE`
      : await tx.$queryRaw<{ supersedes: string | null }[]>`SELECT supersedes FROM "memory_items" WHERE id = ${t.id} AND owner_id = ${ownerId} AND kind = 'note' FOR UPDATE`;
  return rows[0];
}

/**
 * "Desatualizada", "Errada", "Substituída por…" and their undo on the Memória screen (TER-1013), for
 * decisions (`chat_decisions`) and concierge notes (`memory_items`, kind `note`) alike. Both tables in
 * one transaction, since a replacement links two rows that may live in different tables.
 */
export class MemoryStatusRepository {
  constructor(private db: PrismaClient) {}

  /**
   * Puts the owner's item in `status`, whatever it was before: each mark is cleared first, so the
   * statuses never pile up and `current` is the undo of all three. `outdated` sets `expires_at` to now;
   * leaving it clears an `expires_at` already reached but keeps one still in the future (a validity
   * set elsewhere). `superseded` needs `by`, the item that replaces this one, whose `supersedes` gets
   * this item's ref; leaving `superseded` clears the `supersedes` that pointed here.
   */
  async setStatus(ownerId: string, target: StatusTarget, status: MemoryStatus, by?: StatusTarget): Promise<SetStatusResult> {
    const ref = targetRef(target);
    return this.db.$transaction(async (tx) => {
      const row = await lockTarget(tx, ownerId, target);
      if (!row) return 'not_found';
      if (status === 'superseded') {
        if (!by) return 'replacement_not_found';
        if (by.kind === target.kind && by.id === target.id) return 'self';
        const replacement = await lockTarget(tx, ownerId, by);
        if (!replacement) return 'replacement_not_found';
        if (replacement.supersedes !== null && replacement.supersedes !== ref) return 'replacement_taken';
        if (row.supersedes === targetRef(by)) return 'cycle';
      }

      await tx.$executeRaw`UPDATE "chat_decisions" SET supersedes = NULL WHERE user_id = ${ownerId} AND supersedes = ${ref}`;
      await tx.$executeRaw`UPDATE "memory_items" SET supersedes = NULL WHERE owner_id = ${ownerId} AND kind = 'note' AND supersedes = ${ref}`;

      const set = Prisma.sql`
        wrong_at = ${status === 'wrong' ? Prisma.sql`now()` : Prisma.sql`NULL`},
        superseded_at = ${status === 'superseded' ? Prisma.sql`now()` : Prisma.sql`NULL`},
        expires_at = ${status === 'outdated' ? Prisma.sql`now()` : Prisma.sql`CASE WHEN expires_at <= now() THEN NULL ELSE expires_at END`}`;
      if (target.kind === 'decision') await tx.$executeRaw`UPDATE "chat_decisions" SET ${set} WHERE id = ${target.id} AND user_id = ${ownerId}`;
      else await tx.$executeRaw`UPDATE "memory_items" SET ${set} WHERE id = ${target.id} AND owner_id = ${ownerId} AND kind = 'note'`;

      if (status === 'superseded' && by) {
        if (by.kind === 'decision') await tx.$executeRaw`UPDATE "chat_decisions" SET supersedes = ${ref} WHERE id = ${by.id} AND user_id = ${ownerId}`;
        else await tx.$executeRaw`UPDATE "memory_items" SET supersedes = ${ref} WHERE id = ${by.id} AND owner_id = ${ownerId} AND kind = 'note'`;
      }
      return 'ok';
    });
  }

  /** For each of `refs`, the owner's decision or note whose `supersedes` names it, if any: the list's
   *  "substituída por …" line. A decision's title is its question, a note's its title. */
  async supersedersOf(ownerId: string, refs: string[]): Promise<Map<string, Superseder>> {
    if (refs.length === 0) return new Map();
    const rows = await this.db.$queryRaw<{ supersedes: string; ref: string; title: string }[]>`
      SELECT supersedes, 'decision:' || id AS ref, question AS title FROM "chat_decisions"
        WHERE user_id = ${ownerId} AND supersedes IN (${Prisma.join(refs)})
      UNION ALL
      SELECT supersedes, 'note:' || id AS ref, title FROM "memory_items"
        WHERE owner_id = ${ownerId} AND kind = 'note' AND supersedes IN (${Prisma.join(refs)})`;
    return new Map(rows.map((r) => [r.supersedes, { ref: r.ref, title: r.title }]));
  }
}
