import type { PrismaClient } from '../prisma.js';
import type { UserNotification as PrismaUserNotification } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export interface UserNotificationCreateInput {
  user_id: string;
  kind: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** One notification pushed to a person, for the app's Notificações tab (spec §9). */
export interface UserNotification {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
}

const mapUserNotification = (n: PrismaUserNotification): UserNotification => ({
  id: n.id,
  user_id: n.userId,
  kind: n.kind,
  title: n.title,
  body: n.body,
  data: (n.data ?? {}) as Record<string, unknown>,
  created_at: n.createdAt.toISOString(),
  read_at: n.readAt?.toISOString() ?? null,
});

export class UserNotificationsRepository {
  constructor(private db: PrismaClient) {}

  async create(input: UserNotificationCreateInput): Promise<UserNotification> {
    const n = await this.db.userNotification.create({
      data: {
        id: newId(),
        userId: input.user_id,
        kind: input.kind,
        title: input.title,
        body: input.body,
        data: (input.data ?? {}) as never,
      },
    });
    return mapUserNotification(n);
  }

  /** Newest first, optionally before a cursor timestamp (infinite scroll). */
  async list(userId: string, before: Date | null, limit = 50): Promise<UserNotification[]> {
    const rows = await this.db.userNotification.findMany({
      where: { userId, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(mapUserNotification);
  }

  async countUnread(userId: string): Promise<number> {
    return this.db.userNotification.count({ where: { userId, readAt: null } });
  }

  /** Conditional on the notification being the user's own and still unread. */
  async markRead(id: string, userId: string, now: Date): Promise<boolean> {
    const { count } = await this.db.userNotification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: now } });
    return count > 0;
  }

  /**
   * Marks read every unread row of the user whose `data[key]` is `value` (TER-923): the card it was
   * about got handled — answered here or on another screen, or it ended. Resolves how many changed.
   */
  async markReadByData(userId: string, key: 'action_id' | 'tab_question_id' | 'run_id', value: string, now: Date): Promise<number> {
    const { count } = await this.db.userNotification.updateMany({ where: { userId, readAt: null, data: { path: [key], equals: value } }, data: { readAt: now } });
    return count;
  }

  /** Whether the notification exists and is the user's own, read or not (makes marking read idempotent). */
  async existsForUser(id: string, userId: string): Promise<boolean> {
    return (await this.db.userNotification.count({ where: { id, userId } })) > 0;
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const r = await this.db.userNotification.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  }
}
