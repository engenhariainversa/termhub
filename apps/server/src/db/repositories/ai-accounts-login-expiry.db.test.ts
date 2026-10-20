import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { AiAccountsRepository } from './ai-accounts.js';
import { UsersRepository } from './users.js';

const DAY = 24 * 60 * 60_000;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see tasks.db.test.ts / README).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('AiAccountsRepository: login expiry (Postgres, TER-1079)', () => {
  let db: PrismaClient;
  let repo: AiAccountsRepository;
  const users: string[] = [];

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new AiAccountsRepository(db);
  });
  afterAll(async () => {
    await db?.machine.deleteMany({ where: { ownerId: { in: users } } });
    await db?.user.deleteMany({ where: { id: { in: users } } });
    await db?.$disconnect();
  });

  async function seed() {
    const userId = newId();
    users.push(userId);
    await db.user.create({ data: { id: userId, email: `expiry-${userId}@example.com`, name: 'expiry', passwordHash: 'x' } });
    const machineId = newId();
    await db.machine.create({ data: { id: machineId, name: 'jarvis', type: 'agent', ownerId: userId, agentTokenHash: `expiry-${machineId}` } });
    const account = await repo.create({ provider: 'claude', label: 'pessoal', machine_id: machineId });
    return { userId, account };
  }

  it('an account starts with no date, and one warning is claimed per login', async () => {
    const { account } = await seed();
    expect(account.login_expires_at).toBeNull();
    const now = new Date('2026-10-13T12:00:00Z');
    // nothing to warn about without a date
    expect(await repo.claimLoginExpiryWarning(account.id, now)).toBe(false);

    const expires = new Date(now.getTime() + 3 * DAY);
    await repo.noteLoginExpiry(account.id, expires, now);
    expect((await repo.findById(account.id))?.login_expires_at).toBe(expires.toISOString());
    expect((await repo.list(null)).find((a) => a.id === account.id)?.login_expires_at).toBe(expires.toISOString());
    expect(await repo.claimLoginExpiryWarning(account.id, now)).toBe(true);
    expect(await repo.claimLoginExpiryWarning(account.id, now)).toBe(false);

    // the same login seen again a day later ("expires in 2 days"): the date is refined, the claim stays
    const later = new Date(now.getTime() + DAY);
    const refined = new Date(later.getTime() + 2 * DAY - 60 * 60_000);
    await repo.noteLoginExpiry(account.id, refined, later);
    expect((await repo.findById(account.id))?.login_expires_at).toBe(refined.toISOString());
    expect(await repo.claimLoginExpiryWarning(account.id, later)).toBe(false);
  });

  it('another login re-arms the warning: redone from the screen, redone by hand, or the old date passed', async () => {
    const { account } = await seed();
    const now = new Date('2026-10-13T12:00:00Z');
    await repo.noteLoginExpiry(account.id, new Date(now.getTime() + 3 * DAY), now);
    expect(await repo.claimLoginExpiryWarning(account.id, now)).toBe(true);

    await repo.clearLoginExpiry(account.id);
    expect((await repo.findById(account.id))?.login_expires_at).toBeNull();
    await repo.noteLoginExpiry(account.id, new Date(now.getTime() + 2 * DAY), now);
    expect(await repo.claimLoginExpiryWarning(account.id, now)).toBe(true);

    // a date over a day later than the known one is a login redone since
    await repo.noteLoginExpiry(account.id, new Date(now.getTime() + 5 * DAY), now);
    expect(await repo.claimLoginExpiryWarning(account.id, now)).toBe(true);

    // long after the known date passed
    const nextMonth = new Date(now.getTime() + 30 * DAY);
    await repo.noteLoginExpiry(account.id, new Date(nextMonth.getTime() + DAY), nextMonth);
    expect(await repo.claimLoginExpiryWarning(account.id, nextMonth)).toBe(true);
    // a date already past is never claimed
    expect(await repo.claimLoginExpiryWarning(account.id, new Date(nextMonth.getTime() + 2 * DAY))).toBe(false);
  });

  it('keeps each person\'s warning window', async () => {
    const { userId } = await seed();
    const usersRepo = new UsersRepository(db);
    expect(await usersRepo.aiLoginWarnDays(userId)).toBeNull();
    await usersRepo.setAiLoginWarnDays(userId, 1);
    expect(await usersRepo.aiLoginWarnDays(userId)).toBe(1);
    await usersRepo.setAiLoginWarnDays(userId, 0);
    expect(await usersRepo.aiLoginWarnDays(userId)).toBe(0);
  });
});
