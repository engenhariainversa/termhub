import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { TabUsageRepository, type UsageWrite } from './tab-usage.js';

const keyOf = (id: string) => 'U' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
const S1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const tok = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('tab usage (Postgres)', () => {
  let db: PrismaClient;
  let usage: TabUsageRepository;
  let userId: string;
  let projectId: string;
  let taskId: string;

  const write = (over: Partial<UsageWrite>): UsageWrite => ({
    tab_id: 't-' + projectId,
    project_id: projectId,
    task_id: taskId,
    account_id: 'acc1',
    day: '2026-10-04',
    model: 'claude-opus-5-5',
    from: null,
    to: { session_id: S1, offset: 100 },
    tokens: tok(10, 20),
    cost_usd: 0.5,
    ...over,
  });

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    usage = new TabUsageRepository(db);
  });

  beforeEach(async () => {
    userId = newId();
    projectId = newId();
    taskId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'u', timeZone: 'America/Sao_Paulo' } });
    await db.project.create({ data: { id: projectId, ownerId: userId, key: keyOf(projectId), name: 'p' } });
    await db.task.create({ data: { id: taskId, projectId, title: 't' } });
    // a cursor needs its tab (TER-974): every tab id the tests write
    const machineId = newId();
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent', ownerId: userId } });
    await db.tab.createMany({ data: ['', '-a', '-b', '-c', '-x', '-y'].map((s) => ({ id: `t-${projectId}${s}`, projectId, machineId, name: 'tab' })) });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.deleteMany({ where: { id: userId } });
    };
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('moves the cursor only from where the caller read, and adds per day', async () => {
    expect(await usage.record(write({}))).toBe(true);
    expect(await usage.cursor('t-' + projectId)).toEqual({ session_id: S1, offset: 100 });
    // a second pass that also read from nothing lost the race: nothing counted twice
    expect(await usage.record(write({}))).toBe(false);
    expect(await usage.record(write({ from: { session_id: S1, offset: 100 }, to: { session_id: S1, offset: 250 }, tokens: tok(1, 2, 3, 4), cost_usd: 0.25 }))).toBe(true);
    expect(await usage.record(write({ from: { session_id: S1, offset: 100 }, to: { session_id: S1, offset: 300 } }))).toBe(false);
    // next day, an unknown model: the counts add, the cost stays as it was
    expect(await usage.record(write({ day: '2026-10-05', from: { session_id: S1, offset: 250 }, to: { session_id: S1, offset: 400 }, tokens: tok(5), cost_usd: null }))).toBe(true);
    expect(await usage.record(write({ day: '2026-10-05', from: { session_id: S1, offset: 400 }, to: { session_id: S1, offset: 500 }, tokens: tok(5), cost_usd: 0.1 }))).toBe(true);

    const rows = await db.tabUsageDay.findMany({ where: { projectId }, orderBy: { day: 'asc' } });
    expect(rows.map((r) => [r.day.toISOString().slice(0, 10), Number(r.inputTokens), Number(r.outputTokens), Number(r.cacheReadTokens), Number(r.cacheWriteTokens), r.costUsdEstimate?.toString()])).toEqual([
      ['2026-10-04', 11, 22, 3, 4, '0.75'],
      ['2026-10-05', 10, 0, 0, 0, '0.1'],
    ]);
  });

  it('keeps the cost null while nothing was priced, and moves the cursor without a row when nothing was counted', async () => {
    expect(await usage.record(write({ tokens: tok(0), cost_usd: null }))).toBe(true);
    expect(await db.tabUsageDay.count({ where: { projectId } })).toBe(0);
    expect(await usage.record(write({ from: { session_id: S1, offset: 100 }, to: { session_id: S1, offset: 200 }, cost_usd: null }))).toBe(true);
    const [row] = await db.tabUsageDay.findMany({ where: { projectId } });
    expect(row!.costUsdEstimate).toBeNull();
  });

  it('sums per card and account over a range, and keeps the rows when the card is deleted', async () => {
    await usage.record(write({ tab_id: `t-${projectId}-a`, day: '2026-10-03', cost_usd: 1 }));
    await usage.record(write({ tab_id: `t-${projectId}-b`, day: '2026-10-04', account_id: 'acc2', cost_usd: null }));
    await usage.record(write({ tab_id: `t-${projectId}-c`, day: '2026-10-05', cost_usd: 2 }));
    const all = await usage.sums(projectId);
    expect(all.map((s) => [s.account_id, s.tokens.input, s.cost_usd]).sort()).toEqual([
      ['acc1', 20, 3],
      ['acc2', 10, null],
    ]);
    const some = await usage.sums(projectId, { from: '2026-10-04', to: '2026-10-04' });
    expect(some).toEqual([{ task_id: taskId, account_id: 'acc2', tokens: tok(10, 20), cost_usd: null }]);
    await db.task.delete({ where: { id: taskId } });
    expect((await usage.sums(projectId)).every((s) => s.task_id === null)).toBe(true);
  });

  it('notes a Codex tab once per day with no counts, and totals per card', async () => {
    const w = { tab_id: `t-${projectId}-x`, project_id: projectId, task_id: taskId, account_id: null, day: '2026-10-04' };
    await usage.noteUnmetered(w);
    await usage.noteUnmetered(w);
    expect(await db.tabUsageDay.count({ where: { projectId } })).toBe(1);
    expect(await usage.totalsByTask([taskId, 'none'])).toEqual(new Map([[taskId, { tokens: 0, cost_usd: null }]]));
    await usage.record(write({ tab_id: `t-${projectId}-y`, tokens: tok(10, 20, 30, 40), cost_usd: 0.5 }));
    expect(await usage.totalsByTask([taskId])).toEqual(new Map([[taskId, { tokens: 100, cost_usd: 0.5 }]]));
    expect(await usage.totalsByTask([])).toEqual(new Map());
  });

  it('reads the owner\'s zone', async () => {
    expect(await usage.ownerTimeZone(projectId)).toBe('America/Sao_Paulo');
    expect(await usage.ownerTimeZone('nope')).toBeNull();
  });

  it('sums the project\'s cost on one day (unpriced rows count 0), in the same owner-zone day the meter writes', async () => {
    await usage.record(write({ tab_id: `t-${projectId}-a`, day: '2026-10-04', cost_usd: 1.25 }));
    await usage.record(write({ tab_id: `t-${projectId}-b`, day: '2026-10-04', cost_usd: null }));
    await usage.record(write({ tab_id: `t-${projectId}-c`, day: '2026-10-05', cost_usd: 4 }));
    expect(await usage.costOfDay(projectId, '2026-10-04')).toBe(1.25);
    expect(await usage.costOfDay(projectId, '2026-10-05')).toBe(4);
    expect(await usage.costOfDay(projectId, '2026-10-06')).toBe(0);
  });

  it('drops the cursor with its tab, and with its project (an account deletion purges them), keeping the day rows (TER-974)', async () => {
    expect(await usage.record(write({}))).toBe(true);
    expect(await usage.record(write({ tab_id: `t-${projectId}-a` }))).toBe(true);
    await db.tab.delete({ where: { id: 't-' + projectId } });
    expect(await usage.cursor('t-' + projectId)).toBeNull();
    expect(await db.tabUsageDay.count({ where: { projectId } })).toBe(2);
    // a pass over a tab closed meanwhile writes nothing
    expect(await usage.record(write({}))).toBe(false);
    await db.project.delete({ where: { id: projectId } });
    expect(await db.tabUsage.count({ where: { tabId: { startsWith: 't-' + projectId } } })).toBe(0);
  });
});
