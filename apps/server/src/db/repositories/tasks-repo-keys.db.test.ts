import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { SETUP_VERSION } from '../../setup/schema.js';
import { TaskRuleError, TasksRepository } from './tasks.js';

const keyOf = (id: string) => 'K' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('tasks.repo_keys (Postgres, spec 2026-10-07 multi-repo R8)', () => {
  let db: PrismaClient;
  let repo: TasksRepository;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TasksRepository(db);
  });

  beforeEach(async () => {
    projectId = newId();
    await db.project.create({ data: { id: projectId, key: keyOf(projectId), name: 'p' } });
    return async () => {
      await db.project.delete({ where: { id: projectId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function discover(...repos: [string, string][]) {
    for (const [fullName, key] of repos) await db.projectRepository.create({ data: { id: newId(), projectId, fullName, key } });
  }
  const rule = (code: string) => expect.objectContaining({ name: 'TaskRuleError', code });

  it('a card is born with an empty list, and a single-repo project keeps it empty', async () => {
    await db.projectSetup.create({ data: { projectId, version: SETUP_VERSION, data: { repo: { full_name: 'acme/api' } } } });
    const plain = await repo.create(projectId, { title: 'a' });
    expect(plain.repo_keys).toEqual([]);
    const named = await repo.create(projectId, { title: 'b', repo_keys: ['acme/api'] });
    expect(named.repo_keys).toEqual([]);
    await expect(repo.create(projectId, { title: 'c', repo_keys: ['web'] })).rejects.toEqual(rule('REPO_UNKNOWN'));
  });

  it('in a multi-repo project, create and update store the keys (owner/repo converted) in project order', async () => {
    await discover(['acme/api', 'api'], ['acme/web', 'web']);
    const card = await repo.create(projectId, { title: 'a', repo_keys: ['acme/web', 'api'] });
    expect(card.repo_keys).toEqual(['api', 'web']);
    expect((await repo.findById(card.id))!.repo_keys).toEqual(['api', 'web']);

    const changed = await repo.update(card.id, { repo_keys: ['ACME/WEB'] });
    expect(changed!.repo_keys).toEqual(['web']);
    // a patch without repo_keys leaves them alone
    expect((await repo.update(card.id, { title: 'b' }))!.repo_keys).toEqual(['web']);
    expect((await repo.update(card.id, { repo_keys: [] }))!.repo_keys).toEqual([]);
  });

  it('refuses unknown repositories and more than 10, writing nothing', async () => {
    await discover(...Array.from({ length: 11 }, (_, i): [string, string] => [`acme/r${i}`, `r${i}`]));
    const card = await repo.create(projectId, { title: 'a', repo_keys: ['r1'] });
    await expect(repo.update(card.id, { title: 'changed', repo_keys: ['r1', 'nope'] })).rejects.toEqual(rule('REPO_UNKNOWN'));
    await expect(repo.update(card.id, { repo_keys: Array.from({ length: 11 }, (_, i) => `r${i}`) })).rejects.toEqual(rule('TOO_MANY_REPOS'));
    const after = (await repo.findById(card.id))!;
    expect([after.title, after.repo_keys]).toEqual(['a', ['r1']]);
  });

  it('epics and subtasks take no repositories', async () => {
    await discover(['acme/api', 'api'], ['acme/web', 'web']);
    await expect(repo.create(projectId, { title: 'e', type: 'epic', repo_keys: ['api'] })).rejects.toBeInstanceOf(TaskRuleError);
    const story = await repo.create(projectId, { title: 's', type: 'story' });
    const [sub] = await repo.createSubtasks(story.id, [{ title: 'x' }]);
    await expect(repo.update(sub.id, { repo_keys: ['api'] })).rejects.toEqual(rule('REPOS_NOT_FOR_TYPE'));
    expect((await repo.update(sub.id, { repo_keys: [] }))!.repo_keys).toEqual([]);
  });

  it('createFromTicket stores the keys it is given', async () => {
    await discover(['acme/api', 'api'], ['acme/web', 'web']);
    const t = await repo.createFromTicket(projectId, { key: 'github:acme/web#1', title: 't', description: null, ref: {}, repo_keys: ['web'] });
    expect(t.repo_keys).toEqual(['web']);
  });
});
