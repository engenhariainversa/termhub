import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';
import { TabQuestionsRepository } from './tab-questions.js';

const payload = { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] };

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('TabQuestionsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: TabQuestionsRepository;
  let chat: ChatRepository;
  let userId: string;
  let otherUserId: string;
  let projectId: string;
  let conversationId: string;
  const machineId = newId();
  /** Real tab rows (the suggestion rule reads the tab), keyed by the short names the tests use. */
  const tabIds: Record<string, string> = Object.fromEntries(['ts1', 'ts2', 'ts4', 'ts5', 'ts7', 'ts8', 'ts9', 'tq1'].map((k) => [k, newId()]));
  const tid = (k: string) => tabIds[k] ?? k;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new TabQuestionsRepository(db);
    chat = new ChatRepository(db);
    userId = newId();
    otherUserId = newId();
    projectId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    await db.project.create({ data: { id: projectId, key: `Q${projectId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'proj', ownerId: userId } });
    conversationId = (await chat.getOrCreateForProject(userId, projectId)).id;
    // A suggestion opens only on a real tab that waits for input: these are the tabs the suggestion tests use.
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent', ownerId: userId } });
    await db.tab.createMany({ data: ['ts1', 'ts2', 'ts4', 'ts5', 'ts7', 'ts8', 'tq1'].map((id) => ({ id: tabIds[id]!, projectId, machineId, name: id, state: 'waiting_input' as const })) });
    await db.tab.create({ data: { id: tabIds.ts9!, projectId, machineId, name: 'ts9', state: 'working' } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: projectId } }); // cascades its conversations and questions
    await db.machine.deleteMany({ where: { id: machineId } });
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.$disconnect();
  });

  const open = async (tabId: string, now?: Date) => {
    const r = await repo.open({ tab_id: tid(tabId), project_id: projectId, conversation_id: conversationId, kind: 'choice', payload, tool_use_id: 'toolu_1' }, now);
    return { question: r.question!, closed: r.closed };
  };
  const openPermission = (tabId: string, tool: string) => repo.open({ tab_id: tid(tabId), project_id: projectId, conversation_id: conversationId, kind: 'permission', payload: { tool_name: tool }, tool_use_id: null });

  it('opens a question owned through its conversation, the tab\'s only open one', async () => {
    const { question, closed } = await open('t1');
    expect(closed).toEqual([]);
    expect(question).toMatchObject({ tab_id: 't1', project_id: projectId, conversation_id: conversationId, user_id: userId, kind: 'choice', payload, tool_use_id: 'toolu_1', status: 'open', answer: null, closed_at: null });
    expect((await repo.findOpenForTab('t1'))?.id).toBe(question.id);
    expect((await repo.findByIdForUser(question.id, userId))?.id).toBe(question.id);
    expect(await repo.findByIdForUser(question.id, otherUserId)).toBeUndefined();
  });

  it('a new question on the same tab closes the previous one as answered_in_tab', async () => {
    const first = (await open('t2')).question;
    const { question: second, closed } = await open('t2');
    expect(closed).toEqual([expect.objectContaining({ id: first.id, status: 'answered_in_tab', user_id: userId })]);
    expect(closed[0]!.closed_at).not.toBeNull();
    expect((await repo.findOpenForTab('t2'))?.id).toBe(second.id);
  });

  it('claims once, only for the owner, and keeps the answer', async () => {
    const { question } = await open('t3');
    expect(await repo.claim(question.id, otherUserId, { answers: [{ selected: [0] }] })).toBeUndefined();
    const claimed = await repo.claim(question.id, userId, { answers: [{ selected: [1] }] });
    expect(claimed).toMatchObject({ status: 'answered', answer: { answers: [{ selected: [1] }] }, answered_by: userId });
    expect(claimed?.answered_at).not.toBeNull();
    expect(await repo.claim(question.id, userId, { answers: [{ selected: [0] }] })).toBeUndefined(); // the double click
  });

  it('marks a claimed question failed, and only a claimed one', async () => {
    const { question } = await open('t4');
    expect(await repo.markFailed(question.id, 'MACHINE_OFFLINE')).toBeUndefined();
    await repo.claim(question.id, userId, { answers: [{ selected: [0] }] });
    expect(await repo.markFailed(question.id, 'MACHINE_OFFLINE')).toMatchObject({ status: 'failed', error_code: 'MACHINE_OFFLINE' });
  });

  it('closing a tab: an open question expires, an answered one keeps its status and gets closed_at', async () => {
    const { question: a } = await open('t5');
    await repo.claim(a.id, userId, { answers: [{ selected: [0] }] });
    const closedAnswered = await repo.closeForTab('t5', 'answered_in_tab');
    expect(closedAnswered).toEqual([expect.objectContaining({ id: a.id, status: 'answered' })]);
    expect(closedAnswered[0]!.closed_at).not.toBeNull();
    expect(await repo.closeForTab('t5', 'answered_in_tab')).toEqual([]); // nothing left to close

    const { question: b } = await open('t6');
    expect(await repo.closeForTab('t6', 'expired')).toEqual([expect.objectContaining({ id: b.id, status: 'expired' })]);
    expect(await repo.findOpenForTab('t6')).toBeUndefined();
  });

  it('a permission while another permission is open: both fall back to the tab (queued prompts)', async () => {
    const first = (await openPermission('t8', 'Bash')).question!;
    const { question, closed } = await openPermission('t8', 'Edit');
    expect(question).toBeNull();
    expect(closed).toEqual([expect.objectContaining({ id: first.id, status: 'answered_in_tab' })]);
    expect(await repo.findOpenForTab('t8')).toBeUndefined();
    // A choice still replaces an open permission, and a permission an open choice.
    const perm = (await openPermission('t9', 'Bash')).question!;
    const choice = await open('t9');
    expect(choice.closed.map((q) => q.id)).toEqual([perm.id]);
    const again = await openPermission('t9', 'Bash');
    expect(again.question).toMatchObject({ kind: 'permission', status: 'open' });
    expect(again.closed.map((q) => q.id)).toEqual([choice.question.id]);
  });

  it('a permission queue lasts until a closing event: no card for the 2nd, 3rd… prompt, the next one after it opens', async () => {
    const p1 = (await openPermission('t12', 'Bash')).question!;
    const p2 = await openPermission('t12', 'Edit');
    expect(p2).toEqual({ question: null, closed: [expect.objectContaining({ id: p1.id, status: 'answered_in_tab' })] });
    // The tab still shows P1's dialog: a third prompt must not open a card either.
    expect(await openPermission('t12', 'Write')).toEqual({ question: null, closed: [] });
    expect(await repo.findOpenForTab('t12')).toBeUndefined();
    // A closing event (PreToolUse, Stop…) ends the queue even with nothing on screen.
    expect(await repo.closeForTab('t12', 'answered_in_tab')).toEqual([]);
    const p4 = await openPermission('t12', 'Bash');
    expect(p4.question).toMatchObject({ kind: 'permission', status: 'open' });
    // A question event with no chat (`open` with no conversation) keeps the queue.
    await openPermission('t12', 'Edit'); // queues again
    expect(await repo.open({ tab_id: 't12', project_id: projectId, conversation_id: null, kind: 'permission', payload: { tool_name: 'Write' }, tool_use_id: null })).toEqual({ question: null, closed: [] });
    expect((await openPermission('t12', 'Bash')).question).toBeNull();
  });

  it('a choice is never held by a permission queue, and ends it', async () => {
    await openPermission('t13', 'Bash');
    await openPermission('t13', 'Edit'); // queued
    const choice = await open('t13');
    expect(choice.question).toMatchObject({ kind: 'choice', status: 'open' });
    // The newest row is now the choice: a permission after it opens normally.
    expect((await openPermission('t13', 'Bash')).question).toMatchObject({ kind: 'permission', status: 'open' });
  });

  const openNoChat = (tabId: string, kind: 'choice' | 'permission') =>
    repo.open(
      kind === 'choice'
        ? { tab_id: tid(tabId), project_id: projectId, conversation_id: null, kind, payload, tool_use_id: 'toolu_1' }
        : { tab_id: tid(tabId), project_id: projectId, conversation_id: null, kind, payload: { tool_name: 'Edit' }, tool_use_id: null },
    );

  it('no conversation: a permission behind an open one marks it QUEUED and inserts nothing — a conversation created mid-queue opens no card for the third prompt', async () => {
    const p1 = (await openPermission('tn1', 'Bash')).question!;
    expect(await openNoChat('tn1', 'permission')).toEqual({ question: null, closed: [expect.objectContaining({ id: p1.id, status: 'answered_in_tab' })] });
    const rows = await db.tabQuestion.findMany({ where: { tabId: 'tn1' } });
    expect(rows.map((r) => [r.id, r.errorCode])).toEqual([[p1.id, 'QUEUED']]);
    // The conversation is back: the tab still shows P1's dialog, so the third prompt opens nothing.
    expect((await openPermission('tn1', 'Write')).question).toBeNull();
  });

  it('no conversation: a choice closes what is open and ends a permission queue, inserting nothing', async () => {
    await openPermission('tn2', 'Bash');
    await openPermission('tn2', 'Edit'); // queued
    expect(await openNoChat('tn2', 'choice')).toEqual({ question: null, closed: [] });
    expect(await db.tabQuestion.count({ where: { tabId: 'tn2', errorCode: 'QUEUED' } })).toBe(0);
    expect(await db.tabQuestion.count({ where: { tabId: 'tn2' } })).toBe(1);
    expect((await openPermission('tn2', 'Bash')).question).toMatchObject({ kind: 'permission', status: 'open' });
  });

  it('closeForTab takes the tab lock: it waits for another event of the tab holding it, then closes', async () => {
    const tabId = tid('tq1');
    const { question } = await open('tq1');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const order: string[] = [];
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "tabs" WHERE id = ${tabId} FOR UPDATE`;
        locked();
        await held;
        order.push('holder');
      },
      { timeout: 10_000 },
    );
    await isLocked;
    const closing = repo.closeForTab(tabId, 'answered_in_tab').then((closed) => {
      order.push('close');
      return closed;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual([]); // blocked on the tab's row
    release();
    await holder;
    expect((await closing).map((q) => q.id)).toEqual([question.id]);
    expect(order).toEqual(['holder', 'close']);
  });

  it('the migration added both indexes (spec 2026-09-26 §4.3)', async () => {
    const idx = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'tab_questions'`;
    const byName = new Map(idx.map((i) => [i.indexname, i.indexdef]));
    expect(byName.get('tab_questions_tab_id_created_at_idx')).toContain('(tab_id, created_at)');
    expect(byName.get('tab_questions_queued_tab_id_idx')).toMatch(/\(tab_id\) WHERE \(error_code = 'QUEUED'::text\)/);
  });

  it('closeOne: only that row, only while open', async () => {
    const { question: a } = await open('t10');
    const closed = await repo.closeOne(a.id, 'answered_in_tab');
    expect(closed).toMatchObject({ id: a.id, status: 'answered_in_tab', user_id: userId });
    expect(closed?.closed_at).not.toBeNull();
    expect(await repo.closeOne(a.id, 'answered_in_tab')).toBeUndefined();
    const { question: b } = await open('t11');
    await repo.claim(b.id, userId, { answers: [{ selected: [0] }] });
    expect(await repo.closeOne(b.id, 'answered_in_tab')).toBeUndefined();
    expect((await repo.findByIdForUser(b.id, userId))?.status).toBe('answered');
  });

  it('lists a conversation oldest first, and what the concierge was not told yet, once', async () => {
    const before = await repo.listByConversation(conversationId);
    const { question } = await open('t7');
    const listed = await repo.listByConversation(conversationId);
    expect(listed.map((q) => q.id)).toEqual([...before.map((q) => q.id), question.id]);

    await repo.claim(question.id, userId, { answers: [{ selected: [0] }] });
    const toInject = await repo.listToInject(conversationId);
    expect(toInject.map((q) => q.id)).toContain(question.id);
    expect(toInject.every((q) => q.status === 'answered' && q.injected_at === null)).toBe(true);
    await repo.markInjected(toInject.map((q) => q.id));
    expect(await repo.listToInject(conversationId)).toEqual([]);
  });

  it('findLatestActiveForProject: the owner\'s most recently active non-archived conversation', async () => {
    // A former owner's conversation on the project, more recent than the owner's: never picked.
    const former = await chat.getOrCreateForProject(otherUserId, projectId);
    await db.chatConversation.update({ where: { id: former.id }, data: { lastMessageAt: new Date(Date.now() + 60_000) } });
    expect((await chat.findLatestActiveForProject(projectId, userId))?.id).toBe(conversationId);
    await chat.archive(conversationId);
    expect(await chat.findLatestActiveForProject(projectId, userId)).toBeUndefined();
    expect(await chat.findLatestActiveForProject('nope', userId)).toBeUndefined();
  });

  const openSuggestion = (tabId: string, text = 'commit it') => repo.open({ tab_id: tid(tabId), project_id: projectId, conversation_id: conversationId, kind: 'suggestion', payload: { text }, tool_use_id: null });

  it("a suggestion is a row like the others: the tab's open one, closed by the tab's next event", async () => {
    const { question: s } = await openSuggestion('ts1');
    expect(s).toMatchObject({ kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', user_id: userId, tool_use_id: null });
    expect((await repo.findOpenForTab(tid('ts1')))?.id).toBe(s!.id);
    expect(await repo.closeForTab(tid('ts1'), 'answered_in_tab')).toEqual([expect.objectContaining({ id: s!.id, status: 'answered_in_tab' })]);
  });

  it('dismiss: only an open suggestion, only its owner, once — never a question', async () => {
    const { question: s } = await openSuggestion('ts2');
    expect(await repo.dismiss(s!.id, otherUserId)).toBeUndefined();
    const d = await repo.dismiss(s!.id, userId);
    expect(d).toMatchObject({ id: s!.id, status: 'dismissed' });
    expect(d?.closed_at).not.toBeNull();
    expect(await repo.dismiss(s!.id, userId)).toBeUndefined();
    const { question: q } = await open('ts3');
    expect(await repo.dismiss(q.id, userId)).toBeUndefined();
  });

  it('a sent suggestion is claimed with its text and is told to the concierge', async () => {
    const { question: s } = await openSuggestion('ts4');
    expect(await repo.claimSuggestion(s!.id, otherUserId, { text: 'commit it' })).toBeUndefined();
    expect(await repo.claimSuggestion(s!.id, userId, { text: 'commit it and push' })).toMatchObject({ status: 'answered', answer: { text: 'commit it and push' }, answered_by: userId });
    expect(await repo.claimSuggestion(s!.id, userId, { text: 'commit it' })).toBeUndefined(); // the double click
    expect((await repo.listToInject(conversationId)).map((r) => r.id)).toContain(s!.id);
  });

  it('claims keep to their kind: a question is never sent as a suggestion, nor a suggestion answered as a question', async () => {
    const { question: q } = await open('ts6');
    expect(await repo.claimSuggestion(q.id, userId, { text: 'commit it' })).toBeUndefined();
    expect((await repo.findByIdForUser(q.id, userId))?.status).toBe('open');
    const { question: s } = await openSuggestion('ts7');
    expect(await repo.claim(s!.id, userId, { allow: true })).toBeUndefined();
    expect((await repo.findByIdForUser(s!.id, userId))?.status).toBe('open');
  });

  it('a suggestion never takes part in the permission queue', async () => {
    await openPermission('ts5', 'Bash');
    expect((await openPermission('ts5', 'Edit')).question).toBeNull(); // the queue starts
    expect((await openSuggestion('ts5')).question).not.toBeNull();
    // Still queued: the suggestion is not "the newest row" of the queue rule.
    expect((await openPermission('ts5', 'Write')).question).toBeNull();
  });

  it('a suggestion opens nothing, and closes nothing, while the tab still shows a question', async () => {
    const { question: p } = await openPermission('ts8', 'Bash');
    expect(await openSuggestion('ts8')).toEqual({ question: null, closed: [] });
    expect((await repo.findOpenForTab(tid('ts8')))?.id).toBe(p!.id);
    // Answered from the chat but still on the tab's screen: still a question there.
    await repo.claim(p!.id, userId, { allow: true });
    expect(await openSuggestion('ts8')).toEqual({ question: null, closed: [] });
    expect((await repo.findByIdForUser(p!.id, userId))).toMatchObject({ status: 'answered', closed_at: null });
  });

  it('a suggestion opens nothing on a tab that no longer waits for input, or no longer exists', async () => {
    expect(await openSuggestion('ts9')).toEqual({ question: null, closed: [] });
    expect(await openSuggestion('gone')).toEqual({ question: null, closed: [] });
    expect(await repo.findOpenForTab(tid('ts9'))).toBeUndefined();
  });

  it('lists up to 200 questions and the newest 50 suggestions: suggestions never push a question out', async () => {
    const conv = await db.chatConversation.create({ data: { id: newId(), userId, projectId } });
    const t0 = Date.parse('2026-09-25T10:00:00.000Z');
    const at = (i: number) => new Date(t0 + i * 1000);
    const q = { id: newId(), tabId: 'tl', projectId, conversationId: conv.id, kind: 'choice', payload, status: 'answered_in_tab', createdAt: at(0) };
    const sugg = Array.from({ length: 60 }, (_, i) => ({ id: newId(), tabId: 'tl', projectId, conversationId: conv.id, kind: 'suggestion', payload: { text: `s${i}` }, status: 'answered_in_tab', createdAt: at(i + 1) }));
    await db.tabQuestion.createMany({ data: [q, ...sugg] });
    const listed = await repo.listByConversation(conv.id);
    expect(listed.map((r) => r.id)).toEqual([q.id, ...sugg.slice(10).map((r) => r.id)]);
  });

  it('countOpenByConversation: open questions per conversation — never a suggestion, never a closed one', async () => {
    // The previous test left its own active conversation for (userId, projectId) around (never
    // archived — it had no reason to): archive it first so this one can become the active one under
    // the partial unique index (`chat_conversations_one_active`).
    const stray = await db.chatConversation.findFirst({ where: { userId, projectId, tabId: null, archivedAt: null } });
    if (stray) await chat.archive(stray.id);
    const conv = await db.chatConversation.create({ data: { id: newId(), userId, projectId } });
    const mk = (kind: string, status: string) => ({ id: newId(), tabId: 'tc1', projectId, conversationId: conv.id, kind, payload: kind === 'suggestion' ? { text: 'x' } : { tool_name: 'Bash' }, status });
    await db.tabQuestion.createMany({ data: [mk('choice', 'open'), mk('permission', 'open'), mk('permission', 'answered'), mk('suggestion', 'open'), mk('choice', 'expired')] });
    expect(await repo.countOpenByConversation([conv.id, 'nope'])).toEqual(new Map([[conv.id, 2]]));
    expect(await repo.countOpenByConversation([])).toEqual(new Map());
  });

  it('expireOne: a dead card closes as expired once; one answered from the chat keeps its status and gets closed_at', async () => {
    const { question: a } = await open('td1');
    const e = await repo.expireOne(a.id);
    expect(e).toMatchObject({ id: a.id, status: 'expired', user_id: userId });
    expect(e?.closed_at).not.toBeNull();
    expect(await repo.expireOne(a.id)).toBeUndefined();
    const { question: b } = await open('td2');
    await repo.claim(b.id, userId, { answers: [{ selected: [0] }] });
    expect(await repo.expireOne(b.id)).toMatchObject({ id: b.id, status: 'answered' });
  });

  // Last on purpose: the sweep closes every orphan row of the database.
  it('expireOrphans: every card still on screen whose tab is gone closes (open → expired) in one statement; live tabs are untouched', async () => {
    const at = new Date('2026-09-26T12:00:00.000Z');
    const earlier = new Date('2026-09-26T11:00:00.000Z');
    const mk = (id: string, tabId: string, status: string, closedAt: Date | null = null) => ({ id, tabId, projectId, conversationId, kind: 'permission', payload: { tool_name: 'Bash' }, status, closedAt });
    const [gone1, gone2, closedGone, live] = [newId(), newId(), newId(), newId()];
    await db.tabQuestion.createMany({ data: [mk(gone1, 'gone-a', 'open'), mk(gone2, 'gone-b', 'answered'), mk(closedGone, 'gone-c', 'answered_in_tab', earlier), mk(live, tid('ts1'), 'open')] });
    const swept = await repo.expireOrphans(at);
    const mine = swept.filter((q) => [gone1, gone2, closedGone, live].includes(q.id)).sort((x, y) => (x.id < y.id ? -1 : 1));
    const want = [
      { id: gone1, status: 'expired', closed_at: at.toISOString(), user_id: userId },
      { id: gone2, status: 'answered', closed_at: at.toISOString(), user_id: userId },
    ].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(mine.map(({ id, status, closed_at, user_id }) => ({ id, status, closed_at, user_id }))).toEqual(want);
    expect(await db.tabQuestion.findUnique({ where: { id: live } })).toMatchObject({ status: 'open', closedAt: null });
    expect((await db.tabQuestion.findUnique({ where: { id: closedGone } }))?.closedAt?.toISOString()).toBe(earlier.toISOString());
    expect((await repo.expireOrphans(at)).filter((q) => [gone1, gone2].includes(q.id))).toEqual([]);
  });
});
