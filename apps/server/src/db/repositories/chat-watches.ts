import type { PrismaClient } from '../prisma.js';
import type { ChatWatch as PrismaWatch, ChatWatchFire as PrismaFire } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { isWatchKind, type WatchKind, type WatchParams, type WatchStatus } from '../../chat/watches/kinds.js';

/** TER-1099: an event the concierge asked to be woken for ("me avise quando…"). */
export interface ChatWatch {
  id: string;
  user_id: string;
  project_id: string | null;
  conversation_id: string | null;
  kind: WatchKind;
  target_id: string | null;
  params: WatchParams;
  baseline: Record<string, unknown>;
  label: string;
  note: string;
  recurring: boolean;
  status: WatchStatus;
  created_at: string;
  expires_at: string;
  closed_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
}

export interface NewChatWatch {
  user_id: string;
  project_id: string | null;
  conversation_id: string | null;
  kind: WatchKind;
  target_id: string | null;
  params: WatchParams;
  baseline: Record<string, unknown>;
  label: string;
  note: string;
  recurring: boolean;
  expires_at: Date;
}

/** One event a watch caught, until it reaches the conversation. */
export interface ChatWatchFire {
  id: string;
  watch_id: string;
  user_id: string;
  project_id: string | null;
  event_key: string;
  event: string;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
}

/** What `fire` writes: the events (each with its idempotency key) and the watch's state after them. */
export interface WatchFiring {
  events: { key: string; event: string; payload: Record<string, unknown> }[];
  baseline: Record<string, unknown>;
  /** Closes the watch with this status (a one-shot watch that fired, a target that is gone); null keeps it open. */
  close: WatchStatus | null;
  /** A recurring watch fires only when its last fire is older than this (ms). */
  cooldownMs?: number;
}

/** A claimed fire is the claimer's this long; after it, another sweep may take it (the claimer died mid-delivery). */
export const FIRE_CLAIM_TTL_MS = 2 * 60_000;

/** Rows whose `kind` the code does not know (a newer release wrote them) are skipped by the readers. */
const map = (r: PrismaWatch): ChatWatch | null =>
  isWatchKind(r.kind)
    ? {
        id: r.id, user_id: r.userId, project_id: r.projectId, conversation_id: r.conversationId, kind: r.kind, target_id: r.targetId,
        params: r.params as unknown as WatchParams, baseline: (r.baseline ?? {}) as Record<string, unknown>, label: r.label, note: r.note,
        recurring: r.recurring, status: r.status as WatchStatus, created_at: r.createdAt.toISOString(), expires_at: r.expiresAt.toISOString(),
        closed_at: r.closedAt?.toISOString() ?? null, last_fired_at: r.lastFiredAt?.toISOString() ?? null, fire_count: r.fireCount,
      }
    : null;
const mapKnown = (rows: PrismaWatch[]) => rows.flatMap((r) => { const m = map(r); return m ? [m] : []; });
const mapFire = (r: PrismaFire): ChatWatchFire => ({
  id: r.id, watch_id: r.watchId, user_id: r.userId, project_id: r.projectId, event_key: r.eventKey, event: r.event,
  payload: (r.payload ?? {}) as Record<string, unknown>, created_at: r.createdAt.toISOString(), attempts: r.attempts,
});

/** Thrown inside `fire`'s transaction to roll it back when the watch was no longer free to fire. */
class NotFired extends Error {}

/** The watches and their fires. Reads for a person are keyed by `user_id` (server-derived, never a client value). */
export class ChatWatchesRepository {
  constructor(private db: PrismaClient) {}

  async create(input: NewChatWatch, now = new Date()): Promise<ChatWatch> {
    const row = await this.db.chatWatch.create({
      data: {
        id: newId(), userId: input.user_id, projectId: input.project_id, conversationId: input.conversation_id, kind: input.kind, targetId: input.target_id,
        params: input.params as object, baseline: input.baseline as object, label: input.label, note: input.note, recurring: input.recurring,
        createdAt: now, expiresAt: input.expires_at,
      },
    });
    return map(row)!;
  }

