import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { SessionsRepository } from './sessions.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('SessionsRepository (Postgres)', () => {
  let db: PrismaClient;
  let sessions: SessionsRepository;
  let userId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    sessions = new SessionsRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'me' } });
    return async () => {
      await db.user.deleteMany({ where: { id: userId } }); // cascades the sessions
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const open = (hash: string, origin = {}) => sessions.create(userId, `${userId}:${hash}`, new Date(Date.now() + DAY), origin);
  const age = (id: string, ms: number) => db.session.update({ where: { id }, data: { lastUsedAt: new Date(Date.now() - ms) } });

  it('keeps where a session was opened and lists the live ones, most recently used first', async () => {
    const a = await open('a', { ip: '10.0.0.1', user_agent: 'Firefox' });
    const b = await open('b');
    await age(a.id, 5 * MIN);
    const list = await sessions.listForUser(userId);
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list[1]).toMatchObject({ ip: '10.0.0.1', user_agent: 'Firefox' });
  });

  it('drops sessions idle past the cutoff from lookups, lists and the purge', async () => {
    const idle = await open('idle');
    const busy = await open('busy');
    await age(idle.id, 40 * MIN);
    const cutoff = new Date(Date.now() - 30 * MIN);

    expect(await sessions.findValidByTokenHash(`${userId}:idle`, cutoff)).toBeUndefined();
    expect(await sessions.findValidByTokenHash(`${userId}:idle`)).toBeDefined(); // no idle timeout
    expect((await sessions.listForUser(userId, cutoff)).map((s) => s.id)).toEqual([busy.id]);

    await sessions.purgeExpired(cutoff);
    expect(await db.session.count({ where: { userId } })).toBe(1);
  });

  it('touches a session only when its last use is older than the threshold', async () => {
    const s = await open('t');
    await age(s.id, 5 * MIN);
    const now = new Date();
    await sessions.touch(s.id, now, new Date(now.getTime() - MIN));
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).lastUsedAt.getTime()).toBe(now.getTime());

    const later = new Date(now.getTime() + 10_000);
    await sessions.touch(s.id, later, new Date(later.getTime() - MIN));
    expect((await db.session.findUniqueOrThrow({ where: { id: s.id } })).lastUsedAt.getTime()).toBe(now.getTime());
  });

  it('ends one session of its owner only, and all but the kept one', async () => {
    const a = await open('a');
    const b = await open('b');
    const c = await open('c');
    expect(await sessions.deleteForUser('someone-else', a.id)).toBe(false);
    expect(await sessions.deleteForUser(userId, a.id)).toBe(true);
    expect(await sessions.deleteAllForUser(userId, b.id)).toBe(1);
    expect((await sessions.listForUser(userId)).map((s) => s.id)).toEqual([b.id]);
    expect(c.id).not.toBe(b.id);
    expect(await sessions.deleteAllForUser(userId)).toBe(1);
  });
});
