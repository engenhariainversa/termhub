import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { HealthAlertsRepository } from './health-alerts.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('HealthAlertsRepository (Postgres, TER-1121)', () => {
  let db: PrismaClient;
  let repo: HealthAlertsRepository;
  let userId: string;
  let projectId: string;
  const t0 = new Date('2026-10-27T12:00:00.000Z');
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  const sign = { signal: 'pr_ready' as const, subject: 'https://github.com/o/r/pull/1', level: 'needs_you' as const, detail: { label: '#1' }, since: null };

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new HealthAlertsRepository(db);
    userId = newId();
    projectId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.project.create({ data: { id: projectId, ownerId: userId, key: 'H' + newId().replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase(), name: 'health' } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: projectId } }); // cascades the alerts
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it('one row per sign; claims are won once; a resolved sign seen again is a new episode', async () => {
    const a = await repo.seen(projectId, sign, at(0));
    expect(a).toMatchObject({ signal: 'pr_ready', since_at: at(0).toISOString(), opened_at: null, resolved_at: null });
    const again = await repo.seen(projectId, { ...sign, detail: { label: '#1', reason: 'merge_base_red' } }, at(5));
    expect(again).toMatchObject({ id: a.id, since_at: at(0).toISOString(), last_seen_at: at(5).toISOString(), detail: { reason: 'merge_base_red' } });
    expect(await repo.listOpen(projectId)).toEqual([]);

    expect(await repo.open(a.id, at(120))).toBe(true);
    expect(await repo.open(a.id, at(121))).toBe(false);
    expect((await repo.listOpen(projectId)).map((x) => x.id)).toEqual([a.id]);
    const [w1, w2] = await Promise.all([repo.claimWake([a.id], at(120)), repo.claimWake([a.id], at(120))]);
    expect(w1.length + w2.length).toBe(1);
    expect((await repo.claimNotice([a.id], at(120))).length).toBe(1);
    expect((await repo.claimNotice([a.id], at(121))).length).toBe(0);

    expect(await repo.resolve([a.id], at(130))).toBe(1);
    expect(await repo.listUnresolved(projectId)).toEqual([]);
    const next = await repo.seen(projectId, sign, at(200));
    expect(next).toMatchObject({ id: a.id, since_at: at(200).toISOString(), opened_at: null, woken_at: null, noticed_at: null, resolved_at: null });
    expect(await repo.purgeResolvedBefore(at(300))).toBe(0);
  });
});
