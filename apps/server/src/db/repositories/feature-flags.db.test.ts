import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { FeatureFlagsRepository } from './feature-flags.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('FeatureFlagsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: FeatureFlagsRepository;
  const userId = `ff-${newId()}`;
  // a key of its own, so a parallel run never touches the real `subscriptions` row
  const key = `test-${newId()}`;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new FeatureFlagsRepository(db);
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'Tester' } });
  });

  afterAll(async () => {
    await db.featureFlag.deleteMany({ where: { key } });
    await db.user.deleteMany({ where: { id: userId } });
    await db?.$disconnect();
  });

  it('has no value until an admin sets one, then keeps the last', async () => {
    expect(await repo.instanceValue(key)).toBeNull();
    await repo.setInstance(key, true, 'admin');
    await repo.setInstance(key, false, 'admin');
    expect(await repo.instanceValue(key)).toBe(false);
    expect((await repo.list()).find((r) => r.key === key)).toMatchObject({ enabled: false, updated_by: 'admin' });
  });

  it('keeps one override per person, lists it with who they are, and removes it', async () => {
    expect(await repo.overrideFor(key, userId)).toBeNull();
    expect(await repo.anyOverrideOn(key)).toBe(false);
    await repo.setOverride(key, userId, false, 'admin');
    await repo.setOverride(key, userId, true, 'admin');
    expect(await repo.overrideFor(key, userId)).toBe(true);
    expect(await repo.anyOverrideOn(key)).toBe(true);
    expect(await repo.listOverrides(key)).toEqual([expect.objectContaining({ user_id: userId, email: `${userId}@test.local`, name: 'Tester', enabled: true })]);
    expect(await repo.removeOverride(key, userId)).toBe(true);
    expect(await repo.removeOverride(key, userId)).toBe(false);
    expect(await repo.overrideFor(key, userId)).toBeNull();
  });

  it('drops the overrides with the account', async () => {
    const gone = `ff-${newId()}`;
    await db.user.create({ data: { id: gone, email: `${gone}@test.local`, name: 'Gone' } });
    await repo.setOverride(key, gone, true, null);
    await db.user.delete({ where: { id: gone } });
    expect(await repo.overrideFor(key, gone)).toBeNull();
  });
});
