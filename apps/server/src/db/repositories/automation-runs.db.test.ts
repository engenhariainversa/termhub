import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { AiAccountExhaustionsRepository } from './ai-account-exhaustions.js';
import { AutomationRunsRepository } from './automation-runs.js';

const keyOf = (id: string) => 'R' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('automation runs and account exhaustions (Postgres)', () => {
  let db: PrismaClient;
  let runs: AutomationRunsRepository;
  let exhaustions: AiAccountExhaustionsRepository;
  let userId: string;
  let projectId: string;
  let taskId: string;
  let machineId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    runs = new AutomationRunsRepository(db);
    exhaustions = new AiAccountExhaustionsRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    projectId = newId();
    taskId = newId();
    machineId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'u' } });
    await db.project.create({ data: { id: projectId, ownerId: userId, key: keyOf(projectId), name: 'p' } });
    await db.task.create({ data: { id: taskId, projectId, title: 't' } });
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

  const claim = (instance: string, task = taskId) => runs.claim({ project_id: projectId, task_id: task, role: 'implementer', instance });

  it('two concurrent claims on one card: exactly one wins, the other reads "already taken" (null)', async () => {
    const results = await Promise.all([claim('blue'), claim('green')]);
    const won = results.filter((r) => r !== null);
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(won[0]).toMatchObject({ task_id: taskId, project_id: projectId, role: 'implementer', status: 'queued', resume_count: 0, fix_count: 0 });
    expect(await db.automationRun.count({ where: { taskId } })).toBe(1);
  });

  it('a triggered run (spike R2): one per (card, role, PR head), never again after it ended, a new head gets its own', async () => {
    const fixer = (instance: string, sha: string) => runs.claim({ project_id: projectId, task_id: taskId, role: 'fixer', instance, trigger_sha: sha });
    const results = await Promise.all([fixer('blue', 'h1'), fixer('green', 'h1')]);
    const won = results.filter((r) => r !== null);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ role: 'fixer', trigger_sha: 'h1' });
    await runs.update(won[0]!.id, won[0]!.claimed_by, { status: 'blocked', ended_at: new Date() });
    // ended blocked: the same head never makes another run
    expect(await fixer('blue', 'h1')).toBeNull();
    const next = await fixer('blue', 'h2');
    expect(next).toMatchObject({ trigger_sha: 'h2' });
    expect(await runs.countTriggered(taskId, 'fixer', 'conflict_cap')).toBe(2);
    await runs.update(next!.id, 'blue', { status: 'blocked', waiting_reason: 'conflict_cap', ended_at: new Date() });
    expect(await runs.countTriggered(taskId, 'fixer', 'conflict_cap')).toBe(1);
    // queue runs carry no trigger and are not limited by it
    expect(await claim('blue')).not.toBeNull();
  });

  it('sums the fixes typed into the card\'s runs (red CI, D21)', async () => {
    expect(await runs.sumFixCount(taskId)).toBe(0);
    const first = (await claim('blue'))!;
    await runs.bump(first.id, 'fix_count');
    await runs.bump(first.id, 'fix_count');
    await runs.update(first.id, 'blue', { status: 'done', ended_at: new Date() });
    const second = (await claim('blue'))!;
    await runs.bump(second.id, 'fix_count');
    expect(await runs.sumFixCount(taskId)).toBe(3);
  });

  it('an epic\'s integrator runs (Task 26): one per epic branch head, and their statuses for the cap', async () => {
    const integrator = (instance: string, sha: string) => runs.claim({ project_id: projectId, task_id: taskId, role: 'integrator', instance, trigger_sha: sha });
    const results = await Promise.all([integrator('blue', 'e1'), integrator('green', 'e1')]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const first = results.find((r) => r !== null)!;
    expect(await runs.triggeredStatuses(taskId, 'integrator')).toEqual(['queued']);
    await runs.update(first.id, first.claimed_by, { status: 'blocked', ended_at: new Date() });
    expect(await integrator('blue', 'e1')).toBeNull();
    expect(await integrator('blue', 'e2')).not.toBeNull();
    expect((await runs.triggeredStatuses(taskId, 'integrator')).sort()).toEqual(['blocked', 'queued']);
    // other roles and queue runs are not counted
    expect(await runs.triggeredStatuses(taskId, 'fixer')).toEqual([]);
  });

  it('many concurrent claims across two colours still leave one active run', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(i % 2 ? 'blue' : 'green')));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await runs.countActive(projectId)).toBe(1);
  });

  it('a finished run frees the card: a new claim succeeds', async () => {
    const first = (await claim('blue'))!;
    expect(await claim('blue')).toBeNull();
    await runs.update(first.id, 'blue', { status: 'done', ended_at: new Date() });
    const second = await claim('green');
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
    expect(await db.automationRun.count({ where: { taskId } })).toBe(2);
  });

  it('updateActive ends a run once: a second end, or one under another instance, writes nothing', async () => {
    const run = (await claim('blue'))!;
    await runs.update(run.id, 'blue', { status: 'running' });
    expect(await runs.updateActive(run.id, 'green', { status: 'done', ended_at: new Date() })).toBe(false);
    expect(await runs.updateActive(run.id, 'blue', { status: 'done', ended_at: new Date() })).toBe(true);
    expect(await runs.updateActive(run.id, 'blue', { status: 'blocked', waiting_reason: 'x' })).toBe(false);
    expect(await runs.findById(run.id)).toMatchObject({ status: 'done', waiting_reason: null });
  });

  it('restart_count starts at 0 and is bumped on its own', async () => {
    const run = (await claim('blue'))!;
    expect(run.restart_count).toBe(0);
    expect(await runs.bump(run.id, 'restart_count')).toBe(1);
    expect(await runs.findById(run.id)).toMatchObject({ restart_count: 1, resume_count: 0, fix_count: 0 });
  });

  it('stores the run\'s allow list, and followedBy lists only this instance\'s running and waiting runs', async () => {
    const run = (await claim('blue'))!;
    expect(run.allowed_tools).toBeNull();
    await runs.update(run.id, 'blue', { status: 'running', allowed_tools: ['Bash(make:*)'] });
    expect((await runs.findById(run.id))!.allowed_tools).toEqual(['Bash(make:*)']);
    expect((await runs.followedBy('blue')).map((r) => r.id)).toContain(run.id);
    expect((await runs.followedBy('green')).map((r) => r.id)).not.toContain(run.id);
    await runs.update(run.id, 'blue', { status: 'waiting' });
    expect((await runs.followedBy('blue')).map((r) => r.id)).toContain(run.id);
    await runs.update(run.id, 'blue', { status: 'done' });
    expect((await runs.followedBy('blue')).map((r) => r.id)).not.toContain(run.id);
  });

  it('runs on different cards do not collide', async () => {
    const other = newId();
    await db.task.create({ data: { id: other, projectId, title: 'other' } });
    expect(await claim('blue')).not.toBeNull();
    expect(await claim('blue', other)).not.toBeNull();
    expect(await runs.countActive(projectId)).toBe(2);
  });

  it('update writes the patch; bump returns the new count', async () => {
    const run = (await claim('blue'))!;
    const started = new Date('2026-10-05T10:00:00Z');
    await runs.update(run.id, 'blue', { status: 'running', tab_id: 'tab-1', machine_id: machineId, account_id: 'acc-1', branch: 'auto/ter-1', worktree_path: '/w/ter-1', started_at: started });
    expect(await runs.bump(run.id, 'resume_count')).toBe(1);
    expect(await runs.bump(run.id, 'resume_count')).toBe(2);
    expect(await runs.bump(run.id, 'fix_count')).toBe(1);
    const active = await runs.activeByTab('tab-1');
    expect(active).toMatchObject({ id: run.id, status: 'running', machine_id: machineId, account_id: 'acc-1', branch: 'auto/ter-1', worktree_path: '/w/ter-1', resume_count: 2, fix_count: 1 });
    expect(active!.started_at?.toISOString()).toBe(started.toISOString());
    await runs.update(run.id, 'blue', { status: 'waiting', waiting_reason: 'question' });
    expect((await runs.activeByProject(projectId)).map((r) => [r.id, r.waiting_reason])).toEqual([[run.id, 'question']]);
    await runs.update(run.id, 'blue', { status: 'blocked' });
    expect(await runs.activeByTab('tab-1')).toBeNull();
    expect(await runs.activeByProject(projectId)).toEqual([]);
    expect(await runs.countActive(projectId)).toBe(0);
  });

  it('update writes only while the instance still drives the run; release frees an unstarted claim', async () => {
    const run = (await claim('blue'))!;
    expect(await runs.update(run.id, 'green', { status: 'running' })).toBe(false); // taken over by nobody: not green's
    expect((await runs.findById(run.id))!.status).toBe('queued');
    expect(await runs.release(run.id, 'green')).toBe(false);
    expect(await runs.release(run.id, 'blue')).toBe(true);
    expect(await runs.findById(run.id)).toBeNull();
    expect(await claim('green')).not.toBeNull(); // the card is free again
  });

  it('release never deletes a run that started', async () => {
    const run = (await claim('blue'))!;
    await runs.update(run.id, 'blue', { status: 'running', tab_id: 'tab-1' });
    expect(await runs.release(run.id, 'blue')).toBe(false);
    expect(await runs.findById(run.id)).not.toBeNull();
  });

  it('after a takeover, the old instance can no longer write the run', async () => {
    const run = (await claim('blue'))!;
    await db.automationRun.update({ where: { id: run.id }, data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    expect((await runs.takeOver('green', 120_000)).map((r) => r.id)).toEqual([run.id]);
    expect(await runs.update(run.id, 'blue', { status: 'failed' })).toBe(false);
    expect(await runs.update(run.id, 'green', { status: 'running' })).toBe(true);
    expect((await runs.findById(run.id))!).toMatchObject({ status: 'running', claimed_by: 'green' });
  });

  it('heartbeat refreshes only the active runs of its instance', async () => {
    const other = newId();
    await db.task.create({ data: { id: other, projectId, title: 'other' } });
    const mine = (await claim('blue'))!;
    const theirs = (await claim('green', other))!;
    const old = new Date(Date.now() - 10 * 60_000);
    await db.automationRun.updateMany({ where: { id: { in: [mine.id, theirs.id] } }, data: { heartbeatAt: old } });
    await runs.heartbeat('blue');
    const rows = await db.automationRun.findMany({ where: { projectId } });
    expect(rows.find((r) => r.id === mine.id)!.heartbeatAt.getTime()).toBeGreaterThan(old.getTime());
    expect(rows.find((r) => r.id === theirs.id)!.heartbeatAt.getTime()).toBe(old.getTime());
  });

  it('takeOver moves stale runs to the new instance once, even when two instances race', async () => {
    const tasks = [taskId, newId(), newId()];
    for (const t of tasks.slice(1)) await db.task.create({ data: { id: t, projectId, title: t } });
    const stale = (await claim('blue', tasks[0]))!;
    const stale2 = (await claim('blue', tasks[1]))!;
    const fresh = (await claim('blue', tasks[2]))!;
    const old = new Date(Date.now() - 10 * 60_000);
    await db.automationRun.updateMany({ where: { id: { in: [stale.id, stale2.id] } }, data: { heartbeatAt: old } });
    const finished = (await db.automationRun.create({
      data: { id: newId(), projectId, taskId: tasks[2], role: 'implementer', status: 'done', claimedBy: 'blue', heartbeatAt: old },
    }));

    const staleBefore = new Date(Date.now() - 60_000);
    const [a, b] = await Promise.all([runs.takeOver('green', 60_000), runs.takeOver('red', 60_000)]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(ids.sort()).toEqual([stale.id, stale2.id].sort()); // no duplicate, no fresh or finished run
    for (const r of [...a.map((x) => ({ ...x, by: 'green' })), ...b.map((x) => ({ ...x, by: 'red' }))]) {
      expect(r.claimed_by).toBe(r.by);
      expect(r.heartbeat_at.getTime()).toBeGreaterThan(staleBefore.getTime());
    }
    expect(await runs.takeOver('red', 60_000)).toEqual([]); // taken over already: fresh heartbeat
    const untouched = await db.automationRun.findMany({ where: { id: { in: [fresh.id, finished.id] } } });
    expect(untouched.every((r) => r.claimedBy === 'blue')).toBe(true);
  });

  it('a deleted card keeps its runs with task_id null; the sweep cancels the active ones and returns their worktrees', async () => {
    const run = (await claim('blue'))!;
    await runs.update(run.id, 'blue', { status: 'running', machine_id: machineId, worktree_path: '/w/ter-1' });
    const done = await db.automationRun.create({ data: { id: newId(), projectId, taskId, role: 'implementer', status: 'done', claimedBy: 'blue' } });
    await db.task.delete({ where: { id: taskId } });

    const swept = await runs.cancelOrphaned();
    expect(swept.filter((s) => s.id === run.id || s.id === done.id)).toEqual([expect.objectContaining({ id: run.id, project_id: projectId, machine_id: machineId, worktree_path: '/w/ter-1', cleanup_state: 'due' })]);
    const rows = await db.automationRun.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.id, r.taskId, r.status])).toEqual([
      [run.id, null, 'cancelled'],
      [done.id, null, 'done'],
    ]);
    expect(rows[0]!.endedAt).not.toBeNull();
    expect((await runs.cancelOrphaned()).some((s) => s.id === run.id)).toBe(false);
  });

  it('cleanup: marked due once per card, settled by one caller, listed per project, bounded by attempts', async () => {
    const run = (await claim('blue'))!;
    await runs.update(run.id, 'blue', { status: 'running', machine_id: machineId, worktree_path: '/w/ter-1', tab_id: null });
    await db.automationRun.update({ where: { id: run.id }, data: { status: 'done' } });
    const bare = await db.automationRun.create({ data: { id: newId(), projectId, taskId, role: 'fixer', status: 'done', claimedBy: 'blue' } });
    expect((await runs.markCleanupDue([taskId])).map((r) => r.id)).toEqual([run.id]); // the run with nothing to clean is not marked
    expect((await runs.markCleanupDue([]))).toEqual([]);
    expect((await runs.dueCleanups(projectId)).map((r) => r.id)).toEqual([run.id]);
    expect(await runs.bumpCleanup(run.id)).toBe(1);
    expect(await runs.settleCleanup(run.id, 'kept')).toBe(true);
    expect(await runs.settleCleanup(run.id, 'done')).toBe(false); // already settled by the other colour
    expect((await runs.markCleanupDue([taskId])).length).toBe(0); // settled stays settled
    expect(await runs.dueCleanups(projectId)).toEqual([]);
    expect((await db.automationRun.findUnique({ where: { id: bare.id } }))!.cleanupState).toBeNull();
  });

  it('runs go with their project', async () => {
    await claim('blue');
    await db.project.delete({ where: { id: projectId } });
    expect(await db.automationRun.count({ where: { projectId } })).toBe(0);
  });

  describe('ai account exhaustions', () => {
    const account = async () => (await db.aiAccount.create({ data: { id: newId(), provider: 'claude', label: 'a', machineId } })).id;

    it('activeIds ignores expired rows; clearExpired deletes and returns them', async () => {
      const [live, expired] = [await account(), await account()];
      const now = new Date('2026-10-05T12:00:00Z');
      await exhaustions.mark(live, new Date('2026-10-05T15:00:00Z'), 'usage_limit');
      await exhaustions.mark(expired, new Date('2026-10-05T11:00:00Z'), 'usage_limit');
      const active = await exhaustions.activeIds(now);
      expect(active.has(live)).toBe(true);
      expect(active.has(expired)).toBe(false);
      expect((await exhaustions.clearExpired(now)).filter((id) => id === live || id === expired)).toEqual([expired]);
      expect(await db.aiAccountExhaustion.findUnique({ where: { accountId: expired } })).toBeNull();
      expect(await db.aiAccountExhaustion.findUnique({ where: { accountId: live } })).not.toBeNull();
    });

    it('mark again moves the deadline (one row per account); the row goes with the account', async () => {
      const id = await account();
      const now = new Date('2026-10-05T12:00:00Z');
      await exhaustions.mark(id, new Date('2026-10-05T11:00:00Z'), 'usage_limit');
      expect((await exhaustions.activeIds(now)).has(id)).toBe(false);
      await exhaustions.mark(id, new Date('2026-10-05T18:00:00Z'), 'weekly_limit');
      expect((await exhaustions.activeIds(now)).has(id)).toBe(true);
      expect(await db.aiAccountExhaustion.findUnique({ where: { accountId: id } })).toMatchObject({ reason: 'weekly_limit' });
      await db.aiAccount.delete({ where: { id } });
      expect(await db.aiAccountExhaustion.count({ where: { accountId: id } })).toBe(0);
    });
  });
});
