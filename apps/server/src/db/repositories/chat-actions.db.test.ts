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

      await repo.markInjectedMany([a.id, c.id]);
      expect(await repo.listToInject(otherConversationId)).toEqual([]);
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
});
