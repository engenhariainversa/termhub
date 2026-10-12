import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatAutoRepository, type AutoSample } from './chat-auto.js';
import { UsersRepository } from './users.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatAutoRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatAutoRepository;
  let users: UsersRepository;
  const userId = newId();
  const otherUserId = newId();

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatAutoRepository(db);
    users = new UsersRepository(db);
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades samples and focus
    await db.$disconnect();
  });

  const sample = (over: Partial<AutoSample> = {}): AutoSample => ({ user_id: userId, tab_question_id: newId(), question_index: 0, score: 0.9, matched: true, source: 'answer', ...over });

  it('recordSamples: one sample per question of a card; a later observation replaces the earlier one', async () => {
    const card = newId();
    await repo.recordSamples([sample({ tab_question_id: card, matched: false, source: 'cancelled' }), sample({ tab_question_id: card, question_index: 1, score: 0.7 })]);
    await repo.recordSamples([sample({ tab_question_id: card, matched: true, source: 'answer' })]);
    const mine = (await repo.recentSamples(userId, 100)).filter((s) => s.tab_question_id === card);
    expect(mine).toHaveLength(2);
    expect(mine.find((s) => s.question_index === 0)).toMatchObject({ matched: true, source: 'answer', score: 0.9 });
    expect(mine.find((s) => s.question_index === 1)).toMatchObject({ matched: true, score: 0.7 });
  });

  it("recentSamples and countSamples only ever read the user's own rows, newest first, within the limit", async () => {
    await repo.recordSamples([sample({ user_id: otherUserId, score: 0.11 })]);
    const mine = await repo.recentSamples(userId, 100);
    expect(mine.every((s) => s.user_id === userId)).toBe(true);
    expect(mine.some((s) => s.score === 0.11)).toBe(false);
    expect(await repo.countSamples(userId)).toBe(mine.length);
    expect(await repo.recentSamples(userId, 1)).toHaveLength(1);
  });

  it('usersToCalibrate: someone with a sample newer than their last calibration, until it is stored', async () => {
    await repo.recordSamples([sample()]);
    expect(await repo.usersToCalibrate(10_000)).toContain(userId);
    await users.setChatAutoCalibration(userId, { high: 0.95, low: 0.85, samples: 3, computed_at: new Date(Date.now() + 60_000).toISOString() });
    expect(await repo.usersToCalibrate(10_000)).not.toContain(userId);
    // an older calibration is behind the samples again
    await users.setChatAutoCalibration(userId, { high: 0.95, low: 0.85, samples: 3, computed_at: new Date(Date.now() - 24 * 3600_000).toISOString() });
    expect(await repo.usersToCalibrate(10_000)).toContain(userId);
  });

  it('thresholds: pinned by hand, handed back with null, and the calibration read as stored', async () => {
    expect(await users.chatAutoThresholds(otherUserId)).toEqual({ high: null, low: null, calibration: null });
    await users.setChatAutoThresholds(otherUserId, { high: 0.97, low: 0.9 });
    const calibration = { high: 0.93, low: 0.8, samples: 40, computed_at: '2026-10-10T00:00:00.000Z' };
    await users.setChatAutoCalibration(otherUserId, calibration);
    expect(await users.chatAutoThresholds(otherUserId)).toEqual({ high: 0.97, low: 0.9, calibration });
    await users.setChatAutoThresholds(otherUserId, null);
    expect(await users.chatAutoThresholds(otherUserId)).toEqual({ high: null, low: null, calibration });
    // a user that is gone: nothing to read, nothing to store, no error
    expect(await users.chatAutoThresholds(newId())).toEqual({ high: null, low: null, calibration: null });
    await expect(users.setChatAutoCalibration(newId(), calibration)).resolves.toBeUndefined();
  });

  it('focus: a fresh heartbeat on any screen puts the person in focus; clearing the last one takes them out', async () => {
    expect((await repo.focusedUsers([userId, otherUserId], 45_000)).has(userId)).toBe(false);
    await repo.touchFocus(userId, 'screen-a');
    await repo.touchFocus(userId, 'screen-b');
    await repo.touchFocus(userId, 'screen-a'); // a beat on the same screen is one row
    expect(await db.chatFocus.count({ where: { userId } })).toBe(2);
    expect([...(await repo.focusedUsers([userId, otherUserId], 45_000))]).toEqual([userId]);
    await repo.clearFocus(userId, 'screen-a');
    expect((await repo.focusedUsers([userId], 45_000)).has(userId)).toBe(true);
    await repo.clearFocus(userId, 'screen-b');
    expect((await repo.focusedUsers([userId], 45_000)).has(userId)).toBe(false);
    expect(await repo.focusedUsers([], 45_000)).toEqual(new Set());
  });

  it('focus: a heartbeat past its time no longer counts, and the purge removes it', async () => {
    await repo.touchFocus(userId, 'screen-old');
    await db.$executeRaw`UPDATE "chat_focus" SET "seen_at" = CURRENT_TIMESTAMP - interval '2 minutes' WHERE "user_id" = ${userId} AND "client_id" = 'screen-old'`;
    expect((await repo.focusedUsers([userId], 45_000)).has(userId)).toBe(false);
    expect((await repo.focusedUsers([userId], 10 * 60_000)).has(userId)).toBe(true);
    await repo.purgeFocus(60_000);
    expect(await db.chatFocus.count({ where: { userId, clientId: 'screen-old' } })).toBe(0);
  });
});
