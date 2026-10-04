import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';

// Needs a migrated Postgres: TERMHUB_DB_TESTS=1 DATABASE_URL=… (CI sets both).
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatRepository;
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatRepository(db);
    userId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    projectId = newId();
    await db.project.create({ data: { id: projectId, key: `K${projectId.slice(-5).toUpperCase()}`, name: 'proj', ownerId: userId } });
  });

  afterAll(async () => {
    await db.project.delete({ where: { id: projectId } }); // cascades its conversations
    await db.user.delete({ where: { id: userId } }); // cascades the conversation and its messages
    await db.$disconnect();
  });

  it('creates one conversation per user and returns the same one after that', async () => {
    const first = await repo.getOrCreateForUser(userId);
    const again = await repo.getOrCreateForUser(userId);
    expect(again.id).toBe(first.id);
    expect(first.cli_session_id).toBeNull();
    expect(first.review_mode).toBe(false);
  });

  it('stores the cli session id, appends messages in order and bumps last_message_at', async () => {
    const c = await repo.getOrCreateForUser(userId);
    await repo.setCliSession(c.id, '3f1e9b1e-0000-4000-8000-000000000001');

    const user = await repo.addMessage({ conversation_id: c.id, role: 'user', text: 'o que está rodando?' });
    const assistant = await repo.addMessage({ conversation_id: c.id, role: 'assistant', text: '' });
    await repo.updateMessage(assistant.id, { text: 'Nada rodando agora.', usage: { input_tokens: 10 } });

    const messages = await repo.listMessages(c.id);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'o que está rodando?'],
      ['assistant', 'Nada rodando agora.'],
    ]);
    expect(messages[1].usage).toEqual({ input_tokens: 10 });

    const reloaded = await repo.getOrCreateForUser(userId);
    expect(reloaded.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-000000000001');
    expect(reloaded.last_message_at).not.toBeNull();
  });

  it('stores the context fill, keeps the window a turn did not report, and drops both with the session (TER-315)', async () => {
    const c = await repo.getOrCreateForProject(userId, projectId);
    expect(c.context_tokens).toBeNull();
    await repo.setCliSession(c.id, '3f1e9b1e-0000-4000-8000-000000000002');
    expect(await repo.setContext(c.id, { tokens: 25_000, window: 1_000_000 })).toEqual({ tokens: 25_000, window: 1_000_000 });
    expect(await repo.setContext(c.id, { tokens: 1_950 })).toEqual({ tokens: 1_950, window: 1_000_000 });
    const stored = await repo.findByIdForUser(c.id, userId);
    expect([stored?.context_tokens, stored?.context_window]).toEqual([1_950, 1_000_000]);
    // Another session id keeps the fill (a turn reports it right after); no session drops it.
    await repo.setCliSession(c.id, '3f1e9b1e-0000-4000-8000-000000000003');
    expect((await repo.findByIdForUser(c.id, userId))?.context_tokens).toBe(1_950);
    await repo.setCliSession(c.id, null);
    const cleared = await repo.findByIdForUser(c.id, userId);
    expect([cleared?.cli_session_id, cleared?.context_tokens, cleared?.context_window]).toEqual([null, null, null]);
    // A host move strands the project sessions, and their fill with them.
    await repo.setCliSession(c.id, '3f1e9b1e-0000-4000-8000-000000000004');
    await repo.setContext(c.id, { tokens: 10, window: 200_000 });
    await repo.clearProjectSessions(userId);
    expect((await repo.findByIdForUser(c.id, userId))?.context_tokens).toBeNull();
  });

  it('keeps an assistant failure as an error code without losing the text so far', async () => {
    const c = await repo.getOrCreateForUser(userId);
    const m = await repo.addMessage({ conversation_id: c.id, role: 'assistant', text: 'comecei a olhar' });
    const failed = await repo.updateMessage(m.id, { error_code: 'RUNNER_FAILED' });
    expect(failed.error_code).toBe('RUNNER_FAILED');
    expect(failed.text).toBe('comecei a olhar');
  });

  it('keeps the notice of an answer (TER-588), and a message without one has none', async () => {
    const c = await repo.getOrCreateForUser(userId);
    const m = await repo.addMessage({ conversation_id: c.id, role: 'assistant', text: '' });
    expect(m).not.toHaveProperty('notice');
    const notice = { kind: 'usage_limit' as const, account: null, resets_at: '2026-09-30T06:20:00.000Z', fallback: 'none_free' as const };
    expect((await repo.updateMessage(m.id, { error_code: 'USAGE_LIMIT', notice })).notice).toEqual(notice);
    expect((await repo.listMessages(c.id)).find((x) => x.id === m.id)?.notice).toEqual(notice);
    expect(await repo.updateMessage(m.id, { notice: null })).not.toHaveProperty('notice');
  });

  it('returns the newest messages, in chronological order, when the conversation is longer than the limit', async () => {
    // Regression: `asc` + `take` pinned the window to the *oldest* messages, so past the limit the
    // user's own message and its answer were never in the payload again.
    const longUserId = newId();
    await db.user.create({ data: { id: longUserId, email: `${longUserId}@test.local`, name: 'test' } });
    try {
      const c = await repo.getOrCreateForUser(longUserId);
      const base = Date.UTC(2026, 0, 1);
      // Explicit, distinct timestamps: rows written in the same millisecond would leave the order
      // to the (random) id tiebreak and make the assertion meaningless.
      await db.chatMessage.createMany({
        data: Array.from({ length: 205 }, (_, i) => ({
          id: newId(),
          conversationId: c.id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          text: `#${i + 1}`,
          createdAt: new Date(base + i * 1000),
        })),
      });

      const page = await repo.listMessages(c.id);
      expect(page).toHaveLength(200);
      expect(page[0].text).toBe('#6'); // the 5 oldest fell off the window, not the 5 newest
      expect(page.at(-1)!.text).toBe('#205');
      expect(page.map((m) => m.text)).toEqual(Array.from({ length: 200 }, (_, i) => `#${i + 6}`));

      const three = await repo.listMessages(c.id, 3);
      expect(three.map((m) => m.text)).toEqual(['#203', '#204', '#205']);
    } finally {
      await db.user.delete({ where: { id: longUserId } }); // cascades the conversation and its messages
    }
  });

  it('stores the host pair, and only starts a fresh CLI session when the pair really moved', async () => {
    const session = '3f1e9b1e-0000-4000-8000-000000000099';
    const c = await repo.getOrCreateForUser(userId);
    await repo.setCliSession(c.id, session);
    const machine = await db.machine.create({ data: { id: newId(), name: 'jarvis', type: 'agent', ownerId: userId } });
    const second = await db.machine.create({ data: { id: newId(), name: 'macbook', type: 'agent', ownerId: userId } });
    const account = await db.aiAccount.create({ data: { id: newId(), provider: 'claude', label: 'trabalho', machineId: machine.id, configDir: '/home/u/.claude-work' } });

    // Naming the machine the conversation was already running on (nothing was stored: one machine is
    // resolved on the fly) moves no host, so the model keeps the memory of the conversation.
    const first = await repo.setHost(c.id, { machine_id: machine.id, ai_account_id: null });
    expect(first.moved).toBe(false);
    expect(first.conversation).toMatchObject({ machine_id: machine.id, ai_account_id: null, cli_session_id: session });

    // And picking the very same pair again — the same click twice, or a settings screen that saves
    // whatever is selected — is not a host change either.
    const same = await repo.setHost(c.id, { machine_id: machine.id, ai_account_id: null });
    expect(same.moved).toBe(false);
    expect(same.conversation.cli_session_id).toBe(session);

    // A second login on the same machine *is* another config directory, so the session is not there.
    const hosted = await repo.setHost(c.id, { machine_id: machine.id, ai_account_id: account.id });
    expect(hosted.moved).toBe(true);
    expect(hosted.conversation).toMatchObject({ machine_id: machine.id, ai_account_id: account.id, cli_session_id: null });

    // So is another machine: the session lives in the config dir of the machine that ran it, and
    // keeping the uuid would ask the new host to resume a session it has never seen.
    await repo.setCliSession(c.id, session);
    const movedAgain = await repo.setHost(c.id, { machine_id: second.id, ai_account_id: null });
    expect(movedAgain.moved).toBe(true);
    expect(movedAgain.conversation.cli_session_id).toBeNull();
    await repo.setHost(c.id, { machine_id: machine.id, ai_account_id: account.id });
    await db.machine.delete({ where: { id: second.id } });

    // "One conversation per user" must survive a host being chosen: the partial unique index no longer
    // keys on machine_id, so a second concurrent create still loses (this is what getOrCreateForUser's
    // create-then-re-read fallback relies on).
    await expect(db.chatConversation.create({ data: { id: newId(), userId } })).rejects.toThrow();

    await db.aiAccount.delete({ where: { id: account.id } });
    expect((await repo.getOrCreateForUser(userId)).ai_account_id).toBeNull(); // ON DELETE SET NULL
    await db.machine.delete({ where: { id: machine.id } });
    const orphaned = await repo.getOrCreateForUser(userId);
    expect(orphaned.machine_id).toBeNull();
    expect(orphaned.id).toBe(c.id); // the conversation itself, and its history, survive
  });

  it('pins a host only while the conversation names none, so a run can never move a chosen one', async () => {
    const session = '3f1e9b1e-0000-4000-8000-000000000077';
    const c = await repo.getOrCreateForUser(userId);
    const ran = await db.machine.create({ data: { id: newId(), name: 'jarvis', type: 'agent', ownerId: userId } });
    const other = await db.machine.create({ data: { id: newId(), name: 'macbook', type: 'agent', ownerId: userId } });
    try {
      // The conversation `resolveHost` auto-picks for: one machine, nothing stored.
      await db.chatConversation.update({ where: { id: c.id }, data: { machineId: null, aiAccountId: null } });
      await repo.setCliSession(c.id, session);

      await repo.pinHostMachine(c.id, ran.id);
      const pinned = await repo.getOrCreateForUser(userId);
      // Recorded, and the session left exactly where it was: this is a note of where a run happened,
      // never a host change.
      expect(pinned.machine_id).toBe(ran.id);
      expect(pinned.cli_session_id).toBe(session);

      // The guard, and the only reason it lives in the SQL rather than in a caller: this conversation
      // now names a host, and a run on any *other* machine must not rewrite it. That happens for real —
      // the named machine stops being a candidate (handed to someone else, or turned into an ssh
      // machine), `resolveHost` picks the survivor, and a pin without `where machineId: null` would
      // move a host the person chose, in silence. It would also erase the very difference the pin
      // exists to create, so the header would stop warning that the session is not on the machine that
      // is about to answer.
      await repo.pinHostMachine(c.id, other.id);
      const unmoved = await repo.getOrCreateForUser(userId);
      expect(unmoved.machine_id).toBe(ran.id);
      expect(unmoved.cli_session_id).toBe(session);

      // …and a host the *user* chose is the same row and the same guard: setHost stores it, and no run
      // can take it from there either.
      await repo.setHost(c.id, { machine_id: other.id, ai_account_id: null });
      await repo.pinHostMachine(c.id, ran.id);
      expect((await repo.getOrCreateForUser(userId)).machine_id).toBe(other.id);
    } finally {
      await repo.setCliSession(c.id, null);
      await db.machine.deleteMany({ where: { id: { in: [ran.id, other.id] } } }); // nulls machine_id again
    }
  });

  it('never creates two conversations for the same user under a concurrent first load', async () => {
    const raceUserId = newId();
    await db.user.create({ data: { id: raceUserId, email: `${raceUserId}@test.local`, name: 'test' } });
    try {
      // 2 calls alone are not enough to reliably overlap on a fresh connection pool in this suite
      // (the pool's connection warm-up serializes a first small burst); 20 concurrent calls do
      // reliably race, exercising the partial unique index and the create/re-read fallback.
      const results = await Promise.all(Array.from({ length: 20 }, () => repo.getOrCreateForUser(raceUserId)));
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      expect(await db.chatConversation.count({ where: { userId: raceUserId } })).toBe(1);
    } finally {
      await db.user.delete({ where: { id: raceUserId } }); // cascades the conversation
    }
  });

  it('keeps one active conversation per project, separate from the account-wide one', async () => {
    const wide = await repo.getOrCreateForUser(userId);
    const [a, b] = await Promise.all([repo.getOrCreateForProject(userId, projectId), repo.getOrCreateForProject(userId, projectId)]);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(wide.id);
    expect(a.project_id).toBe(projectId);
    expect(wide.project_id).toBeNull();
  });

  it('archive frees the scope: the next lookup creates a fresh row with no session', async () => {
    const before = await repo.getOrCreateForProject(userId, projectId);
    await repo.setCliSession(before.id, '3f1e9b1e-0000-4000-8000-0000000000aa');
    await repo.archive(before.id);
    const after = await repo.getOrCreateForProject(userId, projectId);
    expect(after.id).not.toBe(before.id);
    expect(after.cli_session_id).toBeNull();
    expect((await repo.findByIdForUser(before.id, userId))?.archived_at).not.toBeNull();
  });

  it('findMessagesByIds returns only messages of that conversation, ignoring ids elsewhere', async () => {
    const c = await repo.getOrCreateForUser(userId);
    // A tab-scoped conversation, isolated from the shared project/account-wide ones the other tests
    // in this file depend on staying untouched.
    const other = await db.chatConversation.create({ data: { id: newId(), userId, tabId: newId() } });
    const mine = await repo.addMessage({ conversation_id: c.id, role: 'user', text: 'aqui' });
    const elsewhere = await repo.addMessage({ conversation_id: other.id, role: 'user', text: 'lá' });

    const found = await repo.findMessagesByIds(c.id, [mine.id, elsewhere.id, 'missing']);
    expect(found.map((m) => m.id)).toEqual([mine.id]);
  });

  it('findByIdForUser never answers for another user', async () => {
    const c = await repo.getOrCreateForProject(userId, projectId);
    expect(await repo.findByIdForUser(c.id, 'someone-else')).toBeUndefined();
  });

  it('clearProjectSessions drops the session of every active project conversation and only those', async () => {
    const wide = await repo.getOrCreateForUser(userId);
    const p = await repo.getOrCreateForProject(userId, projectId);
    await repo.setCliSession(wide.id, '3f1e9b1e-0000-4000-8000-0000000000b1');
    await repo.setCliSession(p.id, '3f1e9b1e-0000-4000-8000-0000000000b2');
    await repo.clearProjectSessions(userId);
    expect((await repo.findByIdForUser(wide.id, userId))?.cli_session_id).toBe('3f1e9b1e-0000-4000-8000-0000000000b1');
    expect((await repo.findByIdForUser(p.id, userId))?.cli_session_id).toBeNull();
  });

  it('lists active project conversations only', async () => {
    const p = await repo.getOrCreateForProject(userId, projectId);
    expect(await repo.listActiveProjectConversations(userId)).toEqual([{ id: p.id, project_id: projectId, last_message_at: null }]);
  });

  it('lists each active project conversation with when it last saw a message', async () => {
    const p = await repo.getOrCreateForProject(userId, projectId);
    await repo.addMessage({ conversation_id: p.id, role: 'user', text: 'oi' });
    const [row] = await repo.listActiveProjectConversations(userId);
    expect(row.id).toBe(p.id);
    expect(row.last_message_at).toBe((await repo.findByIdForUser(p.id, userId))?.last_message_at);
    expect(row.last_message_at).not.toBeNull();
  });

  it('deleting the project deletes its conversations', async () => {
    const otherProject = newId();
    await db.project.create({ data: { id: otherProject, key: `K${otherProject.slice(-5).toUpperCase()}`, name: 'tmp', ownerId: userId } });
    const c = await repo.getOrCreateForProject(userId, otherProject);
    await db.project.delete({ where: { id: otherProject } });
    expect(await repo.findByIdForUser(c.id, userId)).toBeUndefined();
  });

  it('a reply keeps what it quoted, and survives the original being deleted (TER-447)', async () => {
    const c = await repo.getOrCreateForUser(userId);
    const original = await repo.addMessage({ conversation_id: c.id, role: 'assistant', text: 'Abri a aba build' });
    expect(original.reply_to).toBeUndefined();
    const reply = await repo.addMessage({ conversation_id: c.id, role: 'user', text: 'faz de novo', reply_to: { id: original.id, role: 'assistant', excerpt: 'Abri a aba build' } });
    expect(reply.reply_to).toEqual({ id: original.id, role: 'assistant', excerpt: 'Abri a aba build' });
    expect((await repo.listMessages(c.id)).find((m) => m.id === reply.id)?.reply_to).toEqual({ id: original.id, role: 'assistant', excerpt: 'Abri a aba build' });
    expect((await repo.findMessagesByIds(c.id, [reply.id]))[0]?.reply_to?.id).toBe(original.id);

    await repo.deleteMessage(original.id);
    expect((await repo.listMessages(c.id)).find((m) => m.id === reply.id)?.reply_to).toEqual({ id: null, role: 'assistant', excerpt: 'Abri a aba build' });
  });

  it('a reply to a card names the card and keeps its quote (TER-849)', async () => {
    const c = await repo.getOrCreateForUser(userId);
    const card = { kind: 'action' as const, id: newId() };
    const reply = await repo.addMessage({ conversation_id: c.id, role: 'user', text: 'por quê?', reply_to: { id: null, role: 'assistant', excerpt: 'Abrir aba build', card } });
    expect(reply.reply_to).toEqual({ id: null, role: 'assistant', excerpt: 'Abrir aba build', card });
    expect((await repo.listMessages(c.id)).find((m) => m.id === reply.id)?.reply_to).toEqual({ id: null, role: 'assistant', excerpt: 'Abrir aba build', card });
  });
});
