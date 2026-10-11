import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeAutomationDb } from '../../test/automation-db-lock.js';

vi.hoisted(() => {
  // the GitHub integration's token is stored encrypted; config reads the env at import time
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { PrismaClient } from '../generated/prisma/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { newId } from '../lib/ids.js';
import { normalizeSetup } from '../setup/schema.js';
import { runMergeExecutor, type MergeDeps } from './merge.js';
import { resetMergeWaits } from './merge-wait.js';

const keyOf = (id: string) => 'M' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
const BRANCH = 'TER-5-arrastar-cards';
/** A heartbeat in the future: the takeover tests of other files, sharing the database, never take this run. */
const AHEAD = new Date(Date.now() + 24 * 3600_000);

/**
 * Red CI across colours (spec D21, F-27; plan Review Focus 1 and 3): two merge executors — one per colour,
 * each with its own typing and fixer start — read the same red PR head from one real database at once.
 */
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('red CI across colours (Postgres)', () => {
  serializeAutomationDb();
  let db: PrismaClient;
  let repos: Repositories;
  let ownerId: string;
  let projectId: string;
  let machineId: string;
  let taskId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function setSetup(automation: Record<string, unknown>, integrationId: string) {
    const { data } = await repos.projectSetup.get(projectId);
    await repos.projectSetup.save(
      projectId,
      normalizeSetup({ ...data, repo: { integration_id: integrationId, full_name: 'acme/app', base_branch: 'main' }, automation: { ...data.automation, enabled: true, ...automation } }, 2),
    );
  }

  async function seed(automation: Record<string, unknown> = {}) {
    const integration = await repos.integrations.create({ provider: 'github', name: 'gh', config: {}, secret: 'tok', owner_id: ownerId });
    await setSetup(automation, integration.id);
    taskId = (await repos.tasks.create(projectId, { title: 'Arrastar cards', auto: true, description: 'faça isto' })).id;
    await repos.taskPullRequests.replaceLinks(
      projectId,
      { repo: 'acme/app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Board: drag cards', head_ref: BRANCH, head_sha: 'h1', base_ref: 'main', state: 'open', draft: false, merged_at: null, merge_commit_sha: null },
      [taskId],
    );
    await repos.taskPullRequests.updateCi(projectId, 'acme/app', 7, { ci_state: 'failed', ci_summary: { total: 1, passed: 0, failed: 1, running: 0, failing: ['ci'] } });
  }

  /** The implementer run that opened the PR, still on in a tab that waits for input. */
  async function owningRun(): Promise<string> {
    const tab = await repos.tabs.create(projectId, machineId, 'agent');
    await db.tab.update({ where: { id: tab.id }, data: { state: 'waiting_input', stateAt: new Date() } });
    const run = await db.automationRun.create({ data: { id: newId(), projectId, taskId, role: 'implementer', status: 'running', claimedBy: 'blue', tabId: tab.id, branch: BRANCH, heartbeatAt: AHEAD } });
    return run.id;
  }

  /** One colour's executor: its own instance id, typing and fixer start; GitHub is never asked on a red head. */
  function colour(instance: string) {
    const type = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 4));
    });
    const startFixer = vi.fn(async () => 'started' as const);
    const deps: MergeDeps = {
      repos,
      gh: {} as GithubWriteClient,
      ci: { listRuns: vi.fn(async () => []) },
      lifecycle: { draining: false },
      instance,
      startFixer,
      type,
      seen: new Map(),
    };
    return { deps, type, startFixer };
  }

  beforeEach(async () => {
    ownerId = newId();
    projectId = newId();
    machineId = newId();
    resetMergeWaits();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' } });
    await db.project.create({ data: { id: projectId, ownerId, key: keyOf(projectId), name: 'p' } });
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent', ownerId } });
    return async () => {
      await db.project.delete({ where: { id: projectId } });
      await db.integration.deleteMany({ where: { ownerId } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.delete({ where: { id: ownerId } });
    };
  });

  const events = (kind: string) => db.automationEvent.findMany({ where: { projectId, kind } });

  it('both colours on the same red head: one line typed, one fix counted, one request', async () => {
    await seed();
    const runId = await owningRun();
    const blue = colour('blue');
    const green = colour('green');
    for (let i = 0; i < 3; i++) await Promise.all([runMergeExecutor(blue.deps, projectId), runMergeExecutor(green.deps, projectId)]);
    expect(blue.type.mock.calls.length + green.type.mock.calls.length).toBe(1);
    expect((await db.automationRun.findUniqueOrThrow({ where: { id: runId } })).fixCount).toBe(1);
    const requests = await events('ci_fix_requested');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload).toMatchObject({ pr: 7, sha: 'h1', via: 'typed', count: 1 });
  });

  it('both colours at the cap on the same red head: one escalation', async () => {
    await seed({ fix_attempts: 0 });
    // the implementer that opened the PR ended (its branch makes the PR the card's own)
    await db.automationRun.create({ data: { id: newId(), projectId, taskId, role: 'implementer', status: 'done', claimedBy: 'blue', branch: BRANCH, endedAt: new Date() } });
    const blue = colour('blue');
    const green = colour('green');
    for (let i = 0; i < 3; i++) await Promise.all([runMergeExecutor(blue.deps, projectId), runMergeExecutor(green.deps, projectId)]);
    expect(blue.startFixer).not.toHaveBeenCalled();
    expect(green.startFixer).not.toHaveBeenCalled();
    const escalated = await events('escalated');
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.payload).toMatchObject({ reason: 'ci_cap', pr: 7, sha: 'h1', attempts: 0 });
    expect(await events('ci_fix_requested')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ via: 'escalated' }) })]);
  });
});
