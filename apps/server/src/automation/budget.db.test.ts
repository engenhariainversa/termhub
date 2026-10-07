import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { newId } from '../lib/ids.js';
import { setupSchema } from '../setup/schema.js';
import { budgetReached, dailyBudget } from './budget.js';
import { dayIn } from './usage.js';

const keyOf = (id: string) => 'B' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
const auto = (o: object) => setupSchema.parse({ automation: { enabled: true, ...o } }).automation;

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('budget (Postgres)', () => {
  let db: PrismaClient;
  let repos: Repositories;
  let userId: string;
  let projectId: string;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    userId = newId();
    projectId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'u', timeZone: 'America/Sao_Paulo' } });
    await db.project.create({ data: { id: projectId, ownerId: userId, key: keyOf(projectId), name: 'p' } });
    // a usage cursor needs its tab (TER-974)
    const machineId = newId();
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent', ownerId: userId } });
    await db.tab.create({ data: { id: `t-${projectId}`, projectId, machineId, name: 'tab' } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.delete({ where: { id: userId } });
    };
  });

  it('concurrent callers (the two colours) claim the once-a-day notice once: one event, one chat line', async () => {
    const a = auto({ daily_budget_usd: 10 });
    await repos.tabUsage.record({
      tab_id: `t-${projectId}`, project_id: projectId, task_id: null, account_id: null, day: dayIn('America/Sao_Paulo', new Date('2026-10-05T12:00:00Z')),
      model: 'm', from: null, to: { session_id: '0f8fad5b-d9cb-469f-a165-70867728950e', offset: 1 }, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost_usd: 11,
    });
    const now = new Date('2026-10-05T12:00:00Z');
    const results = await Promise.all(Array.from({ length: 8 }, () => budgetReached(repos, projectId, a, now)));
    expect(results.every(Boolean)).toBe(true);
    const events = await db.automationEvent.findMany({ where: { projectId, kind: 'budget_hit' } });
    expect(events).toHaveLength(1);
    const conv = await repos.chat.findLatestActiveForProject(projectId, userId);
    const messages = conv ? await db.chatMessage.count({ where: { conversationId: conv.id } }) : 0;
    expect(messages).toBe(1);
  });

  it('the meter and the budget use the same owner-zone day: 01:30 UTC is still yesterday in São Paulo', async () => {
    const at = new Date('2026-10-06T01:30:00Z');
    const day = dayIn(await repos.tabUsage.ownerTimeZone(projectId), at);
    expect(day).toBe('2026-10-05');
    await repos.tabUsage.record({
      tab_id: `t-${projectId}`, project_id: projectId, task_id: null, account_id: null, day,
      model: 'm', from: null, to: { session_id: '0f8fad5b-d9cb-469f-a165-70867728950e', offset: 1 }, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost_usd: 3,
    });
    expect(await dailyBudget(repos, projectId, auto({ daily_budget_usd: 10 }), at)).toMatchObject({ day: '2026-10-05', spent: 3 });
    // a minute after local midnight (03:00 UTC) the new day starts from zero
    expect(await dailyBudget(repos, projectId, auto({ daily_budget_usd: 10 }), new Date('2026-10-06T03:01:00Z'))).toMatchObject({ day: '2026-10-06', spent: 0 });
  });
});
