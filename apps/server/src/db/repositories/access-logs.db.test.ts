import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { AccessLogsRepository } from './access-logs.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('access logs (Postgres)', () => {
  let db: PrismaClient;
  let repo: AccessLogsRepository;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new AccessLogsRepository(db);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('writes a batch and purges only what is older than the cutoff', async () => {
    const userId = newId(); // no user row: the record has no foreign key and outlives an account
    const now = Date.now();
    const row = (at: number, route: string) => ({ at: new Date(at), ip: '203.0.113.9', user_id: userId, kind: 'http' as const, method: 'GET', route, status: 200 });
    // Years back, so no other test's rows sit between the cutoff and these.
    const old = now - 4 * 365 * 24 * 3600_000;
    await repo.insertMany([row(old, '/api/old'), row(now, '/api/new')]);

    const purged = await repo.purgeBefore(new Date(old + 1000));
    expect(purged).toBeGreaterThanOrEqual(1);
    const left = await db.accessLog.findMany({ where: { userId }, select: { route: true } });
    expect(left.map((r) => r.route)).toEqual(['/api/new']);
    await db.accessLog.deleteMany({ where: { userId } });
  });
});
