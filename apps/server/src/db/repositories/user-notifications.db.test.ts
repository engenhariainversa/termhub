import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { UserNotificationsRepository } from './user-notifications.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('UserNotificationsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: UserNotificationsRepository;
  let userId: string;
  let otherId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new UserNotificationsRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    otherId = newId();
    await db.user.createMany({
      data: [
        { id: userId, email: `${userId}@test.local`, name: 'me' },
        { id: otherId, email: `${otherId}@test.local`, name: 'other' },
      ],
    });
    return async () => {
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } }); // cascades notifications
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const make = () => repo.create({ user_id: userId, kind: 'reply', title: 'Resposta pronta', body: 'O chat geral terminou de responder.', data: { kind: 'reply' } });

  it('existsForUser is true only for the owner', async () => {
    const n = await make();
    expect(await repo.existsForUser(n.id, userId)).toBe(true);
    expect(await repo.existsForUser(n.id, otherId)).toBe(false);
    expect(await repo.existsForUser('nope', userId)).toBe(false);
  });

  it('markRead is true once, then false; never for another user', async () => {
    const n = await make();
    expect(await repo.markRead(n.id, otherId, new Date())).toBe(false);
    expect(await repo.markRead(n.id, userId, new Date())).toBe(true);
    expect(await repo.markRead(n.id, userId, new Date())).toBe(false);
    expect(await repo.countUnread(userId)).toBe(0);
  });

  it('markReadByData marks only the user\'s unread rows about that card (TER-923)', async () => {
    const row = (owner: string, data: Record<string, unknown>) => repo.create({ user_id: owner, kind: 'confirmation', title: 't', body: 'b', data });
    await row(userId, { kind: 'tab_question', tab_question_id: 'q1' });
    await row(userId, { kind: 'tab_question', tab_question_id: 'q1' });
    await row(userId, { kind: 'tab_question', tab_question_id: 'q2' });
    await row(userId, { kind: 'confirmation', action_id: 'q1' });
    await row(otherId, { kind: 'tab_question', tab_question_id: 'q1' });
    expect(await repo.markReadByData(userId, 'tab_question_id', 'q1', new Date())).toBe(2);
    expect(await repo.markReadByData(userId, 'tab_question_id', 'q1', new Date())).toBe(0);
    expect(await repo.countUnread(userId)).toBe(2);
    expect(await repo.countUnread(otherId)).toBe(1);
    expect(await repo.markReadByData(userId, 'action_id', 'q1', new Date())).toBe(1);
  });
});
