import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serializeAutomationDb } from '../../test/automation-db-lock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { newId } from '../lib/ids.js';
import { ADOPT_WINDOW_MS, ADOPTED_VIA, adoptBlockedRuns } from './follower.js';

const keyOf = (id: string) => 'A' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
const BRANCH = 'TER-9-terminar-a-mao';

/**
 * A PR from the branch of a blocked run (TER-1049), adopted by both colours' CI sync at once against one real
 * database: the conditional write lets one of them through, so the run moves `blocked → done` once.
 */
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('adopting a blocked run across colours (Postgres)', () => {
  serializeAutomationDb();
  let db: PrismaClient;
  let repos: Repositories;
  let ownerId: string;
  let projectId: string;
  let taskId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    ownerId = newId();
    projectId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' } });
    await db.project.create({ data: { id: projectId, ownerId, key: keyOf(projectId), name: 'p' } });
    taskId = (await repos.tasks.create(projectId, { title: 'Terminar à mão', auto: true, description: 'faça isto' })).id;
    await repos.taskPullRequests.replaceLinks(
      projectId,
      { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Finish by hand', head_ref: BRANCH, head_sha: 'h1', base_ref: 'main', state: 'open', draft: false, merged_at: null, merge_commit_sha: null },
      [taskId],
    );
    return async () => {
      await db.project.delete({ where: { id: projectId } });
      await db.user.delete({ where: { id: ownerId } });
    };
  });

  const blockedRun = (data: Record<string, unknown> = {}) =>
    db.automationRun.create({
      data: { id: newId(), projectId, taskId, role: 'implementer', status: 'blocked', waitingReason: 'reported_blocked', claimedBy: 'blue', branch: BRANCH, endedAt: new Date(Date.now() - 3600_000), ...data },
    });
  const events = (kind: string) => db.automationEvent.findMany({ where: { projectId, kind } });
  const chatLines = () => db.chatMessage.findMany({ where: { conversation: { projectId } } });

  it('both colours at once: blocked → done once, one run_done, one pr_opened, one chat line', async () => {
    const run = await blockedRun();
    const counts = await Promise.all([adoptBlockedRuns(repos, projectId), adoptBlockedRuns(repos, projectId)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    const after = await db.automationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ status: 'done', waitingReason: 'reported_blocked', endedAt: run.endedAt });
    const done = await events('run_done');
    expect(done).toHaveLength(1);
    expect(done[0]!.payload).toMatchObject({ via: ADOPTED_VIA, pr_url: 'https://github.com/acme/app/pull/12' });
    expect(await events('pr_opened')).toHaveLength(1);
    expect((await chatLines()).map((m) => m.text)).toEqual([expect.stringContaining('PR #12 do')]);
    // a later sync leaves it as it is
    expect(await adoptBlockedRuns(repos, projectId)).toBe(0);
    expect(await events('run_done')).toHaveLength(1);
  });

  it('the query leaves out markers, other roles and runs past the window', async () => {
    await blockedRun({ branch: null, triggerSha: 'h0', role: 'fixer' });
    await blockedRun({ role: 'fixer', triggerSha: 'h1' });
    await blockedRun({ endedAt: new Date(Date.now() - ADOPT_WINDOW_MS - 60_000) });
    expect(await repos.automationRuns.blockedSince(projectId, new Date(Date.now() - ADOPT_WINDOW_MS))).toEqual([]);
    expect(await adoptBlockedRuns(repos, projectId)).toBe(0);
  });

  it('a newer run of the card owns the PR', async () => {
    await blockedRun({ createdAt: new Date(Date.now() - 7200_000) });
    await db.automationRun.create({ data: { id: newId(), projectId, taskId, role: 'implementer', status: 'running', claimedBy: 'green', branch: BRANCH, heartbeatAt: new Date() } });
    expect(await adoptBlockedRuns(repos, projectId)).toBe(0);
    expect(await events('run_done')).toEqual([]);
  });
});
