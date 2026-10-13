import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { normalizeSetup, SETUP_VERSION } from '../../setup/schema.js';
import { ProjectRepositoriesRepository, type DiscoveredCheckoutInput } from './project-repositories.js';
import { ProjectSetupRepository } from './project-setup.js';

const found = (full_name: string, dir: string, over: Partial<DiscoveredCheckoutInput> = {}): DiscoveredCheckoutInput => ({
  full_name, dir, default_branch: 'main', has_commits: true, ...over,
});

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both; see README → Development).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ProjectRepositoriesRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ProjectRepositoriesRepository;
  let setups: ProjectSetupRepository;
  let ownerId: string;
  let m1: string;
  let m2: string;
  let projectId: string;
  let otherProject: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ProjectRepositoriesRepository(db);
    setups = new ProjectSetupRepository(db);
  });

  beforeEach(async () => {
    ownerId = newId();
    m1 = newId();
    m2 = newId();
    projectId = newId();
    otherProject = newId();
    const key = (id: string, prefix: string) => prefix + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'o' } });
    await db.machine.createMany({ data: [{ id: m1, name: 'one', type: 'agent', ownerId }, { id: m2, name: 'two', type: 'agent', ownerId }] });
    await db.project.createMany({ data: [{ id: projectId, ownerId, key: key(projectId, 'K'), name: 'p' }, { id: otherProject, ownerId, key: key(otherProject, 'O'), name: 'other' }] });
    return async () => {
      await db.project.deleteMany({ where: { id: { in: [projectId, otherProject] } } });
      await db.machine.deleteMany({ where: { id: { in: [m1, m2] } } });
      await db.user.deleteMany({ where: { id: ownerId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('a first scan creates the repositories with their keys; a second one creates nothing and refreshes the checkout', async () => {
    const first = await repo.upsertDiscovered(projectId, m1, [
      found('acme/web', 'Hub Web', { default_branch: 'trunk', description: 'the site' }),
      found('acme/api', '.'),
    ]);
    expect(first.created.map((r) => [r.key, r.full_name])).toEqual([['hub-web', 'acme/web'], ['main', 'acme/api']]);
    expect(first.duplicates).toEqual([]);
    const web = first.repositories.find((r) => r.key === 'hub-web')!;
    expect(web).toMatchObject({ project_id: projectId, description: 'the site', status: 'ok' });
    expect(web.checkouts).toEqual([expect.objectContaining({ machine_id: m1, dir: 'Hub Web', default_branch: 'trunk', has_commits: true, missing_at: null })]);

    const second = await repo.upsertDiscovered(projectId, m1, [found('acme/web', 'Hub Web', { default_branch: 'next', has_commits: false }), found('acme/api', '.')]);
    expect(second.created).toEqual([]);
    const again = second.repositories.find((r) => r.key === 'hub-web')!;
    expect(again.id).toBe(web.id);
    // a scan that does not read the description keeps the stored one
    expect(again.description).toBe('the site');
    expect(again.checkouts).toEqual([expect.objectContaining({ dir: 'Hub Web', default_branch: 'next', has_commits: false })]);
    expect(Date.parse(again.checkouts[0].seen_at)).toBeGreaterThanOrEqual(Date.parse(web.checkouts[0].seen_at));
    expect((await repo.listByProject(projectId)).map((r) => r.key)).toEqual(['hub-web', 'main']);
    expect(await repo.listByProject(otherProject)).toEqual([]);
  });

  it('a renamed folder keeps the key; another machine gets its own checkout; the name matches without case', async () => {
    await repo.upsertDiscovered(projectId, m1, [found('Acme/API', 'api')]);
    const renamed = await repo.upsertDiscovered(projectId, m1, [found('acme/api', 'backend', { description: 'now described', status: 'no_access' })]);
    expect(renamed.created).toEqual([]);
    expect(renamed.repositories).toHaveLength(1);
    expect(renamed.repositories[0]).toMatchObject({ key: 'api', full_name: 'Acme/API', description: 'now described', status: 'no_access' });
    expect(renamed.repositories[0].checkouts).toEqual([expect.objectContaining({ machine_id: m1, dir: 'backend' })]);

    const other = await repo.upsertDiscovered(projectId, m2, [found('acme/api', 'work/api-clone')]);
    expect(other.created).toEqual([]);
    expect(other.repositories[0].key).toBe('api');
    expect(other.repositories[0].checkouts.map((c) => [c.machine_id, c.dir]).sort()).toEqual([[m1, 'backend'], [m2, 'work/api-clone']].sort());
  });

  it('keys stay unique in the project, and the same repository twice in a scan uses the first folder', async () => {
    const r = await repo.upsertDiscovered(projectId, m1, [
      found('acme/site', 'web'),
      found('acme/other-site', 'apps/web'),
      found('acme/site', 'web-copy'),
      found('acme/root', '.'),
      found('acme/trunk', 'main'),
    ]);
    const keyOf = (name: string) => r.repositories.find((x) => x.full_name === name)!.key;
    expect([keyOf('acme/root'), keyOf('acme/other-site'), keyOf('acme/trunk'), keyOf('acme/site')]).toEqual(['main', 'web', 'main-2', 'web-2']);
    expect(r.duplicates.map((d) => d.dir)).toEqual(['web-copy']);
    expect(r.repositories.find((x) => x.full_name === 'acme/site')!.checkouts[0].dir).toBe('web');
    // the same names in another project are free
    const elsewhere = await repo.upsertDiscovered(otherProject, m1, [found('acme/site', 'web')]);
    expect(elsewhere.created.map((x) => x.key)).toEqual(['web']);
  });

  it('markMissing marks only the checkouts of this machine that the scan did not return, once', async () => {
    const { repositories } = await repo.upsertDiscovered(projectId, m1, [found('acme/api', 'api'), found('acme/web', 'web')]);
    await repo.upsertDiscovered(projectId, m2, [found('acme/web', 'web')]);
    await repo.upsertDiscovered(otherProject, m1, [found('acme/else', 'else')]);
    const api = repositories.find((r) => r.key === 'api')!;
    const web = repositories.find((r) => r.key === 'web')!;

    const gone = await repo.markMissing(projectId, m1, [api.id]);
    expect(gone.map((r) => r.key)).toEqual(['web']);
    const stored = (await repo.listByProject(projectId)).find((r) => r.id === web.id)!;
    expect(stored.checkouts.find((c) => c.machine_id === m1)!.missing_at).not.toBeNull();
    expect(stored.checkouts.find((c) => c.machine_id === m2)!.missing_at).toBeNull();
    expect((await repo.listByProject(otherProject))[0].checkouts[0].missing_at).toBeNull();
    expect(await repo.markMissing(projectId, m1, [api.id])).toEqual([]);

    const back = await repo.upsertDiscovered(projectId, m1, [found('acme/api', 'api'), found('acme/web', 'web')]);
    expect(back.created).toEqual([]);
    expect(back.repositories.find((r) => r.id === web.id)!.checkouts.every((c) => c.missing_at === null)).toBe(true);
    expect(await repo.markMissing(projectId, m1, [])).toHaveLength(2);
  });

  it('effective: setup.repo alone while the table is empty, then the discovered repositories', async () => {
    const setup = normalizeSetup({ repo: { integration_id: 'g1', full_name: 'acme/api' }, automation: { autonomy: 'merge' } }, SETUP_VERSION);
    expect(await repo.effective(projectId, setup)).toEqual([expect.objectContaining({ full_name: 'acme/api', key: 'main', discovered: false, autonomy: 'merge' })]);
    await repo.upsertDiscovered(projectId, m1, [found('acme/api', '.'), found('acme/web', 'web')]);
    expect((await repo.effective(projectId, setup)).map((e) => [e.key, e.discovered, e.autonomy])).toEqual([['main', true, 'merge'], ['web', true, 'pr']]);
  });

  it('saving the setup leaves it as given with no repositories, and mirrors the first enabled one once there are', async () => {
    const given = normalizeSetup({ repo: { integration_id: 'g1', full_name: 'acme/api', base_branch: 'develop' }, automation: { autonomy: 'merge' } }, SETUP_VERSION);
    expect((await setups.save(projectId, given)).data).toEqual(given);

    await repo.upsertDiscovered(projectId, m1, [found('acme/api', '.'), found('acme/web', 'web', { default_branch: 'trunk' })]);
    expect((await setups.save(projectId, given)).data).toEqual(given);

    const moved = await setups.save(projectId, { ...given, repos: normalizeSetup({ repos: [{ full_name: 'acme/api', enabled: false, autonomy: 'merge' }] }, SETUP_VERSION).repos });
    expect(moved.data.repo).toMatchObject({ full_name: 'acme/web', base_branch: 'trunk' });
    expect(moved.data.repos.map((o) => [o.full_name, o.enabled, o.autonomy, o.base_branch]).sort()).toEqual([['acme/api', false, 'merge', 'develop'], ['acme/web', true, 'pr', 'trunk']]);
    expect((await setups.get(projectId)).data).toEqual(moved.data);
  });

  it('deleting the machine removes its checkouts, and deleting the project removes everything', async () => {
    await repo.upsertDiscovered(projectId, m1, [found('acme/api', 'api')]);
    await repo.upsertDiscovered(projectId, m2, [found('acme/api', 'api')]);
    await db.machine.delete({ where: { id: m1 } });
    const [left] = await repo.listByProject(projectId);
    expect(left.checkouts.map((c) => c.machine_id)).toEqual([m2]);
    await db.project.delete({ where: { id: projectId } });
    expect(await db.projectRepository.count({ where: { projectId } })).toBe(0);
    expect(await db.projectRepositoryCheckout.count({ where: { repositoryId: left.id } })).toBe(0);
  });
});