  /** The open watches of one chat scope (the account-wide chat is `project_id` null), oldest first. */
  async listOpen(userId: string, projectId: string | null): Promise<ChatWatch[]> {
    return mapKnown(await this.db.chatWatch.findMany({ where: { userId, projectId, status: 'open' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
  }

  async countOpen(userId: string, projectId: string | null): Promise<number> {
    return this.db.chatWatch.count({ where: { userId, projectId, status: 'open' } });
  }

  /** Every open watch, for the sweep; `kind`/`targetId` narrow it for a bus event. */
  async listAllOpen(filter: { kind?: WatchKind; targetId?: string } = {}, limit = 2000): Promise<ChatWatch[]> {
    return mapKnown(
      await this.db.chatWatch.findMany({
        where: { status: 'open', ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.targetId ? { targetId: filter.targetId } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    );
  }

  async findById(id: string): Promise<ChatWatch | null> {
    const row = await this.db.chatWatch.findUnique({ where: { id } });
    return row ? map(row) : null;
  }

  /** Cancels one open watch of this user; null when it is not theirs or no longer open. */
  async cancel(id: string, userId: string, now = new Date()): Promise<ChatWatch | null> {
    const { count } = await this.db.chatWatch.updateMany({ where: { id, userId, status: 'open' }, data: { status: 'cancelled', closedAt: now } });
    if (count === 0) return null;
    return this.findById(id);
  }

  /**
   * Records what a watch caught and moves the watch on, in one transaction. The watch's own row decides:
   * it must still be open and, when recurring, past its cooldown — so two colours seeing the same event
   * write it once (the loser's update matches nothing). `(watch_id, event_key)` is the second guard.
   * Answers how many fires were born (0 = the watch was not free to fire).
   */
  async fire(watch: Pick<ChatWatch, 'id' | 'user_id' | 'project_id'>, firing: WatchFiring, now = new Date()): Promise<number> {
    if (firing.events.length === 0) return 0;
    try {
      return await this.db.$transaction(async (tx) => {
        const cooldown = firing.cooldownMs ? { OR: [{ lastFiredAt: null }, { lastFiredAt: { lt: new Date(now.getTime() - firing.cooldownMs) } }] } : {};
        const { count } = await tx.chatWatch.updateMany({
          where: { id: watch.id, status: 'open', ...cooldown },
          data: {
            baseline: firing.baseline as object,
            lastFiredAt: now,
            fireCount: { increment: firing.events.length },
            ...(firing.close ? { status: firing.close, closedAt: now } : {}),
          },
        });
        if (count === 0) throw new NotFired();
        const created = await tx.chatWatchFire.createMany({
          data: firing.events.map((e) => ({ id: newId(), watchId: watch.id, userId: watch.user_id, projectId: watch.project_id, eventKey: e.key.slice(0, 500), event: e.event, payload: e.payload as object, createdAt: now })),
          skipDuplicates: true,
        });
        if (created.count === 0) throw new NotFired();
        return created.count;
      });
    } catch (err) {
      if (err instanceof NotFired) return 0;
      throw err;
    }
  }

  /** A change the watch did not ask about (a machine went offline on an `online` watch): the next event is
   *  measured from it, without a fire. Open watches only. */
  async updateBaseline(id: string, baseline: Record<string, unknown>): Promise<void> {
    await this.db.chatWatch.updateMany({ where: { id, status: 'open' }, data: { baseline: baseline as object } });
  }

  /** Open watches past their validity. The caller fires their `expired` event (which closes them). */
  async listDue(now = new Date(), limit = 200): Promise<ChatWatch[]> {
    return mapKnown(await this.db.chatWatch.findMany({ where: { status: 'open', expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' }, take: limit }));
  }

  /** Fires not delivered yet, nor held by a live claim, oldest first. */
  async listPendingFires(now = new Date(), limit = 500): Promise<ChatWatchFire[]> {
    const stale = new Date(now.getTime() - FIRE_CLAIM_TTL_MS);
    return (
      await this.db.chatWatchFire.findMany({
        where: { deliveredAt: null, droppedAt: null, OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      })
    ).map(mapFire);
  }

  /** Claims fires for one delivery; answers the ids this caller won (another colour may hold the rest). */
  async claimFires(ids: string[], now = new Date()): Promise<string[]> {
    const stale = new Date(now.getTime() - FIRE_CLAIM_TTL_MS);
    const won: string[] = [];
    for (const id of ids) {
      const { count } = await this.db.chatWatchFire.updateMany({
        where: { id, deliveredAt: null, droppedAt: null, OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }] },
        data: { claimedAt: now },
      });
      if (count === 1) won.push(id);
    }
    return won;
  }

  async markDelivered(ids: string[], now = new Date()): Promise<void> {
    if (ids.length) await this.db.chatWatchFire.updateMany({ where: { id: { in: ids } }, data: { deliveredAt: now } });
  }

  /** Hands claimed fires back after a delivery that did not happen (the host was away): the next sweep retries. */
  async releaseFires(ids: string[]): Promise<void> {
    if (ids.length) await this.db.chatWatchFire.updateMany({ where: { id: { in: ids }, deliveredAt: null }, data: { claimedAt: null, attempts: { increment: 1 } } });
  }

  /** Fires that could not be delivered for this long are given up on; answers how many. */
  async dropUndeliveredBefore(cutoff: Date, now = new Date()): Promise<number> {
    const { count } = await this.db.chatWatchFire.updateMany({ where: { deliveredAt: null, droppedAt: null, createdAt: { lt: cutoff } }, data: { droppedAt: now } });
    return count;
  }

  /** Wakes this chat scope already had since `since` (the hourly budget): deliveries, not fires — several fires share one wake. */
  async countWakesSince(userId: string, projectId: string | null, since: Date): Promise<number> {
    const rows = await this.db.chatWatchFire.findMany({ where: { userId, projectId, deliveredAt: { gte: since } }, select: { deliveredAt: true }, distinct: ['deliveredAt'] });
    return rows.length;
  }

  /** Closed watches (and their fires) older than `before` go: they are history nobody reads. */
  async purgeClosedBefore(before: Date): Promise<number> {
    const { count } = await this.db.chatWatch.deleteMany({ where: { status: { not: 'open' }, closedAt: { lt: before } } });
    return count;
  }
}
