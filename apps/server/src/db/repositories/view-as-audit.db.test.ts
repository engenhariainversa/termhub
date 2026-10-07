import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ViewAsAuditRepository } from './view-as-audit.js';

const DAY = 24 * 3600_000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('view as audit (Postgres)', () => {
  let db: PrismaClient;
  let audit: ViewAsAuditRepository;
  let adminId: string;
  let targetId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    audit = new ViewAsAuditRepository(db);
  });

  beforeEach(() => {
    adminId = newId();
    targetId = newId();
    return async () => {
      await db.viewAsAudit.deleteMany({ where: { adminId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('a new period ends the previous one at the same instant', async () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    const t1 = new Date('2026-10-01T10:05:00Z');
    const first = await audit.start({ admin_id: adminId, scope: 'user', target_user_id: targetId, ip: '10.0.0.1' }, t0);
    expect(first).toMatchObject({ scope: 'user', target_user_id: targetId, ip: '10.0.0.1', started_at: t0.toISOString(), ended_at: null });
    await audit.start({ admin_id: adminId, scope: 'all', target_user_id: targetId }, t1);
    const rows = await audit.listForAdmin(adminId);
    expect(rows.map((r) => [r.scope, r.target_user_id, r.ended_at])).toEqual([
      ['all', null, null],
      ['user', targetId, t1.toISOString()],
    ]);
  });

  it('end closes only the open period and reports how many', async () => {
    await audit.start({ admin_id: adminId, scope: 'user', target_user_id: targetId });
    expect(await audit.end(adminId)).toBe(1);
    expect(await audit.end(adminId)).toBe(0);
    const [row] = await audit.listForTarget(targetId);
    expect(row.ended_at).not.toBeNull();
  });

  it('purges periods that ended, or started and never ended, before the cutoff', async () => {
    const now = Date.now();
    await audit.start({ admin_id: adminId, scope: 'user', target_user_id: targetId }, new Date(now - 400 * DAY));
    await audit.start({ admin_id: adminId, scope: 'user', target_user_id: targetId }, new Date(now - 370 * DAY)); // ends the first
    await audit.end(adminId, new Date(now - 10 * DAY)); // a long period that ended recently: kept
    await audit.start({ admin_id: adminId, scope: 'all' }, new Date(now - 380 * DAY)); // stale and open
    await audit.purgeBefore(new Date(now - 365 * DAY));
    const left = await audit.listForAdmin(adminId);
    expect(left).toHaveLength(1);
    expect(left[0].started_at).toBe(new Date(now - 370 * DAY).toISOString());
  });
});
