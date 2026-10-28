import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ProjectsRepository } from './projects.js';
import { firstColumnId } from './task-board.js';
import { TaskColumnsRepository } from './task-columns.js';

const keyOf = (id: string) => 'K' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TaskColumnsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: TaskColumnsRepository;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TaskColumnsRepository(db);
  });

  beforeEach(async () => {
    projectId = newId();
    await db.project.create({ data: { id: projectId, key: keyOf(projectId), name: 'p' } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const names = async () => (await repo.list(projectId)).map((c) => `${c.name}:${c.category}:${c.position}`);
  /** A top-level card placed straight in a column (TasksRepository is not under test here). */
  const card = async (columnId: string, category: 'todo' | 'doing' | 'done', position: number) =>
    (await db.task.create({ data: { id: newId(), projectId, title: `c${position}`, status: category, columnId, position } })).id;

  it('a new project comes with A fazer, Fazendo and Feito', async () => {
    const p = await new ProjectsRepository(db).create({ owner_id: null, key: keyOf(newId()), name: 'novo' });
    try {
      expect((await repo.list(p.id)).map((c) => [c.name, c.category, c.position])).toEqual([
        ['A fazer', 'todo', 0],
        ['Fazendo', 'doing', 1],
        ['Feito', 'done', 2],
      ]);
      expect(p.agent_column_id).toBeNull();
    } finally {
      await db.project.delete({ where: { id: p.id } });
    }
  });

  it('ensureDefaults fills a project without columns exactly once, even concurrently', async () => {
    await Promise.all([repo.ensureDefaults(projectId), repo.ensureDefaults(projectId), repo.ensureDefaults(projectId)]);
    expect(await names()).toEqual(['A fazer:todo:0', 'Fazendo:doing:1', 'Feito:done:2']);
  });

  it('appends a column and refuses the 13th', async () => {
    await repo.ensureDefaults(projectId);
    expect(await repo.create(projectId, { name: 'QA', category: 'doing' })).toMatchObject({ name: 'QA', category: 'doing', position: 3, project_id: projectId });
    for (let i = 0; i < 8; i++) await repo.create(projectId, { name: `c${i}`, category: 'todo' });
    await expect(repo.create(projectId, { name: 'x', category: 'todo' })).rejects.toMatchObject({ code: 'TOO_MANY_COLUMNS', message: 'Limite de 12 colunas' });
    expect(await repo.list(projectId)).toHaveLength(12);
  });

  it('renames and reorders, keeping positions compact', async () => {
    await repo.ensureDefaults(projectId);
    const [todo, , done] = await repo.list(projectId);
    await repo.rename(todo.id, 'Pronto p/ começar');
    expect((await repo.move(done.id, 0))?.map((c) => c.name)).toEqual(['Feito', 'Pronto p/ começar', 'Fazendo']);
    expect(await names()).toEqual(['Feito:done:0', 'Pronto p/ começar:todo:1', 'Fazendo:doing:2']);
    expect(await repo.rename('nope', 'x')).toBeUndefined();
    expect(await repo.move('nope', 0)).toBeUndefined();
  });

  it('changing the category carries the status of its cards along; the last of a category cannot change', async () => {
    await repo.ensureDefaults(projectId);
    const [todo, doing] = await repo.list(projectId);
    const review = await repo.create(projectId, { name: 'Em revisão', category: 'todo' });
    const c = await card(review.id, 'todo', 0);
    expect(await repo.setCategory(review.id, 'doing')).toMatchObject({ category: 'doing' });
    expect((await db.task.findUniqueOrThrow({ where: { id: c } })).status).toBe('doing');
    await expect(repo.setCategory(todo.id, 'done')).rejects.toMatchObject({ code: 'COLUMN_LAST_OF_CATEGORY', message: 'O board precisa de ao menos uma coluna de cada tipo' });
    expect((await repo.findById(doing.id))?.category).toBe('doing');
    // the agent column stops being one when it leaves doing
    await repo.setAgentColumn(projectId, review.id);
    expect(await repo.setCategory(review.id, 'done')).toMatchObject({ category: 'done' });
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).agentColumnId).toBeNull();
  });

  it('deleting a column moves its cards to the end of the first other column of that category', async () => {
    await repo.ensureDefaults(projectId);
    const [, doing] = await repo.list(projectId);
    const qa = await repo.create(projectId, { name: 'QA', category: 'doing' });
    const kept = await card(doing.id, 'doing', 0);
    const a = await card(qa.id, 'doing', 0);
    const b = await card(qa.id, 'doing', 1);
    expect(await repo.delete(qa.id)).toEqual({ moved_tasks: 2 });
    const rows = await db.task.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
    expect(rows.map((r) => [r.id, r.columnId, r.position])).toEqual([[kept, doing.id, 0], [a, doing.id, 1], [b, doing.id, 2]]);
    expect(await names()).toEqual(['A fazer:todo:0', 'Fazendo:doing:1', 'Feito:done:2']);
    expect(await repo.delete('nope')).toBeUndefined();
  });

  it('refuses to delete the last column of a category', async () => {
    await repo.ensureDefaults(projectId);
    const [, , done] = await repo.list(projectId);
    await expect(repo.delete(done.id)).rejects.toMatchObject({ code: 'COLUMN_LAST_OF_CATEGORY' });
    expect(await repo.list(projectId)).toHaveLength(3);
  });

  it('the agent column must be a doing column of the project, and falls back to automatic when it is deleted', async () => {
    await repo.ensureDefaults(projectId);
    const [todo] = await repo.list(projectId);
    const qa = await repo.create(projectId, { name: 'QA', category: 'doing' });
    await repo.setAgentColumn(projectId, qa.id);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).agentColumnId).toBe(qa.id);
    await repo.delete(qa.id);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).agentColumnId).toBeNull();
    await expect(repo.setAgentColumn(projectId, 'nope')).rejects.toMatchObject({ code: 'COLUMN_NOT_FOUND' });
    await expect(repo.setAgentColumn(projectId, todo.id)).rejects.toMatchObject({ code: 'COLUMN_NOT_DOING', message: 'A coluna do agente precisa ser do tipo Fazendo' });
    await repo.setAgentColumn(projectId, null);
  });

  it('racing setCategory and setAgentColumn on the same column never leaves a non-doing agent column', async () => {
    await repo.ensureDefaults(projectId);
    const qa = await repo.create(projectId, { name: 'QA', category: 'doing' });
    for (let i = 0; i < 8; i++) {
      await repo.setAgentColumn(projectId, qa.id);
      // Both fire in the same tick, so which transaction's lock wins varies run to run; the
      // invariant below must hold regardless of who wins.
      await Promise.allSettled([repo.setCategory(qa.id, 'done'), repo.setAgentColumn(projectId, qa.id)]);
      const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      if (project.agentColumnId) {
        expect((await repo.findById(project.agentColumnId))?.category).toBe('doing');
      } else {
        expect(project.agentColumnId).toBeNull();
      }
      // "Fazendo" (the default) stays `doing` throughout, so this is always allowed.
      await repo.setCategory(qa.id, 'doing');
    }
  });

  it('deleting a project whose agent column is set removes it cleanly', async () => {
    await repo.ensureDefaults(projectId);
    const [, doing] = await repo.list(projectId);
    await repo.setAgentColumn(projectId, doing.id);
    await card(doing.id, 'doing', 0);
    await db.project.delete({ where: { id: projectId } });
    expect(await db.taskColumn.count({ where: { projectId } })).toBe(0);
    expect(await db.task.count({ where: { projectId } })).toBe(0);
  });
  describe('waiting columns (TER-1134)', () => {
    it('creates a waiting column and marks or clears an existing one', async () => {
      await repo.ensureDefaults(projectId);
      const wait = await repo.create(projectId, { name: 'Esperando validação', category: 'doing', waiting: true });
      expect(wait).toMatchObject({ category: 'doing', waiting: true });
      expect(await repo.setWaiting(wait.id, false)).toMatchObject({ waiting: false });
      expect(await repo.setWaiting(wait.id, true)).toMatchObject({ waiting: true });
      expect(await repo.setWaiting('nope', true)).toBeUndefined();
    });

    it('keeps one column of each category that is not waiting', async () => {
      await repo.ensureDefaults(projectId);
      const [, doing] = await repo.list(projectId);
      const wait = await repo.create(projectId, { name: 'Esperando', category: 'doing', waiting: true });
      await expect(repo.setWaiting(doing.id, true)).rejects.toMatchObject({ code: 'COLUMN_LAST_ACTIVE' });
      await expect(repo.delete(doing.id)).rejects.toMatchObject({ code: 'COLUMN_LAST_ACTIVE' });
      await expect(repo.setCategory(doing.id, 'done')).rejects.toMatchObject({ code: 'COLUMN_LAST_ACTIVE' });
      // the waiting one may go: Fazendo stays
      await card(wait.id, 'doing', 0);
      expect(await repo.delete(wait.id)).toEqual({ moved_tasks: 1 });
    });

    it('a waiting column is never the agent column; marking the agent column sends the project back to automatic', async () => {
      await repo.ensureDefaults(projectId);
      const wait = await repo.create(projectId, { name: 'Esperando', category: 'doing', waiting: true });
      await expect(repo.setAgentColumn(projectId, wait.id)).rejects.toMatchObject({ code: 'COLUMN_WAITING_AGENT' });
      const qa = await repo.create(projectId, { name: 'QA', category: 'doing' });
      await repo.setAgentColumn(projectId, qa.id);
      await repo.setWaiting(qa.id, true);
      expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).agentColumnId).toBeNull();
    });

    it('moves by status skip a waiting column that comes first', async () => {
      await repo.ensureDefaults(projectId);
      const wait = await repo.create(projectId, { name: 'Esperando', category: 'doing', waiting: true });
      await repo.move(wait.id, 0);
      const [doing] = (await repo.list(projectId)).filter((c) => c.category === 'doing' && !c.waiting);
      const first = await db.$transaction((tx) => firstColumnId(tx, projectId, 'doing'));
      expect(first).toBe(doing.id);
    });
  });
});
