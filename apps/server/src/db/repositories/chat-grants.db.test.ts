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
