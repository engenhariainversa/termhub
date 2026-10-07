import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { AiAccountsRepository } from './ai-accounts.js';

const keyOf = (id: string) => 'X' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('AI accounts exclusive to a project (TER-990, Postgres)', () => {
  let db: PrismaClient;
  let repo: AiAccountsRepository;
  let userId: string;
  let projectId: string;
  let machineId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new AiAccountsRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    projectId = newId();
    machineId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'u' } });
    await db.project.create({ data: { id: projectId, ownerId: userId, key: keyOf(projectId), name: 'DR Horton' } });
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent', ownerId: userId } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.delete({ where: { id: userId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('is born free, carries the project name once marked, and keeps it through other edits', async () => {
    const a = await repo.create({ provider: 'claude', label: 'drhorton', machine_id: machineId });
    expect(a.exclusive_project).toBeNull();
    const marked = await repo.update(a.id, { exclusive_project_id: projectId });
    expect(marked?.exclusive_project).toEqual({ id: projectId, name: 'DR Horton' });
    expect((await repo.update(a.id, { label: 'D. R. Horton' }))?.exclusive_project).toEqual({ id: projectId, name: 'DR Horton' });
    expect((await repo.list(userId)).map((x) => x.exclusive_project)).toEqual([{ id: projectId, name: 'DR Horton' }]);
    expect((await repo.update(a.id, { exclusive_project_id: null }))?.exclusive_project).toBeNull();
  });

  it('deleting the project clears the exclusivity, not the account', async () => {
    const a = await repo.create({ provider: 'claude', label: 'drhorton', machine_id: machineId, exclusive_project_id: projectId });
    await db.project.delete({ where: { id: projectId } });
    expect((await repo.findById(a.id))?.exclusive_project).toBeNull();
  });
});
