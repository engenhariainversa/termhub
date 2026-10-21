import type { PrismaClient } from '../prisma.js';
import type { ConciergeNotice as PrismaNotice } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import type { PushLevel } from '../../chat/notices/rules.js';

/** TER-1101: a notice the concierge asked to send outside the chat (`notify`). */
export interface ConciergeNotice {
  id: string;
  user_id: string;
  conversation_id: string;
  project_id: string | null;
  message_id: string | null;
  level: PushLevel;
  headline: string;
  watch_id: string | null;
  status: 'pending' | 'sent' | 'dropped';
  reason: string | null;
  created_at: string;
  ready_at: string | null;
  sent_at: string | null;
}

export interface NewConciergeNotice {
  user_id: string;
  conversation_id: string;
  project_id: string | null;
  level: PushLevel;
  headline: string;
  watch_id: string | null;
}

const map = (r: PrismaNotice): ConciergeNotice => ({
  id: r.id, user_id: r.userId, conversation_id: r.conversationId, project_id: r.projectId, message_id: r.messageId,
  level: r.level as PushLevel, headline: r.headline, watch_id: r.watchId, status: r.status as ConciergeNotice['status'], reason: r.reason,
  created_at: r.createdAt.toISOString(), ready_at: r.readyAt?.toISOString() ?? null, sent_at: r.sentAt?.toISOString() ?? null,
});

/** The concierge's notices. Keyed by `user_id` and `conversation_id`, both server-derived. */
export class ConciergeNoticesRepository {
  constructor(private db: PrismaClient) {}

  async create(input: NewConciergeNotice, now = new Date()): Promise<ConciergeNotice> {
    return map(
      await this.db.conciergeNotice.create({
        data: { id: newId(), userId: input.user_id, conversationId: input.conversation_id, projectId: input.project_id, level: input.level, headline: input.headline, watchId: input.watch_id, createdAt: now },
      }),
    );
  }

  async countPending(conversationId: string): Promise<number> {
    return this.db.conciergeNotice.count({ where: { conversationId, status: 'pending' } });
  }

  /** The answer `messageId` of the conversation is done: the notices written before it point at it and may leave. */
  async markReady(conversationId: string, messageId: string, now = new Date()): Promise<number> {
    const { count } = await this.db.conciergeNotice.updateMany({ where: { conversationId, status: 'pending', messageId: null, createdAt: { lte: now } }, data: { messageId, readyAt: now } });
    return count;
  }

  /** Pending notices that may leave: their answer is done, or it never said so for `readyAfterMs`. */
  async listReady(now: Date, readyAfterMs: number, filter: { userId?: string } = {}, limit = 500): Promise<ConciergeNotice[]> {
    const rows = await this.db.conciergeNotice.findMany({
      where: { status: 'pending', ...(filter.userId ? { userId: filter.userId } : {}), OR: [{ readyAt: { not: null } }, { createdAt: { lt: new Date(now.getTime() - readyAfterMs) } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(map);
  }

  /** When the conversation's pushes of the window went out: one time per push (a grouped push shares it). */
  async sentSince(conversationId: string, since: Date): Promise<Date[]> {
    const rows = await this.db.conciergeNotice.findMany({ where: { conversationId, status: 'sent', sentAt: { gte: since } }, select: { sentAt: true }, distinct: ['sentAt'] });
    return rows.flatMap((r) => (r.sentAt ? [r.sentAt] : []));
  }

  /** Marks notices sent, one by one; answers the ids this caller won (the other colour may have sent the rest). */
  async claimSent(ids: string[], now = new Date(), messageId?: string | null): Promise<string[]> {
    const won: string[] = [];
    for (const id of ids) {
      const { count } = await this.db.conciergeNotice.updateMany({ where: { id, status: 'pending' }, data: { status: 'sent', sentAt: now, ...(messageId ? { messageId } : {}) } });
      if (count === 1) won.push(id);
    }
    return won;
  }

  async drop(ids: string[], reason: string): Promise<void> {
    if (ids.length) await this.db.conciergeNotice.updateMany({ where: { id: { in: ids }, status: 'pending' }, data: { status: 'dropped', reason } });
  }

  /** What holds pending notices now (quiet, grouped, capped): for the logs and the tests, not a state. */
  async noteHeld(ids: string[], reason: string): Promise<void> {
    if (ids.length) await this.db.conciergeNotice.updateMany({ where: { id: { in: ids }, status: 'pending' }, data: { reason } });
  }

  /** Pending notices older than `cutoff` are given up on; answers how many. */
  async dropStaleBefore(cutoff: Date): Promise<number> {
    const { count } = await this.db.conciergeNotice.updateMany({ where: { status: 'pending', createdAt: { lt: cutoff } }, data: { status: 'dropped', reason: 'stale' } });
    return count;
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const { count } = await this.db.conciergeNotice.deleteMany({ where: { status: { not: 'pending' }, createdAt: { lt: cutoff } } });
    return count;
  }
}
