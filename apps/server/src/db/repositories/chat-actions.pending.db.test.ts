import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatActionsRepository } from './chat-actions.js';
import { ChatRepository } from './chat.js';
import { ChatSubagentsRepository } from './chat-subagents.js';

/** TER-1192: the reads and sweeps behind list/deny_pending_action, the duplicate check and the expiries. */
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatActionsRepository: pending cards across chats (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatActionsRepository;
  let subagents: ChatSubagentsRepository;
  let userId: string;
  let otherId: string;
  let projectId: string;
  let projectConv: string;
  let accountConv: string;
  let otherConv: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatActionsRepository(db);
    subagents = new ChatSubagentsRepository(db);
    userId = newId();
    otherId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherId, email: `${otherId}@test.local`, name: 'other' } });
    projectId = newId();
    await db.project.create({ data: { id: projectId, ownerId: userId, key: 'P' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase(), name: 'auvp' } });
    const chats = new ChatRepository(db);
    projectConv = (await chats.getOrCreateForProject(userId, projectId)).id;
    accountConv = (await chats.getOrCreateForUser(userId)).id;
    otherConv = (await chats.getOrCreateForUser(otherId)).id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await db.$disconnect();
  });

  const card = (conversation_id: string, title: string, subagent_id: string | null = null) =>
    repo.insertPending({ conversation_id, tool: 'create_task', args: { project_id: projectId, title }, class: 'write', idempotency_key: newId(), subagent_id });

  it('lists the person\'s pending cards of every live chat, oldest first, with the chat\'s project, and never another person\'s', async () => {
    const a = await card(projectConv, 'Um');
    const b = await card(accountConv, 'Dois');
    const decided = await card(projectConv, 'Três');
    await repo.decide(decided.id, userId, 'denied');
    const foreign = await card(otherConv, 'Alheio');
    const { rows, total } = await repo.listPendingForUser(userId, { limit: 100 });
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).not.toContain(decided.id);
    expect(ids).not.toContain(foreign.id);
    expect(total).toBe(rows.length);
    expect(rows.find((r) => r.id === a.id)).toMatchObject({ conversation_project_id: projectId, conversation_project_name: 'auvp' });
    expect(rows.find((r) => r.id === b.id)).toMatchObject({ conversation_project_id: null });
    expect((await repo.listPendingForUser(userId, { projectId, limit: 100 })).rows.map((r) => r.id)).not.toContain(b.id);
    expect((await repo.listPendingForUser(userId, { conversationId: accountConv, limit: 1 })).rows).toHaveLength(1);
    for (const r of [a, b]) await repo.decide(r.id, userId, 'denied');
    await repo.decide(foreign.id, otherId, 'denied');
  });

  it('finds pending create_task cards by project and expires them with a reason, only while pending', async () => {
    const a = await card(projectConv, 'Revisar o login');
    const b = await card(accountConv, 'Revisar o login');
    const found = (await repo.listPendingCreateTasks(userId, projectId)).map((r) => r.id);
    expect(found).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await repo.listPendingCreateTasks(otherId, projectId)).toEqual([]);
    await repo.decide(b.id, userId, 'approved');
    const moved = await repo.expirePending([a.id, b.id], 'REDONE');
    expect(moved.map((m) => m.action.id)).toEqual([a.id]);
    expect(moved[0]).toMatchObject({ user_id: userId, action: { status: 'expired', error_code: 'REDONE' } });
    expect((await repo.findByIdForUser(b.id, userId))?.status).toBe('approved');
  });

  it('expires a card unanswered past the cutoff only when its subagent ended', async () => {
    const ended = await subagents.start({ conversation_id: projectConv, task_id: newId(), tool_use_id: newId(), description: 'Criar cards', subagent_type: null });
    await subagents.setStatus(ended.id, 'completed');
    const running = await subagents.start({ conversation_id: projectConv, task_id: newId(), tool_use_id: newId(), description: 'Ainda rodando', subagent_type: null });
    const old = await card(projectConv, 'Velho', ended.id);
    const young = await card(projectConv, 'Novo', ended.id);
    const live = await card(projectConv, 'Vivo', running.id);
    const own = await card(projectConv, 'Do concierge');
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.chatAction.updateMany({ where: { id: { in: [old.id, live.id, own.id] } }, data: { createdAt: threeHoursAgo } });
    const moved = await repo.expireAbandonedSubagentPending(new Date(Date.now() - 2 * 60 * 60 * 1000));
    const movedIds = moved.map((m) => m.action.id);
    expect(movedIds).toContain(old.id);
    for (const r of [young, live, own]) expect(movedIds).not.toContain(r.id);
    expect((await repo.findByIdForUser(old.id, userId))).toMatchObject({ status: 'expired', error_code: 'SUBAGENT_ENDED' });
  });
});
