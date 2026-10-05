import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { TaskRuleError, TasksRepository } from './tasks.js';

const keyOf = (id: string) => 'K' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('tasks.auto (Postgres)', () => {
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

  async function seedEpicWithTwoCards() {
    const epic = await repo.create(projectId, { title: 'epic', type: 'epic' });
    const a = await repo.create(projectId, { title: 'a', epic_id: epic.id });
    const b = await repo.create(projectId, { title: 'b', epic_id: epic.id });
    return { epic, a, b };
  }
  const auto = async (id: string) => (await repo.findById(id))!.auto;

  it('marking an epic marks the epic and every top-level card in it', async () => {
    const { epic, a, b } = await seedEpicWithTwoCards();
    const sub = (await repo.createSubtasks(a.id, [{ title: 's' }]))[0];
    expect((await repo.setAuto(epic.id, true)).changed).toBe(3);
    expect(await auto(epic.id)).toBe(true);
    expect(await auto(a.id)).toBe(true);
    expect(await auto(b.id)).toBe(true);
    expect(await auto(sub.id)).toBe(false);
  });

  it('unmarking an epic clears cards marked one by one too (spec D2)', async () => {
    const { epic, a } = await seedEpicWithTwoCards();
    await repo.setAuto(a.id, true);
    await repo.setAuto(epic.id, true);
    await repo.setAuto(epic.id, false);
    expect(await auto(a.id)).toBe(false);
    expect(await auto(epic.id)).toBe(false);
  });

  it('marking one card leaves its epic and siblings alone', async () => {
    const { epic, a, b } = await seedEpicWithTwoCards();
    expect(await repo.setAuto(a.id, true)).toEqual({ changed: 1 });
    expect(await auto(epic.id)).toBe(false);
    expect(await auto(b.id)).toBe(false);
  });

  it('a card created in an automatic epic is born automatic, even with auto: false', async () => {
    const { epic } = await seedEpicWithTwoCards();
    await repo.setAuto(epic.id, true);
    expect((await repo.create(projectId, { title: 'novo', epic_id: epic.id })).auto).toBe(true);
    expect((await repo.create(projectId, { title: 'novo2', epic_id: epic.id, auto: false })).auto).toBe(true);
  });

  it('a card can be created automatic in a plain epic', async () => {
    const { epic } = await seedEpicWithTwoCards();
    expect((await repo.create(projectId, { title: 'x', epic_id: epic.id, auto: true })).auto).toBe(true);
    expect((await repo.create(projectId, { title: 'y', epic_id: epic.id })).auto).toBe(false);
  });

  it('moving a card into an automatic epic marks it; moving out keeps it', async () => {
    const { epic: autoEpic } = await seedEpicWithTwoCards();
    await repo.setAuto(autoEpic.id, true);
    const plain = await repo.create(projectId, { title: 'plain', type: 'epic' });
    const c = await repo.create(projectId, { title: 'c', epic_id: plain.id });
    expect(c.auto).toBe(false);
    expect((await repo.update(c.id, { epic_id: autoEpic.id }))!.auto).toBe(true);
    expect((await repo.update(c.id, { epic_id: plain.id }))!.auto).toBe(true);
  });

  it('subtasks never carry the tag', async () => {
    const { a } = await seedEpicWithTwoCards();
    const [sub] = await repo.createSubtasks(a.id, [{ title: 's' }]);
    await expect(repo.setAuto(sub.id, true)).rejects.toEqual(new TaskRuleError('AUTO_NOT_FOR_SUBTASK'));
  });

  it('a ticket imported into an automatic default epic is not born automatic', async () => {
    const { epic } = await seedEpicWithTwoCards();
    await repo.setAuto(epic.id, true);
    // the default epic is the lowest-numbered one: tag it explicitly
    const def = (await db.task.findFirst({ where: { projectId, type: 'epic' }, orderBy: { number: 'asc' } }))!;
    await repo.setAuto(def.id, true);
    const imported = await repo.createFromTicket(projectId, { key: 'linear:1', title: 'T', description: null, ref: {} });
    expect(imported.auto).toBe(false);
  });
});
