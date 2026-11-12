import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { TabGcRepository } from './tab-gc.js';

const keyOf = (id: string) => 'G' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('tab GC repository (TER-1171, Postgres)', () => {
  let db: PrismaClient;
  let repo: TabGcRepository;
  let userId: string;
  let projectId: string;
  let machineId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TabGcRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    projectId = newId();
    machineId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'u' } });
    await db.machine.create({ data: { id: machineId, name: 'hulk', type: 'agent', ownerId: userId, idleTabCloseHours: 6, tabGc: { max_agent_tabs: 4 } } });
    await db.project.create({ data: { id: projectId, ownerId: userId, key: keyOf(projectId), name: 'p' } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.delete({ where: { id: userId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const tab = (id: string, over: Record<string, unknown> = {}) =>
    db.tab.create({ data: { id, projectId, machineId, name: id, tmuxSession: `th-${id}`, state: 'finished', stateTool: 'claude', stateAt: new Date('2026-11-10T10:00:00Z'), ...over } });

  it('lists only agent tabs with a session, oldest state first, with owner, top-level card and last event', async () => {
    const a = newId();
    const b = newId();
    await tab(a, { stateAt: new Date('2026-11-10T12:00:00Z') });
    await tab(b, { stateAt: new Date('2026-11-10T08:00:00Z') });
    await tab(newId(), { stateTool: null, state: null }); // a plain shell
    await tab(newId(), { tmuxSession: null }); // no session
    const card = newId();
    await db.task.create({ data: { id: card, projectId, title: 'c', status: 'done', tabId: a } });
    await db.task.create({ data: { id: newId(), projectId, title: 's', type: 'subtask', parentId: card, status: 'doing', tabId: a } });
    await db.tabEvent.create({ data: { id: newId(), tabId: a, kind: 'finished', tool: 'claude', createdAt: new Date('2026-11-10T13:00:00Z') } });

    const rows = await repo.listAgentTabs({ projectId });
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect(rows[1]).toMatchObject({ owner_id: userId, task: { id: card, status: 'done' }, last_event_at: '2026-11-10T13:00:00.000Z', gc_pinned: false, gc_warned_at: null });
    expect(rows[0]!.task).toBeNull();
    expect(await repo.listAgentTabs({ ownerId: newId() })).toEqual([]);
    expect((await repo.listAgentTabs({ machineId })).length).toBe(2);
  });

  it('warns once, clears, resets and pins', async () => {
    const id = newId();
    await tab(id);
    const now = new Date('2026-11-11T12:00:00Z');
    expect(await repo.warn(id, now, new Date('2026-11-10T10:00:00Z'))).toBe(true);
    expect(await repo.warn(id, now, null)).toBe(false);
    let [row] = await repo.listAgentTabs({ projectId });
    expect(row).toMatchObject({ gc_warned_at: now.toISOString(), gc_warned_state_at: '2026-11-10T10:00:00.000Z' });
    expect(await repo.clearWarning(id)).toBe(true);
    expect(await repo.clearWarning(id)).toBe(false);
    await repo.warn(id, now, null);
    await repo.reset(id, now);
    [row] = await repo.listAgentTabs({ projectId });
    expect(row).toMatchObject({ gc_warned_at: null, gc_reset_at: now.toISOString() });
    await repo.warn(id, now, null);
    await repo.setPinned(id, true);
    [row] = await repo.listAgentTabs({ projectId });
    expect(row).toMatchObject({ gc_pinned: true, gc_warned_at: null });
  });

  it('archives a collected tab, lists it by project and card, keeps it past the card and drops it with the project', async () => {
    const card = newId();
    await db.task.create({ data: { id: card, projectId, title: 'c', status: 'done' } });
    const a = await repo.archive({ project_id: projectId, task_id: card, tab_id: 'gone', tab_name: 'aba', machine_id: machineId, machine_name: 'hulk', tool: 'claude', state: 'finished', reason: 'idle', agent_session_id: 's', cwd: '/w', last_answer: 'Pronto.', last_answer_at: '2026-11-10T10:00:00.000Z' });
    expect((await repo.listArchive(projectId, { taskId: card })).map((r) => r.id)).toEqual([a.id]);
    expect((await repo.listArchive(projectId))[0]).toMatchObject({ last_answer: 'Pronto.', last_answer_at: '2026-11-10T10:00:00.000Z', reason: 'idle' });
    await db.task.delete({ where: { id: card } });
    expect((await repo.listArchive(projectId))[0]!.task_id).toBeNull();
    await db.project.delete({ where: { id: projectId } });
    expect(await db.tabGcArchive.count({ where: { id: a.id } })).toBe(0);
  });

  it('reads the user and machine levels', async () => {
    await db.user.update({ where: { id: userId }, data: { tabGc: { idle_hours: 12 } } });
    expect(await repo.userLevel(userId)).toEqual({ idle_hours: 12 });
    expect(await repo.machineLevel(machineId)).toEqual({ level: { max_agent_tabs: 4 }, idle_hours: 6 });
  });
});
