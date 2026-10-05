import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { controlContextFor } from '../control/context.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { newId } from '../lib/ids.js';
import { pauseAutomation, resumeAutomation } from './pause.js';
import { automationQueue } from './queue.js';

const keyOf = (id: string) => 'K' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('automationQueue (Postgres)', () => {
  let db: PrismaClient;
  let repos: Repositories;
  let ownerId: string;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
  });

  beforeEach(async () => {
    ownerId = newId();
    projectId = newId();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' } });
    await db.project.create({ data: { id: projectId, ownerId, key: keyOf(projectId), name: 'p' } });
    return async () => {
      await db.project.delete({ where: { id: projectId } });
      await db.user.delete({ where: { id: ownerId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const ctx = () => controlContextFor(repos, { id: ownerId } as User);
  const setAutomation = async (enabled: boolean) => {
    const { data } = await repos.projectSetup.get(projectId);
    await repos.projectSetup.save(projectId, { ...data, automation: { ...data.automation, enabled } });
  };

  /** Tagged cards in two todo columns (the later column's card created first), plus an untagged one. */
  async function twoColumns() {
    const seed = await repos.tasks.create(projectId, { title: 'seed' }); // creates the default columns
    const todo = (await db.taskColumn.findFirst({ where: { projectId, category: 'todo' }, orderBy: { position: 'asc' } }))!;
    const last = (await db.taskColumn.findFirst({ where: { projectId }, orderBy: { position: 'desc' } }))!;
    const second = await db.taskColumn.create({ data: { id: newId(), projectId, name: 'A fazer 2', category: 'todo', position: last.position + 1 } });
    await repos.tasks.delete(seed.id);
    const b = await repos.tasks.create(projectId, { title: 'B in second column', column_id: second.id, auto: true, description: 'x' });
    const a2 = await repos.tasks.create(projectId, { title: 'A2 in first column', column_id: todo.id, auto: true, description: 'x' });
    const a1 = await repos.tasks.create(projectId, { title: 'A1 in first column', column_id: todo.id, auto: true, description: 'x' });
    await repos.tasks.create(projectId, { title: 'untagged', column_id: todo.id, description: 'x' });
    return { a1, a2, b };
  }

  it('comes out in board order: column position, then card position, tagged cards only', async () => {
    await setAutomation(true);
    const { a1, a2, b } = await twoColumns();
    const items = await automationQueue(ctx(), projectId);
    const positions = await db.task.findMany({ where: { id: { in: [a1.id, a2.id] } }, orderBy: { position: 'asc' } });
    expect(items.map((i) => i.task_id)).toEqual([...positions.map((p) => p.id), b.id]);
    expect(items.map((i) => i.reason)).toEqual(['no_capable_machine', 'no_capable_machine', 'no_capable_machine']);
  });

  it('a project with automation off reads automation_off on every tagged card', async () => {
    await setAutomation(false);
    await twoColumns();
    const items = await automationQueue(ctx(), projectId);
    expect(items).toHaveLength(3);
    expect(items.every((i) => !i.eligible && i.reason === 'automation_off' && i.reason_text === 'Trabalho automático desligado no projeto')).toBe(true);
  });

  it('a paused project reads paused on every tagged card, and resuming lifts it', async () => {
    await setAutomation(true);
    await twoColumns();
    await pauseAutomation(ctx(), { scope: projectId });
    expect((await automationQueue(ctx(), projectId)).map((i) => i.reason)).toEqual(['paused', 'paused', 'paused']);
    await resumeAutomation(ctx(), { scope: projectId });
    expect((await automationQueue(ctx(), projectId)).map((i) => i.reason)).toEqual(['no_capable_machine', 'no_capable_machine', 'no_capable_machine']);
  });

  it('"Pausar tudo" pauses the owner\'s projects', async () => {
    await setAutomation(true);
    await twoColumns();
    await pauseAutomation(ctx(), { scope: 'all' });
    const items = await automationQueue(ctx(), projectId);
    expect(items.every((i) => i.reason === 'paused' && i.reason_text === 'Automático pausado')).toBe(true);
    await resumeAutomation(ctx(), { scope: 'all' });
    expect((await automationQueue(ctx(), projectId)).some((i) => i.reason === 'paused')).toBe(false);
  });

  it('a project with automation off still reads automation_off when paused, and records no event on "Pausar tudo"', async () => {
    await setAutomation(false);
    await twoColumns();
    await pauseAutomation(ctx(), { scope: 'all' });
    const items = await automationQueue(ctx(), projectId);
    expect(items.every((i) => i.reason === 'automation_off')).toBe(true);
    expect(await repos.automationEvents.listByProject(projectId, { limit: 10 })).toEqual([]);
  });
  it('a card with an active run reads has_agent; a finished run frees it', async () => {
    await setAutomation(true);
    const { a1, b } = await twoColumns();
    const run = (await repos.automationRuns.claim({ project_id: projectId, task_id: b.id, role: 'implementer', instance: 'blue' }))!;
    const reasons = async () => new Map((await automationQueue(ctx(), projectId)).map((i) => [i.task_id, i.reason]));
    expect((await reasons()).get(b.id)).toBe('has_agent');
    expect((await reasons()).get(a1.id)).toBe('no_capable_machine');
    await repos.automationRuns.update(run.id, { status: 'done', ended_at: new Date() });
    expect((await reasons()).get(b.id)).toBe('no_capable_machine');
  });

  it('a project with automation off reads automation_off even with an active run', async () => {
    await setAutomation(false);
    const { b } = await twoColumns();
    await repos.automationRuns.claim({ project_id: projectId, task_id: b.id, role: 'implementer', instance: 'blue' });
    expect((await automationQueue(ctx(), projectId)).every((i) => i.reason === 'automation_off')).toBe(true);
  });
});
