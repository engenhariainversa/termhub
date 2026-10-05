import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { newId } from '../lib/ids.js';
import { MERGE_TOOL } from './merge.js';

const keyOf = (id: string) => 'S' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=…
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('daily summary (Postgres)', () => {
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
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'u' } });
    await db.project.create({ data: { id: projectId, ownerId: userId, key: keyOf(projectId), name: 'p' } });
    return async () => {
      await db.project.deleteMany({ where: { id: projectId } });
      await db.user.delete({ where: { id: userId } });
    };
  });

  it('the claim goes to one of many concurrent callers, once per user and day; release gives it back', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => repos.automationSummaries.claim(userId, '2026-10-05')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repos.automationSummaries.claim(userId, '2026-10-06')).toBe(true);
    await repos.automationSummaries.release(userId, '2026-10-05');
    expect(await repos.automationSummaries.claim(userId, '2026-10-05')).toBe(true);
  });

  it('counts the window\'s cards, merges and deploys from the events; cost from the usage days', async () => {
    const ev = (kind: 'run_done' | 'merged' | 'deploy_ok' | 'release_ok', taskId: string | null, payload: object, at: string) =>
      db.automationEvent.create({ data: { id: newId(), projectId, taskId, kind, payload, createdAt: new Date(at) } });
    const card = (await repos.tasks.create(projectId, { title: 'Card' })).id;
    await ev('run_done', card, {}, '2026-10-05T12:00:00Z');
    await ev('merged', card, { pr: 7 }, '2026-10-05T12:10:00Z');
    await ev('merged', null, { pr: 7 }, '2026-10-05T12:11:00Z'); // the same PR, two cards
    await ev('deploy_ok', null, {}, '2026-10-05T12:20:00Z');
    await ev('release_ok', null, {}, '2026-10-05T12:30:00Z');
    await ev('deploy_ok', null, {}, '2026-10-04T12:20:00Z'); // another day
    const a = await repos.automationSummaries.activity([projectId], new Date('2026-10-05T03:00:00Z'), new Date('2026-10-06T03:00:00Z'));
    expect(a).toEqual({ cards: 1, merges: 1, deploys: 2 });
    expect(await repos.automationSummaries.costOfDay([projectId], '2026-10-05')).toBeNull();
    await db.$executeRaw`INSERT INTO "tab_usage_days" ("tab_id", "day", "project_id", "cost_usd_estimate", "updated_at") VALUES (${'t-' + projectId}, '2026-10-05'::date, ${projectId}, 2.5, now())`;
    expect(await repos.automationSummaries.costOfDay([projectId], '2026-10-05')).toBe(2.5);
    await db.tabUsageDay.deleteMany({ where: { projectId } });
  });

  it('lists the merge approvals still pending, and none that were decided', async () => {
    const conversation = await repos.chat.getOrCreateForProject(userId, projectId);
    const pending = await repos.chatActions.insertPending({ conversation_id: conversation.id, tool: MERGE_TOOL, args: { number: 12 }, class: 'irreversible', project_id: projectId, injected: true });
    const decided = await repos.chatActions.insertPending({ conversation_id: conversation.id, tool: MERGE_TOOL, args: { number: 13 }, class: 'irreversible', project_id: projectId, injected: true });
    await repos.chatActions.decide(decided.id, userId, 'denied');
    expect(await repos.automationSummaries.pendingCards(userId, MERGE_TOOL, [projectId])).toEqual([{ project_id: projectId, number: 12 }]);
    expect(pending.status).toBe('pending');
  });
});
