import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatActionsRepository } from './chat-actions.js';
import { ChatRepository } from './chat.js';

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatActionsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatActionsRepository;
  let conversationId: string;
  let userId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatActionsRepository(db);
    userId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    conversationId = (await new ChatRepository(db).getOrCreateForUser(userId)).id;
  });

  afterAll(async () => {
    await db.user.delete({ where: { id: userId } }); // cascades the conversation and its actions
    await db.$disconnect();
  });

  const pending = (key: string) => repo.insertPending({ conversation_id: conversationId, tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, idempotency_key: key, class: 'write' });

  it('surfaces only the pending rows of the conversation, and says which (TER-477)', async () => {
    const a = await pending('s1');
    const b = await pending('s2');
    await repo.decide(b.id, userId, 'approved');
    expect(a.surfaced_at).toBeNull();
    const now = new Date('2030-01-01T00:00:00.000Z');
    const surfaced = await repo.surfacePending(conversationId, undefined, now);
    expect(surfaced.map((r) => r.id)).toContain(a.id);
    expect(surfaced.map((r) => r.id)).not.toContain(b.id);
    expect(surfaced.find((r) => r.id === a.id)?.surfaced_at).toBe(now.toISOString());
    // Narrowed to some ids: the others are left alone.
    const c = await pending('s3');
    const only = await repo.surfacePending(conversationId, [c.id], new Date('2030-01-02T00:00:00.000Z'));
    expect(only.map((r) => r.id)).toEqual([c.id]);
    expect((await repo.findByIdForUser(a.id, userId))?.surfaced_at).toBe(now.toISOString());
    for (const r of [a, c]) await repo.decide(r.id, userId, 'denied');
  });

  it('a server card (automation_merge) is born injected, never re-injected, and found by its key in the project whatever its status', async () => {
    const projectId = newId();
    await db.project.create({ data: { id: projectId, ownerId: userId, key: 'M' + projectId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase(), name: 'p' } });
    const conv = await new ChatRepository(db).getOrCreateForProject(userId, projectId);
    const key = 'automation_merge:acme/app#7@h1';
    const row = await repo.insertPending({ conversation_id: conv.id, tool: 'automation_merge', args: { number: 7 }, class: 'irreversible', idempotency_key: key, project_id: projectId, injected: true });
    expect(row.injected_at).not.toBeNull();
    await repo.decide(row.id, userId, 'approved');
    expect(await repo.listToInject(conv.id)).toEqual([]);
    expect((await repo.findById(row.id))?.status).toBe('approved');
    expect(await repo.claimApproved(row.id)).toBe(true);
    expect(await repo.claimApproved(row.id)).toBe(false);
    expect((await repo.findLatestByKeyInProject(userId, projectId, key))?.id).toBe(row.id);
    expect(await repo.findLatestByKeyInProject(newId(), projectId, key)).toBeUndefined();
    expect(await repo.findLatestByKeyInProject(userId, newId(), key)).toBeUndefined();
    await db.project.delete({ where: { id: projectId } });
  });

  it('finds an open row by its key and does not see a decided one', async () => {
    const row = await pending('k1');
    expect(row.status).toBe('pending');
    expect((await repo.findOpenByKey(conversationId, 'k1'))?.id).toBe(row.id);

    await repo.decide(row.id, userId, 'denied');
    expect(await repo.findOpenByKey(conversationId, 'k1')).toBeUndefined();
  });

  it('refuses a second open row for the same key, so a retry cannot ask twice', async () => {
    await pending('k2');
    await expect(pending('k2')).rejects.toThrow(); // partial unique index on the open statuses
  });

  it('lets the same key through again once the first row is decided and executed', async () => {
    const first = await pending('k3');
    await repo.decide(first.id, userId, 'approved');
    await repo.markExecuted(first.id, true, null, 12);
    const again = await pending('k3');
    expect(again.id).not.toBe(first.id);
  });

  it('records who decided and when, and keeps the arguments as given', async () => {
    const row = await pending('k4');
    const decided = await repo.decide(row.id, userId, 'approved');
    expect(decided?.decided_by).toBe(userId);
    expect(decided?.decided_at).not.toBeNull();
    expect(decided?.args).toEqual({ tab_id: 't1', text: 'npm test' });
  });

  it('never lets another user decide', async () => {
    const row = await pending('k5');
    expect(await repo.decide(row.id, newId(), 'approved')).toBeUndefined();
    expect((await repo.findOpenByKey(conversationId, 'k5'))?.status).toBe('pending');
  });

  it('finds a row by id for its owner, and not for another user', async () => {
    const row = await pending('k14');
    expect((await repo.findByIdForUser(row.id, userId))?.id).toBe(row.id);
    expect(await repo.findByIdForUser(row.id, newId())).toBeUndefined();
    expect(await repo.findByIdForUser(newId(), userId)).toBeUndefined();
  });

  it('inserts an action already approved under a grant, and it can be claimed', async () => {
    const row = await repo.insertApproved({ conversation_id: conversationId, tool: 'send_input', args: { tab_id: 't1', text: 'sim' }, class: 'write', idempotency_key: 'kg1', tab_id: 't1', grant_id: 'g1', decided_by: userId });
    expect(row).toMatchObject({ status: 'approved', grant_id: 'g1', decided_by: userId });
    expect(row.decided_at).not.toBeNull();
    expect(await repo.claimApproved(row.id)).toBe(true);
  });

  it('countForGrantSince counts only that grant, in that conversation, after the cutoff', async () => {
    const base = { conversation_id: conversationId, tool: 'move_task', class: 'write' as const, decided_by: userId };
    await repo.insertApproved({ ...base, args: { task_id: 'x1' }, idempotency_key: 'k-g1-a', grant_id: 'pg1' });
    await repo.insertApproved({ ...base, args: { task_id: 'x2' }, idempotency_key: 'k-g1-b', grant_id: 'pg1' });
    await repo.insertApproved({ ...base, args: { task_id: 'x3' }, idempotency_key: 'k-g2', grant_id: 'pg2' });
    expect(await repo.countForGrantSince(conversationId, 'pg1', new Date(Date.now() - 60_000))).toBe(2);
    expect(await repo.countForGrantSince(conversationId, 'pg1', new Date(Date.now() + 60_000))).toBe(0);
  });

  it('countForGrantSince filters by tool when a list is given', async () => {
    // Its own conversation: the shared `conversationId` above already carries a row under grant_id
    // 'g1' from an earlier test, which `since` (a moment ago) would otherwise also match.
    const toolsUserId = newId();
    await db.user.create({ data: { id: toolsUserId, email: `${toolsUserId}@test.local`, name: 'test' } });
    const toolsConversationId = (await new ChatRepository(db).getOrCreateForUser(toolsUserId)).id;
    try {
      const since = new Date(Date.now() - 60_000);
      await repo.insertApproved({ conversation_id: toolsConversationId, tool: 'send_key', args: { tab_id: 't1', key: 'Enter' }, class: 'write', idempotency_key: 'k-g1-key', grant_id: 'g1', decided_by: toolsUserId });
      await repo.insertApproved({ conversation_id: toolsConversationId, tool: 'create_task', args: { title: 'x' }, class: 'write', idempotency_key: 'k-g1-task', grant_id: 'g1', decided_by: toolsUserId });
      expect(await repo.countForGrantSince(toolsConversationId, 'g1', since)).toBe(2);
      expect(await repo.countForGrantSince(toolsConversationId, 'g1', since, ['send_key', 'send_input'])).toBe(1);
      expect(await repo.countForGrantSince(toolsConversationId, 'g1', since, ['create_task'])).toBe(1);
    } finally {
      await db.user.delete({ where: { id: toolsUserId } });
    }
  });

  it('countByGrantSince counts rows with that grant_id created after since, across conversations', async () => {
    // Two conversations of different users, both charged against the same standing grant id
    // (TER-386): the count must not be scoped to one conversation, unlike countForGrantSince.
    const userA = newId();
    const userB = newId();
    await db.user.create({ data: { id: userA, email: `${userA}@test.local`, name: 'a' } });
    await db.user.create({ data: { id: userB, email: `${userB}@test.local`, name: 'b' } });
    const convA = (await new ChatRepository(db).getOrCreateForUser(userA)).id;
    const convB = (await new ChatRepository(db).getOrCreateForUser(userB)).id;
    try {
      const since = new Date(Date.now() - 60_000);
      await repo.insertApproved({ conversation_id: convA, tool: 'open_tab', args: { project_id: 'p1' }, class: 'write', idempotency_key: 'sg-a1', grant_id: 'sg1', decided_by: userA });
      await repo.insertApproved({ conversation_id: convB, tool: 'open_tab', args: { project_id: 'p1' }, class: 'write', idempotency_key: 'sg-b1', grant_id: 'sg1', decided_by: userB });
      await repo.insertApproved({ conversation_id: convB, tool: 'close_tab', args: { tab_id: 't1' }, class: 'write', idempotency_key: 'sg-b2', grant_id: 'sg2', decided_by: userB });

      expect(await repo.countByGrantSince('sg1', since)).toBe(2);
      expect(await repo.countByGrantSince('sg2', since)).toBe(1);
      expect(await repo.countByGrantSince('sg1', new Date(Date.now() + 60_000))).toBe(0);
    } finally {
      await db.user.delete({ where: { id: userA } });
      await db.user.delete({ where: { id: userB } });
    }
  });

  it('finds a denial by its key, with when it was decided, and ignores an executed row', async () => {
    const refused = await pending('k8');
    await repo.decide(refused.id, userId, 'denied');
    const found = await repo.findDeniedByKey(conversationId, 'k8');
    expect(found?.id).toBe(refused.id);
    expect(found?.decided_at).not.toBeNull(); // the gate dates its refusal window from this

    const done = await pending('k9');
    await repo.decide(done.id, userId, 'approved');
    await repo.markExecuted(done.id, true, null, 5);
    expect(await repo.findDeniedByKey(conversationId, 'k9')).toBeUndefined();
  });

  it('does not treat a question left to expire as a denial: nobody answered it', async () => {
    const forgotten = await pending('k10');
    await db.$executeRawUnsafe(`update chat_actions set created_at = now() - interval '2 days' where id = $1`, forgotten.id);
    await repo.expireOlderThan(new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(await repo.findDeniedByKey(conversationId, 'k10')).toBeUndefined();
  });

  it('lets exactly one caller claim an approved action', async () => {
    const row = await pending('k12');
    await repo.decide(row.id, userId, 'approved');
    const claims = await Promise.all([repo.claimApproved(row.id), repo.claimApproved(row.id), repo.claimApproved(row.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1); // one approval must not be executed twice
    expect(await repo.findOpenByKey(conversationId, 'k12')).toBeUndefined(); // and is not claimable again
  });

  it('refuses to claim an action the user never approved', async () => {
    const row = await pending('k13');
    expect(await repo.claimApproved(row.id)).toBe(false);
    expect((await repo.findOpenByKey(conversationId, 'k13'))?.status).toBe('pending');
  });

  it('returns the newest denial when the same proposal was refused twice', async () => {
    const first = await pending('k11');
    await repo.decide(first.id, userId, 'denied');
    const second = await pending('k11'); // allowed again: the index only covers the open statuses
    await repo.decide(second.id, userId, 'denied');
    expect((await repo.findDeniedByKey(conversationId, 'k11'))?.id).toBe(second.id);
  });

  it('finds the oldest decided action not yet injected, ignores injected and pending rows, and drains in order', async () => {
    // Isolated in its own conversation: the shared one above already carries decided rows from
    // earlier tests that were never marked injected, which would otherwise leak into this read.
    const otherUserId = newId();
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'test' } });
    const otherConversationId = (await new ChatRepository(db).getOrCreateForUser(otherUserId)).id;
    try {
      const mk = (key: string) =>
        repo.insertPending({ conversation_id: otherConversationId, tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, idempotency_key: key, class: 'write' });

      const a = await mk('inj-a');
      await repo.decide(a.id, otherUserId, 'approved');
      const b = await mk('inj-b');
      await repo.decide(b.id, otherUserId, 'denied');
      await mk('inj-c'); // left pending: must never surface here

      expect((await repo.findNextToInject(otherConversationId))?.id).toBe(a.id);

      // A row the caller could not mark injected is excluded in SQL, so the drain neither spins on it
      // nor blocks the decision behind it (the marking is what makes an injection at-most-once, so a
      // row it failed on stays uninjected and would otherwise be handed back for ever).
      expect((await repo.findNextToInject(otherConversationId, [a.id]))?.id).toBe(b.id);
      expect(await repo.findNextToInject(otherConversationId, [a.id, b.id])).toBeUndefined();

      await repo.markInjected(a.id);
      expect((await repo.findNextToInject(otherConversationId))?.id).toBe(b.id);

      await repo.markInjected(b.id);
      expect(await repo.findNextToInject(otherConversationId)).toBeUndefined();
    } finally {
      await db.user.delete({ where: { id: otherUserId } }); // cascades the conversation and its actions
    }
  });

  it('never hands a grant-run row to the injection, since no card was ever decided for it', async () => {
    // Own conversation, for the same reason as the test above.
    const otherUserId = newId();
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'test' } });
    const otherConversationId = (await new ChatRepository(db).getOrCreateForUser(otherUserId)).id;
    try {
      const granted = await repo.insertApproved({ conversation_id: otherConversationId, tool: 'send_input', args: { tab_id: 't1', text: 'sim' }, class: 'write', idempotency_key: 'inj-g', tab_id: 't1', grant_id: 'g1', decided_by: otherUserId });
      expect(granted.status).toBe('approved');
      expect(await repo.findNextToInject(otherConversationId)).toBeUndefined();
    } finally {
      await db.user.delete({ where: { id: otherUserId } });
    }
  });

  it('lists every decided action not yet injected, oldest decision first, for one run to carry them all', async () => {
    // Own conversation, for the same reason as the tests above.
    const otherUserId = newId();
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'test' } });
    const otherConversationId = (await new ChatRepository(db).getOrCreateForUser(otherUserId)).id;
    try {
      const mk = (key: string) =>
        repo.insertPending({ conversation_id: otherConversationId, tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, idempotency_key: key, class: 'write' });

      const a = await mk('list-a');
      await repo.decide(a.id, otherUserId, 'approved');
      const b = await mk('list-b');
      await repo.decide(b.id, otherUserId, 'denied');
      const c = await mk('list-c');
      await repo.decide(c.id, otherUserId, 'approved');
      await repo.markInjected(b.id); // already carried by an earlier run
      await mk('list-d'); // left pending
      await repo.insertApproved({ conversation_id: otherConversationId, tool: 'send_input', args: { tab_id: 't1', text: 'sim' }, class: 'write', idempotency_key: 'list-g', tab_id: 't1', grant_id: 'g1', decided_by: otherUserId });

      expect((await repo.listToInject(otherConversationId)).map((r) => r.id)).toEqual([a.id, c.id]);
      expect((await repo.listToInject(otherConversationId, [a.id])).map((r) => r.id)).toEqual([c.id]);
      expect((await repo.listToInject(otherConversationId, [], 1)).map((r) => r.id)).toEqual([a.id]);

      expect(await repo.markInjectedMany([a.id, c.id])).toBe(2);
      expect(await repo.listToInject(otherConversationId)).toEqual([]);
    } finally {
      await db.user.delete({ where: { id: otherUserId } });
    }
  });

  it('markInjectedMany never marks a row twice: a batch holding an already-injected row marks nothing and says so', async () => {
    const otherUserId = newId();
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'test' } });
    const otherConversationId = (await new ChatRepository(db).getOrCreateForUser(otherUserId)).id;
    try {
      const mk = async (key: string) => {
        const row = await repo.insertPending({ conversation_id: otherConversationId, tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, idempotency_key: key, class: 'write' });
        await repo.decide(row.id, otherUserId, 'approved');
        return row;
      };
      const a = await mk('once-a');
      const b = await mk('once-b');
      expect(await repo.markInjectedMany([b.id])).toBe(1);
      const bAt = (await repo.findByIdForUser(b.id, otherUserId))!.injected_at;

      // One of the two was already carried: the count is short, and the other one stays uninjected so
      // the next run still carries it — all or none.
      expect(await repo.markInjectedMany([a.id, b.id])).toBe(1);
      expect((await repo.findByIdForUser(a.id, otherUserId))!.injected_at).toBeNull();
      expect((await repo.findByIdForUser(b.id, otherUserId))!.injected_at).toBe(bAt);
      expect((await repo.listToInject(otherConversationId)).map((r) => r.id)).toEqual([a.id]);
    } finally {
      await db.user.delete({ where: { id: otherUserId } });
    }
  });

  it('expires rows older than the cutoff and leaves fresh ones alone', async () => {
    const old = await pending('k6');
    await db.$executeRawUnsafe(`update chat_actions set created_at = now() - interval '2 days' where id = $1`, old.id);
    const fresh = await pending('k7');
    expect(await repo.expireOlderThan(new Date(Date.now() - 24 * 60 * 60 * 1000))).toBe(1);
    expect((await repo.findOpenByKey(conversationId, 'k7'))?.id).toBe(fresh.id);
  });

  it('expires an approval no run ever came back for, and leaves a fresh approval alone', async () => {
    // The asymmetry this closes: a question nobody answered expired, while a "yes" nobody consumed sat
    // approved for ever — and a byte-identical proposal weeks later would have claimed it and executed.
    const stale = await pending('k15');
    await repo.decide(stale.id, userId, 'approved');
    await db.$executeRawUnsafe(`update chat_actions set decided_at = now() - interval '2 days' where id = $1`, stale.id);
    const fresh = await pending('k16');
    await repo.decide(fresh.id, userId, 'approved');

    expect(await repo.expireOlderThan(new Date(Date.now() - 24 * 60 * 60 * 1000))).toBe(1);
    expect(await repo.findOpenByKey(conversationId, 'k15')).toBeUndefined(); // no longer authorising anything
    expect(await repo.claimApproved(stale.id)).toBe(false);
    expect(await repo.findDeniedByKey(conversationId, 'k15')).toBeUndefined(); // and it is still not a "no"
    // An approval that is merely slow to be re-injected is well inside the window: untouched.
    expect((await repo.findOpenByKey(conversationId, 'k16'))?.status).toBe('approved');
  });

  it('ages an approval out exactly once, and never one already claimed for execution', async () => {
    const row = await pending('k17');
    await repo.decide(row.id, userId, 'approved');
    const aged = await Promise.all([repo.expireApproved(row.id), repo.expireApproved(row.id)]);
    expect(aged.filter(Boolean)).toHaveLength(1);
    expect((await repo.findByIdForUser(row.id, userId))?.status).toBe('expired');
    expect(await repo.claimApproved(row.id)).toBe(false); // an aged-out approval can never be executed

    // The other side of the same race: the claim won, so the action is executing and is not the gate's
    // to retire — `false` is what tells the gate to answer "already claimed" instead of "expired".
    const claimed = await pending('k18');
    await repo.decide(claimed.id, userId, 'approved');
    expect(await repo.claimApproved(claimed.id)).toBe(true);
    expect(await repo.expireApproved(claimed.id)).toBe(false);
  });

  describe('setSubagentByToolUse', () => {
    it('sets subagent_id only on rows still unset for that tool_use_id, scoped to the conversation', async () => {
      const otherUserId = newId();
      await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'test' } });
      const otherConversationId = (await new ChatRepository(db).getOrCreateForUser(otherUserId)).id;
      try {
        await repo.insertPending({ conversation_id: conversationId, tool: 'run_command', args: { tab_id: 't1', text: 'x' }, class: 'write', idempotency_key: 'sub-a', tool_use_id: 'toolu_X' });
        await repo.insertPending({ conversation_id: otherConversationId, tool: 'run_command', args: { tab_id: 't1', text: 'x' }, class: 'write', idempotency_key: 'sub-b', tool_use_id: 'toolu_X' });

        const updated = await repo.setSubagentByToolUse(conversationId, 'toolu_X', 'sa1');
        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({ conversation_id: conversationId, tool_use_id: 'toolu_X', subagent_id: 'sa1' });

        // Already set: a second call touches nothing more in this conversation.
        expect(await repo.setSubagentByToolUse(conversationId, 'toolu_X', 'sa2')).toEqual([]);

        // The same tool_use_id in another conversation is untouched by either call.
        const other = await repo.findOpenByKey(otherConversationId, 'sub-b');
        expect(other?.subagent_id).toBeNull();
      } finally {
        await db.user.delete({ where: { id: otherUserId } });
      }
    });
  });

  describe('expireOpenForConversation / countPendingByConversation', () => {
    // A fresh user and its own pair of conversations, isolated from `conversationId` above (which by
    // this point in the file carries a pile of pending/approved rows left open by earlier tests) —
    // otherwise the counts this group asserts would depend on execution order elsewhere in the file.
    let scopedUserId: string;
    let conversationId: string;
    let otherConversationId: string;

    beforeAll(async () => {
      scopedUserId = newId();
      await db.user.create({ data: { id: scopedUserId, email: `${scopedUserId}@test.local`, name: 'test' } });
      conversationId = (await new ChatRepository(db).getOrCreateForUser(scopedUserId)).id;
      // tabId set: bypasses the "one active conversation per scope" index, so it coexists with the
      // account-wide one above for the same user — another conversation of the same user.
      otherConversationId = (await db.chatConversation.create({ data: { id: newId(), userId: scopedUserId, tabId: newId() } })).id;

      const mk = (convId: string, key: string) =>
        repo.insertPending({ conversation_id: convId, tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, idempotency_key: key, class: 'write' });

      await mk(conversationId, 'eo-pending');
      const approved = await mk(conversationId, 'eo-approved');
      await repo.decide(approved.id, scopedUserId, 'approved');
      const denied = await mk(conversationId, 'eo-denied');
      await repo.decide(denied.id, scopedUserId, 'denied');
      await mk(otherConversationId, 'eo-other-pending');
    });

    afterAll(async () => {
      await db.user.delete({ where: { id: scopedUserId } }); // cascades both conversations and their actions
    });

    it('expireOpenForConversation expires pending and approved rows of that conversation only', async () => {
      // pending + approved in `conversationId`, a pending row in another conversation of the same user
      const n = await repo.expireOpenForConversation(conversationId);
      expect(n).toBe(2);
      const rows = await repo.listByConversation(conversationId);
      expect(rows.filter((r) => r.status === 'pending' || r.status === 'approved')).toEqual([]);
      expect((await repo.listByConversation(otherConversationId)).some((r) => r.status === 'pending')).toBe(true);
    });

    it('countPendingByConversation counts only pending rows, per conversation', async () => {
      const counts = await repo.countPendingByConversation([conversationId, otherConversationId]);
      expect(counts.get(otherConversationId)).toBe(1);
      expect(counts.get(conversationId) ?? 0).toBe(0);
    });
  });

  // TER-986. Last on purpose: the orphan sweep is global, and the rows this file left pending point at
  // tabs that never existed — they are swept too, which nothing above relies on any more.
  it('a closed tab retires its pending cards as TAB_GONE, and only those; the orphan sweep catches the rest', async () => {
    const gone = `t-gone-${newId()}`;
    const mk = (key: string, tabId: string) => repo.insertPending({ conversation_id: conversationId, tool: 'send_input', args: { tab_id: tabId, text: 'oi' }, idempotency_key: key, class: 'write', tab_id: tabId });
    const a = await mk(`tg-a-${gone}`, gone);
    const decided = await mk(`tg-b-${gone}`, gone);
    await repo.decide(decided.id, userId, 'approved');
    const other = await mk(`tg-c-${gone}`, `${gone}-other`);

    const moved = await repo.failPendingForTab(gone);
    expect(moved).toEqual([{ action: expect.objectContaining({ id: a.id, status: 'failed', error_code: 'TAB_GONE' }), user_id: userId }]);
    expect((await repo.findById(decided.id))?.status).toBe('approved');
    expect((await repo.findById(other.id))?.status).toBe('pending');
    expect(await repo.failPendingForTab(gone)).toEqual([]);

    expect(await repo.failPendingTabGone(a.id)).toBeUndefined(); // no longer pending
    const swept = await repo.failOrphanPending();
    expect(swept.map((r) => r.action.id)).toContain(other.id);
    expect(swept.find((r) => r.action.id === other.id)).toMatchObject({ user_id: userId, action: { status: 'failed', error_code: 'TAB_GONE' } });
    expect(swept.map((r) => r.action.id)).not.toContain(decided.id);
  });
});
