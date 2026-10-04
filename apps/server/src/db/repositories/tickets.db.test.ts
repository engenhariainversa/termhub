import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { TicketsRepository, type TicketUpsert } from './tickets.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TicketsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: TicketsRepository;
  let userId: string;
  let projectId: string;
  const integ = 'integ-1';

  const t = (n: number, scope: string, over: Partial<TicketUpsert> = {}): TicketUpsert => ({
    integration_id: integ, scope, provider: 'github', sync_key: `github:${scope}#${n}`, key: `${scope}#${n}`,
    title: `Issue ${n}`, description: null, url: `https://github.com/${scope}/issues/${n}`, state: 'open', status: 'backlog', meta: {}, ...over,
  });

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TicketsRepository(db);
    userId = newId();
    projectId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.project.create({ data: { id: projectId, name: 'p', key: `T${Date.now() % 100000}`, ownerId: userId } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: projectId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it('stores scope, key and sync_key, and prunes one source without touching the other on the same integration', async () => {
    // Project/user fixtures: if the models need more required fields, copy them from chat-grants.db.test.ts.
    await repo.upsertMany(projectId, [t(1, 'acme/api'), t(2, 'acme/api'), t(1, 'acme/web')]);
    const all = await repo.listByProject(projectId);
    expect(all.map((x) => [x.scope, x.key]).sort()).toEqual([['acme/api', 'acme/api#1'], ['acme/api', 'acme/api#2'], ['acme/web', 'acme/web#1']]);
    const removed = await repo.pruneMissing(projectId, { integration_id: integ, scope: 'acme/api' }, ['github:acme/api#1'], false);
    expect(removed).toBe(1);
    expect((await repo.listByProject(projectId)).map((x) => x.key).sort()).toEqual(['acme/api#1', 'acme/web#1']);
  });

  it('finds by exact key, URL and suffix, case-insensitively', async () => {
    expect((await repo.findByKeyish([projectId], { key: 'ACME/API#1' })).map((x) => x.key)).toEqual(['acme/api#1']);
    expect((await repo.findByKeyish([projectId], { url: 'https://github.com/acme/web/issues/1' })).map((x) => x.key)).toEqual(['acme/web#1']);
    expect((await repo.findByKeyish([projectId], { suffix: '#1' })).map((x) => x.key).sort()).toEqual(['acme/api#1', 'acme/web#1']);
  });

  it('pruneSource deletes only non-imported tickets of that source', async () => {
    expect(await repo.pruneSource(projectId, { integration_id: integ, scope: 'acme/web' })).toBe(1);
    expect((await repo.listByProject(projectId)).map((x) => x.key)).toEqual(['acme/api#1']);
  });

  it('pruneMissing with legacyNullScope also clears rows written before the scope column', async () => {
    await db.ticket.create({ data: { id: newId(), projectId, integrationId: integ, provider: 'github', syncKey: 'github:old#9', key: '#9', title: 'old', url: 'u', state: 'open', status: 'backlog' } });
    expect(await repo.pruneMissing(projectId, { integration_id: integ, scope: 'acme/api' }, ['github:acme/api#1'], true)).toBe(1);
  });

  it('an imported ticket that left its source is listed again only once it comes back (TER-718)', async () => {
    await repo.upsertMany(projectId, [t(5, 'acme/api')]);
    const five = (await repo.listByProject(projectId)).find((x) => x.key === 'acme/api#5')!;
    await repo.linkTask(five.id, `task-${five.id}`);
    const src = { integration_id: integ, scope: 'acme/api' };
    // pruneMissing keeps it (imported); listLeftImported finds it, not the ticket still in the source
    expect(await repo.pruneMissing(projectId, src, ['github:acme/api#1'], false)).toBe(0);
    expect((await repo.listLeftImported(projectId, src, ['github:acme/api#1'], false, 50)).map((x) => x.key)).toEqual(['acme/api#5']);

    const marked = await repo.markLeftSource(five.id, { key: 'acme/api#5', title: 'Issue 5', description: null, url: 'u5', state: 'closed', status: 'done', meta: {} });
    expect(marked).toMatchObject({ state: 'closed', status: 'done', task_id: `task-${five.id}` });
    expect(marked.left_source_at).not.toBeNull();
    expect((await repo.listByProject(projectId)).map((x) => x.key)).not.toContain('acme/api#5');
    expect((await repo.listByProject(projectId, { include_left: true })).map((x) => x.key)).toContain('acme/api#5');
    expect(await repo.listLeftImported(projectId, src, ['github:acme/api#1'], false, 50)).toEqual([]);
    expect((await repo.findByKeyish([projectId], { key: 'acme/api#5' })).map((x) => x.state)).toEqual(['closed']);

    // reopened: the sync brings it back and the mark goes
    await repo.upsertMany(projectId, [t(5, 'acme/api')]);
    const back = (await repo.listByProject(projectId)).find((x) => x.key === 'acme/api#5');
    expect(back).toMatchObject({ state: 'open', left_source_at: null });
    await db.ticket.deleteMany({ where: { id: five.id } });
  });

  it('findByIdsForOwner resolves only tickets whose project belongs to that owner', async () => {
    const [mine] = await repo.listByProject(projectId);
    const otherOwnerId = newId();
    const otherProjectId = newId();
    await db.user.create({ data: { id: otherOwnerId, email: `${otherOwnerId}@test.local`, name: 'other' } });
    await db.project.create({ data: { id: otherProjectId, name: 'other', key: `O${Date.now() % 100000}`, ownerId: otherOwnerId } });
    await repo.upsertMany(otherProjectId, [t(1, 'other/repo')]);
    const [theirs] = await repo.listByProject(otherProjectId);

    expect((await repo.findByIdsForOwner([mine.id, theirs.id], userId)).map((x) => x.id)).toEqual([mine.id]);
    expect(await repo.findByIdsForOwner([theirs.id], userId)).toEqual([]);
    expect(await repo.findByIdsForOwner([], userId)).toEqual([]);

    await db.project.deleteMany({ where: { id: otherProjectId } });
    await db.user.deleteMany({ where: { id: otherOwnerId } });
  });
});
