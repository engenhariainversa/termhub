import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { AiMemoryPagesRepository } from './ai-memory-pages.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('AiMemoryPagesRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: AiMemoryPagesRepository;
  let userId: string;
  let projectId: string;
  let machineId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new AiMemoryPagesRepository(db);
    userId = newId();
    projectId = newId();
    machineId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.project.create({ data: { id: projectId, key: `M${newId(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'p', ownerId: userId } });
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent', ownerId: userId } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: projectId } });
    await db.machine.deleteMany({ where: { id: machineId } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });

  it('upserts per checkout, removes by path and cascades with the machine', async () => {
    const row = { project_id: projectId, machine_id: machineId, cwd: '/repo', path: '_rules/termhub-a-a1.md', hash: 'h1' };
    await repo.upsert(row);
    await repo.upsert({ ...row, hash: 'h2' });
    await repo.upsert({ ...row, cwd: '/other' });
    expect((await repo.listByProject(projectId)).map((r) => [r.cwd, r.hash])).toEqual([
      ['/other', 'h1'],
      ['/repo', 'h2'],
    ]);
    expect(await repo.projectIds()).toContain(projectId);
    await repo.remove(projectId, machineId, '/repo', [row.path]);
    expect((await repo.listByProject(projectId)).map((r) => r.cwd)).toEqual(['/other']);
    await db.machine.delete({ where: { id: machineId } });
    expect(await repo.listByProject(projectId)).toEqual([]);
  });
});
