import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';
import { ChatGrantsRepository, GRANT_TTL_MS } from './chat-grants.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatGrantsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatGrantsRepository;
  let userId: string;
  let otherUserId: string;
  let conversationId: string;
  let otherConversationId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatGrantsRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    const chat = new ChatRepository(db);
    conversationId = (await chat.getOrCreateForUser(userId)).id;
    otherConversationId = (await chat.getOrCreateForUser(otherUserId)).id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades conversations and grants
    await db.$disconnect();
  });

  const grant = (tabId: string, now?: Date) => repo.grant({ conversation_id: conversationId, tab_id: tabId, tool: 'send_input', source_action_id: 'act1', granted_by: userId }, now);

  it('grants for 24 h and finds it active for that conversation, tab and tool only', async () => {
    const g = await grant('t1');
    expect(Date.parse(g.expires_at) - Date.parse(g.created_at)).toBe(GRANT_TTL_MS);
    expect((await repo.findActive(conversationId, 't1', 'send_input'))?.id).toBe(g.id);
    expect(await repo.findActive(conversationId, 't2', 'send_input')).toBeUndefined();
    expect(await repo.findActive(conversationId, 't1', 'run_command')).toBeUndefined();
    expect(await repo.findActive(otherConversationId, 't1', 'send_input')).toBeUndefined();
    expect((await repo.findActiveBySourceAction(conversationId, 'act1'))?.id).toBe(g.id);
    expect(await repo.findActiveBySourceAction(otherConversationId, 'act1')).toBeUndefined();
  });

  it('does not see a grant past its expiry', async () => {
    const g = await grant('t3', new Date(Date.now() - GRANT_TTL_MS - 1000));
    expect(await repo.findActive(conversationId, 't3', 'send_input')).toBeUndefined();
    expect((await repo.listActive(conversationId)).some((x) => x.id === g.id)).toBe(false);
  });

  it('granting again replaces the old grant and restarts the clock, even an expired one', async () => {
    const old = await grant('t4', new Date(Date.now() - GRANT_TTL_MS - 1000));
    const fresh = await grant('t4');
    expect(fresh.id).not.toBe(old.id);
    expect((await repo.findActive(conversationId, 't4', 'send_input'))?.id).toBe(fresh.id);
    expect((await repo.findByIdForUser(old.id, userId))?.revoked_at).not.toBeNull();
  });

  it('revokes only for the owner, once', async () => {
    const g = await grant('t5');
    expect(await repo.revoke(g.id, otherUserId)).toBeUndefined();
    expect(await repo.findByIdForUser(g.id, otherUserId)).toBeUndefined();
    const revoked = await repo.revoke(g.id, userId);
    expect(revoked?.revoked_by).toBe(userId);
    expect(await repo.revoke(g.id, userId)).toBeUndefined(); // already revoked
    expect(await repo.findActive(conversationId, 't5', 'send_input')).toBeUndefined();
  });

  it('revokeForConversation ends every active grant of that conversation, by nobody', async () => {
    await grant('t6');
    await grant('t7');
    expect(await repo.revokeForConversation(conversationId)).toBeGreaterThanOrEqual(2);
    expect(await repo.listActive(conversationId)).toEqual([]);
  });
});

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatGrantsRepository.listForUser (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatGrantsRepository;
  let userId: string;
  let otherUserId: string;
  let generalId: string;
  let archivedId: string;
  let otherConversationId: string;
  const DAY = GRANT_TTL_MS;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatGrantsRepository(db);
    userId = newId();
    otherUserId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'list' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    const chat = new ChatRepository(db);
    generalId = (await chat.getOrCreateForUser(userId)).id;
    otherConversationId = (await chat.getOrCreateForUser(otherUserId)).id;
    archivedId = newId();
    await db.chatConversation.create({ data: { id: archivedId, userId, archivedAt: new Date() } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.$disconnect();
  });

  const grantIn = (conversationId: string, tabId: string, at: Date, by = userId) =>
    repo.grant({ conversation_id: conversationId, tab_id: tabId, tool: 'send_input', source_action_id: null, granted_by: by }, at);

  it('splits active from ended, only for this user, with the conversation it came from', async () => {
    const now = new Date();
    const active = await grantIn(generalId, 'la1', new Date(now.getTime() - 60_000));
    const expired = await grantIn(generalId, 'la2', new Date(now.getTime() - DAY - 60_000));
    const revoked = await grantIn(archivedId, 'la3', new Date(now.getTime() - 120_000));
    await repo.revoke(revoked.id, userId);
    await grantIn(otherConversationId, 'la4', new Date(now.getTime() - 60_000), otherUserId);

    const a = await repo.listForUser(userId, { state: 'active', limit: 50 }, now);
    expect(a.grants.map((g) => g.id)).toEqual([active.id]);
    expect(a.next).toBeNull();
    expect(a.grants[0]).toMatchObject({ conversation_id: generalId, conversation_project_id: null, conversation_archived: false });

    const e = await repo.listForUser(userId, { state: 'ended', limit: 50 }, now);
    expect(e.grants.map((g) => g.id).sort()).toEqual([expired.id, revoked.id].sort());
    expect(e.grants.find((g) => g.id === revoked.id)).toMatchObject({ conversation_archived: true, revoked_by: userId });
  });

  it('pages the history newest first without skipping or repeating rows that share created_at', async () => {
    const same = new Date(Date.now() - 3 * DAY);
    const ids = [(await grantIn(generalId, 'lp1', same)).id, (await grantIn(generalId, 'lp2', same)).id, (await grantIn(generalId, 'lp3', same)).id];
    const seen: string[] = [];
    let cursor: { created_at: string; id: string } | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await repo.listForUser(userId, { state: 'ended', cursor, limit: 2 });
      seen.push(...page.grants.map((g) => g.id));
      if (!page.next) break;
      cursor = page.next;
    }
    const mine = seen.filter((id) => ids.includes(id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine).toEqual([...ids].sort().reverse());
  });
});
