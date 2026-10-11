import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { AutomationEventsRepository } from './automation-events.js';
import { AutomationPausesRepository } from './automation-pauses.js';

const keyOf = (id: string) => 'E' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('automation events and pauses (Postgres)', () => {
  let db: PrismaClient;
  let events: AutomationEventsRepository;
  let pauses: AutomationPausesRepository;
  let userId: string;
  let projectId: string;
  let taskId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    events = new AutomationEventsRepository(db);
    pauses = new AutomationPausesRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    projectId = newId();
    taskId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'u' } });
    await db.project.create({ data: { id: projectId, ownerId: userId, key: keyOf(projectId), name: 'p' } });
    await db.task.create({ data: { id: taskId, projectId, title: 't' } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
      await db.user.delete({ where: { id: userId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('stores a flat payload and lists newest first, paging back with before', async () => {
    const a = await events.insert({ project_id: projectId, task_id: taskId, kind: 'run_started', payload: { machine_id: 'm1' } });
    await db.automationEvent.update({ where: { id: a.id }, data: { createdAt: new Date('2026-10-01T10:00:00Z') } });
    const b = await events.insert({ project_id: projectId, task_id: taskId, run_id: 'r1', kind: 'pr_opened', payload: { url: 'https://github.com/a/b/pull/1', number: 1 } });
    await db.automationEvent.update({ where: { id: b.id }, data: { createdAt: new Date('2026-10-01T11:00:00Z') } });

    const page = await events.listByProject(projectId, { limit: 10 });
    expect(page.map((e) => e.kind)).toEqual(['pr_opened', 'run_started']);
    expect(page[0]).toMatchObject({ task_id: taskId, run_id: 'r1', payload: { url: 'https://github.com/a/b/pull/1', number: 1 }, created_at: '2026-10-01T11:00:00.000Z' });
    expect((await events.listByProject(projectId, { before: new Date(page[0]!.created_at), limit: 10 })).map((e) => e.id)).toEqual([a.id]);
    expect(await events.listByProject(projectId, { limit: 1 })).toHaveLength(1);
  });

  it('keeps the event when its card is deleted, and drops it with the project', async () => {
    await events.insert({ project_id: projectId, task_id: taskId, kind: 'run_done' });
    await db.task.delete({ where: { id: taskId } });
    const [row] = await events.listByProject(projectId, { limit: 10 });
    expect(row).toMatchObject({ task_id: null, payload: {} });
    await db.project.delete({ where: { id: projectId } });
    expect(await db.automationEvent.count({ where: { projectId } })).toBe(0);
  });

  it('a ci_fix_requested claim is taken once per card, PR and head SHA, even by concurrent callers (F-27)', async () => {
    const claim = (pr: number, sha: string) => events.insertOnce({ project_id: projectId, task_id: taskId, kind: 'ci_fix_requested', payload: { pr, sha, via: 'pending' } });
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(7, 'h1')));
    const won = results.filter((r) => r !== null);
    expect(won).toHaveLength(1);
    // another head, another PR: their own claims
    expect(await claim(7, 'h2')).not.toBeNull();
    expect(await claim(8, 'h1')).not.toBeNull();
    // other kinds are never limited
    expect(await events.insertOnce({ project_id: projectId, task_id: taskId, kind: 'escalated', payload: { pr: 7, sha: 'h1' } })).not.toBeNull();
    expect(await events.insertOnce({ project_id: projectId, task_id: taskId, kind: 'escalated', payload: { pr: 7, sha: 'h1' } })).not.toBeNull();

    // settled: the outcome replaces the payload, and the head stays taken
    expect(await events.setPayload(won[0]!.id, { pr: 7, sha: 'h1', via: 'typed' })).toMatchObject({ payload: { pr: 7, sha: 'h1', via: 'typed' } });
    expect(await claim(7, 'h1')).toBeNull();
    // given back: taken again
    await events.remove(won[0]!.id);
    const again = await claim(7, 'h1');
    expect(again).not.toBeNull();

    // a pending claim is removed only once it is older than the cutoff, and a settled one never
    const past = new Date(Date.now() + 60_000);
    expect(await events.removeStale(taskId, 'ci_fix_requested', { pr: 7, sha: 'h1', via: 'pending' }, new Date(Date.now() - 60_000))).toBe(0);
    expect(await events.removeStale(taskId, 'ci_fix_requested', { pr: 7, sha: 'h1', via: 'pending' }, past)).toBe(1);
    await events.setPayload((await claim(7, 'h1'))!.id, { pr: 7, sha: 'h1', via: 'fixer' });
    expect(await events.removeStale(taskId, 'ci_fix_requested', { pr: 7, sha: 'h1', via: 'pending' }, past)).toBe(0);
  });

  it('findOnce reads a claim by its payload, and replacePayloadIf moves it once (final review I3)', async () => {
    const row = (await events.insertOnce({ project_id: projectId, task_id: taskId, kind: 'ci_fix_requested', payload: { pr: 7, sha: 'h1', via: 'fixer' } }))!;
    expect((await events.findOnce(taskId, 'ci_fix_requested', { pr: 7, sha: 'h1' }))?.id).toBe(row.id);
    expect(await events.findOnce(taskId, 'ci_fix_requested', { pr: 7, sha: 'h2' })).toBeNull();
    const moves = await Promise.all([1, 2].map(() => events.replacePayloadIf(row.id, { via: 'fixer' }, { pr: 7, sha: 'h1', via: 'escalated' })));
    expect(moves.filter((m) => m !== null)).toEqual([expect.objectContaining({ id: row.id, payload: { pr: 7, sha: 'h1', via: 'escalated' } })]);
  });

  it('purges events older than the cutoff only', async () => {
    const old = await events.insert({ project_id: projectId, kind: 'paused' });
    await db.automationEvent.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 31 * 24 * 3600_000) } });
    const fresh = await events.insert({ project_id: projectId, kind: 'resumed' });
    await events.purgeBefore(new Date(Date.now() - 30 * 24 * 3600_000));
    expect((await events.listByProject(projectId, { limit: 10 })).map((e) => e.id)).toEqual([fresh.id]);
  });

  it('pauses keep the first timestamp and say whether this call paused', async () => {
    const t1 = new Date('2026-10-05T10:00:00Z');
    expect(await pauses.pauseProject(projectId, t1)).toEqual({ paused_at: t1, fresh: true });
    expect(await pauses.pauseProject(projectId, new Date('2026-10-05T11:00:00Z'))).toEqual({ paused_at: t1, fresh: false });
    expect(await pauses.pauseUser(userId, t1)).toEqual({ paused_at: t1, fresh: true });
    expect(await pauses.state(userId, projectId)).toEqual({ user: t1, project: t1 });
    expect(await pauses.resumeProject(projectId)).toBe(true);
    expect(await pauses.resumeProject(projectId)).toBe(false);
    expect(await pauses.resumeUser(userId)).toBe(true);
    expect(await pauses.state(userId, projectId)).toEqual({ user: null, project: null });
    expect(await pauses.state(null, projectId)).toEqual({ user: null, project: null });
  });
});
