import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ConciergeNoticesRepository } from './concierge-notices.js';
import { UsersRepository } from './users.js';
import { DEFAULT_NOTICE_SETTINGS } from '../../chat/notices/rules.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ConciergeNoticesRepository (Postgres, TER-1101)', () => {
  let db: PrismaClient;
  let repo: ConciergeNoticesRepository;
  let userId: string;
  let conversationId: string;
  const t0 = new Date('2026-10-21T12:00:00.000Z');
  const input = () => ({ user_id: userId, conversation_id: conversationId, project_id: null, level: 'done' as const, headline: 'Build pronto', watch_id: 'w1' });

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ConciergeNoticesRepository(db);
    userId = newId();
    conversationId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.chatConversation.create({ data: { id: conversationId, userId } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: userId } }); // cascades the conversation and its notices
    await db.$disconnect();
  });

  it('a notice is ready once its answer ends, or after a while; sent once whoever claims it', async () => {
    const a = await repo.create(input(), t0);
    expect(a).toMatchObject({ status: 'pending', message_id: null, level: 'done' });
    expect(await repo.countPending(conversationId)).toBe(1);
    expect(await repo.listReady(t0, 60_000, { userId })).toEqual([]);
    expect(await repo.markReady(conversationId, 'm1', new Date(t0.getTime() + 1000))).toBe(1);
    expect((await repo.listReady(t0, 60_000, { userId })).map((n) => [n.id, n.message_id])).toEqual([[a.id, 'm1']]);
    const sentAt = new Date(t0.getTime() + 2000);
    const [x, y] = await Promise.all([repo.claimSent([a.id], sentAt), repo.claimSent([a.id], sentAt)]);
    expect(x.length + y.length).toBe(1);
    expect((await repo.sentSince(conversationId, t0)).map((d) => d.toISOString())).toEqual([sentAt.toISOString()]);
    const late = await repo.create(input(), t0);
    expect((await repo.listReady(new Date(t0.getTime() + 61_000), 60_000, { userId })).map((n) => n.id)).toEqual([late.id]);
    await repo.drop([late.id], 'level_off');
    expect(await repo.countPending(conversationId)).toBe(0);
  });

  it('keeps the person\'s rules, with the defaults until set', async () => {
    const users = new UsersRepository(db);
    expect(await users.conciergePush(userId)).toEqual(DEFAULT_NOTICE_SETTINGS);
    const rules = { needs_you: true, done: false, quiet_start: '22:00', quiet_end: '07:00', group_minutes: 10 };
    await users.setConciergePush(userId, rules);
    expect(await users.conciergePush(userId)).toEqual(rules);
  });
});
