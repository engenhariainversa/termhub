import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { SecurityEventsRepository } from './security-events.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('SecurityEventsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: SecurityEventsRepository;
  /** a per-test actor, so each test reads only its own rows */
  let actor: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new SecurityEventsRepository(db);
  });

  beforeEach(() => {
    actor = newId();
    return async () => {
      await db.securityEvent.deleteMany({ where: { actorId: actor } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('records a row and lists it newest first, filtered by action group, actor and text', async () => {
    await repo.record({ actor_id: actor, actor_email: 'admin@x.dev', action: 'auth.login', ip: '10.1.2.3' });
    await repo.record({ actor_id: actor, actor_email: 'admin@x.dev', action: 'user.invite', target_type: 'user', target_label: 'Pessoa@X.dev', meta: { role: 'BETA' } });
    const all = await repo.list({ actor_id: actor }, 10);
    expect(all.map((e) => e.action)).toEqual(['user.invite', 'auth.login']);
    expect(all[0]).toMatchObject({ actor_email: 'admin@x.dev', target_label: 'Pessoa@X.dev', meta: { role: 'BETA' } });
    expect((await repo.list({ actor_id: actor, action: 'auth' }, 10)).map((e) => e.action)).toEqual(['auth.login']);
    expect((await repo.list({ actor_id: actor, action: 'user.invite' }, 10))).toHaveLength(1);
    expect((await repo.list({ actor_id: actor, q: 'pessoa@x' }, 10)).map((e) => e.action)).toEqual(['user.invite']);
    expect((await repo.list({ actor_id: actor, q: '10.1.2' }, 10)).map((e) => e.action)).toEqual(['auth.login']);
  });

  it('pages with the keyset cursor without skipping rows that share a timestamp', async () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    await db.securityEvent.createMany({ data: ['a', 'b', 'c'].map((s) => ({ id: `${actor}${s}`, actorId: actor, action: 'auth.logout', createdAt: at })) });
    const first = await repo.list({ actor_id: actor }, 2);
    const last = first[first.length - 1]!;
    const rest = await repo.list({ actor_id: actor, before: { created_at: new Date(last.created_at), id: last.id } }, 10);
    expect([...first, ...rest].map((e) => e.id)).toEqual([`${actor}c`, `${actor}b`, `${actor}a`]);
  });

  it('is append-only: the database refuses an update', async () => {
    await repo.record({ actor_id: actor, action: 'auth.login' });
    await expect(db.securityEvent.updateMany({ where: { actorId: actor }, data: { action: 'auth.logout' } })).rejects.toThrow(/append-only/);
  });

  it('purges only rows past the cutoff', async () => {
    await db.securityEvent.create({ data: { id: newId(), actorId: actor, action: 'auth.login', createdAt: new Date('2020-01-01T00:00:00.000Z') } });
    await repo.record({ actor_id: actor, action: 'auth.logout' });
    await repo.purgeBefore(new Date('2021-01-01T00:00:00.000Z'));
    expect((await repo.list({ actor_id: actor }, 10)).map((e) => e.action)).toEqual(['auth.logout']);
  });
});
