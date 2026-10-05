import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TabQuestionSuggestion } from '../../chat/decision-text.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';
import { LIST_OPEN_CHOICES_MAX, TabQuestionsRepository, type AutoAnswer, type CloseScope } from './tab-questions.js';

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
  const tabIds: Record<string, string> = Object.fromEntries(['ts1', 'ts2', 'ts4', 'ts5', 'ts7', 'ts8', 'ts9', 'tq1', 'tx1', 'thq'].map((k) => [k, newId()]));
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
    await db.tab.createMany({ data: ['ts1', 'ts2', 'ts4', 'ts5', 'ts7', 'ts8', 'tq1', 'tx1', 'thq'].map((id) => ({ id: tabIds[id]!, projectId, machineId, name: id, state: 'waiting_input' as const })) });
    await db.tab.create({ data: { id: tabIds.ts9!, projectId, machineId, name: 'ts9', state: 'working' } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: projectId } }); // cascades its conversations and questions
    await db.machine.deleteMany({ where: { id: machineId } });
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.$disconnect();
  });

  const open = async (tabId: string, now?: Date) => {
    const r = await repo.open({ tab_id: tid(tabId), project_id: projectId, conversation_id: conversationId, kind: 'choice', payload, tool_use_id: 'toolu_1', agent_id: null }, now);
    return { question: r.question!, closed: r.closed };
  };
  const openPermission = (tabId: string, tool: string, agentId: string | null = null) => repo.open({ tab_id: tid(tabId), project_id: projectId, conversation_id: conversationId, kind: 'permission', payload: { tool_name: tool }, tool_use_id: null, agent_id: agentId });

  const tool = (agent: string): CloseScope => ({ agent, leavesQueue: false });
  const ended = (agent: string | null): CloseScope => ({ agent, leavesQueue: true });
  const queueState = (id: string) => db.tabQuestion.findUniqueOrThrow({ where: { id }, select: { errorCode: true, queueAgents: true } });
  const queuedPair = async (tabId: string) => {
    const first = (await openPermission(tabId, 'Bash', 'A')).question!;
    expect(first).toMatchObject({ status: 'open' });
    expect(await openPermission(tabId, 'Bash', 'B')).toEqual({ question: null, closed: [expect.objectContaining({ id: first.id, status: 'answered_in_tab' })] });
    expect(await queueState(first.id)).toEqual({ errorCode: 'QUEUED', queueAgents: ['A', 'B'] });
    return first.id;
  };

  it('scoped closes reach only their agent and tab, including main-thread choices', async () => {
    const aTab = newId();
    const mainTab = newId();
    const a = (await openPermission(aTab, 'Bash', 'A')).question!;
    const main = (await open(mainTab)).question;
    expect(await repo.closeForTab(aTab, 'answered_in_tab', ended(null))).toEqual([]);
    expect(await repo.closeForTab(aTab, 'answered_in_tab', tool('B'))).toEqual([]);
    expect((await repo.findOpenForTab(aTab))?.id).toBe(a.id);
    expect(await repo.closeForTab(aTab, 'answered_in_tab', tool('A'))).toEqual([expect.objectContaining({ id: a.id, status: 'answered_in_tab' })]);
    expect(await repo.closeForTab(mainTab, 'answered_in_tab', tool('A'))).toEqual([]);
    expect(await repo.closeForTab(mainTab, 'answered_in_tab', ended(null))).toEqual([expect.objectContaining({ id: main.id, status: 'answered_in_tab' })]);
  });

  it('a scoped close preserves an answered card status and stamps closed_at only for its agent', async () => {
    const tabId = newId();
    const a = (await openPermission(tabId, 'Bash', 'A')).question!;
    await repo.claim(a.id, userId, { allow: true });
    expect(await repo.closeForTab(tabId, 'answered_in_tab', tool('B'))).toEqual([]);
    expect((await repo.findByIdForUser(a.id, userId))?.closed_at).toBeNull();
    const at = new Date('2026-09-30T05:00:00.000Z');
    expect(await repo.closeForTab(tabId, 'answered_in_tab', ended('A'), at)).toEqual([expect.objectContaining({ id: a.id, status: 'answered', closed_at: at.toISOString() })]);
  });

  it('a queue keeps each agent until it ends, and adds new members without duplicates', async () => {
    const tabId = newId();
    const id = await queuedPair(tabId);
    for (const agent of ['A', 'B']) {
      expect(await repo.closeForTab(tabId, 'answered_in_tab', tool(agent))).toEqual([]);
      expect(await queueState(id)).toEqual({ errorCode: 'QUEUED', queueAgents: ['A', 'B'] });
    }
    await repo.closeForTab(tabId, 'answered_in_tab', ended('H'));
    expect(await queueState(id)).toEqual({ errorCode: 'QUEUED', queueAgents: ['A', 'B'] });
    await repo.closeForTab(tabId, 'answered_in_tab', ended('A'));
    expect(await queueState(id)).toEqual({ errorCode: 'QUEUED', queueAgents: ['B'] });
    expect(await openPermission(tabId, 'Edit', 'C')).toEqual({ question: null, closed: [] });
    expect(await openPermission(tabId, 'Bash', 'C')).toEqual({ question: null, closed: [] });
    expect(await queueState(id)).toEqual({ errorCode: 'QUEUED', queueAgents: ['B', 'C'] });
    await repo.closeForTab(tabId, 'answered_in_tab', ended(null));
    expect(await queueState(id)).toEqual({ errorCode: 'QUEUED', queueAgents: ['B', 'C'] });
    await repo.closeForTab(tabId, 'answered_in_tab', ended('B'));
    expect(await queueState(id)).toEqual({ errorCode: 'QUEUED', queueAgents: ['C'] });
    await repo.closeForTab(tabId, 'answered_in_tab', ended('C'));
    expect(await queueState(id)).toEqual({ errorCode: null, queueAgents: [] });
    expect((await openPermission(tabId, 'Bash', 'A')).question).toMatchObject({ status: 'open' });
  });

  it('the default all scope ends a queue at once', async () => {
    const tabId = newId();
    const id = await queuedPair(tabId);
    expect(await repo.closeForTab(tabId, 'answered_in_tab')).toEqual([]);
    expect(await queueState(id)).toEqual({ errorCode: null, queueAgents: [] });
  });

  it('the main thread queue has one empty-string member and ends on its closing event', async () => {
    const tabId = newId();
    const first = (await openPermission(tabId, 'Bash')).question!;
    expect((await openPermission(tabId, 'Edit')).question).toBeNull();
    expect(await queueState(first.id)).toEqual({ errorCode: 'QUEUED', queueAgents: [''] });
    await repo.closeForTab(tabId, 'answered_in_tab', ended(null));
    expect(await queueState(first.id)).toEqual({ errorCode: null, queueAgents: [] });
  });

  it.each(['A', null])('a previous-release queue survives tools and ends when %s leaves', async (agent) => {
    const tabId = newId();
    const first = (await openPermission(tabId, 'Bash')).question!;
    await repo.closeForTab(tabId, 'answered_in_tab');
    await db.tabQuestion.update({ where: { id: first.id }, data: { errorCode: 'QUEUED', queueAgents: [] } });
    await repo.closeForTab(tabId, 'answered_in_tab', tool('A'));
    expect(await queueState(first.id)).toEqual({ errorCode: 'QUEUED', queueAgents: [] });
    await repo.closeForTab(tabId, 'answered_in_tab', ended(agent));
    expect(await queueState(first.id)).toEqual({ errorCode: null, queueAgents: [] });
  });

  it.each([true, false])('a choice clears every queue mark and list, with conversation=%s', async (hasConversation) => {
    const tabId = newId();
    const id = await queuedPair(tabId);
    // A previous release may leave an older mark behind too: clear every marked row.
    const olderId = newId();
    await db.tabQuestion.create({ data: { id: olderId, tabId, projectId, conversationId, kind: 'permission', payload: { tool_name: 'Bash' }, status: 'answered_in_tab', closedAt: new Date(), createdAt: new Date('2026-09-01'), errorCode: 'QUEUED', queueAgents: ['D'] } });
    const result = await repo.open({ tab_id: tabId, project_id: projectId, conversation_id: hasConversation ? conversationId : null, kind: 'choice', payload, tool_use_id: null, agent_id: null });
    if (hasConversation) expect(result.question).toMatchObject({ kind: 'choice', status: 'open' });
    else expect(result.question).toBeNull();
    for (const markedId of [id, olderId]) expect(await queueState(markedId)).toEqual({ errorCode: null, queueAgents: [] });
  });

  it('open stores a subagent id and null for the main thread', async () => {
    const a = (await openPermission(newId(), 'Bash', 'A')).question!;
    const main = (await open(newId())).question;
    expect(await db.tabQuestion.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ agentId: 'A' });
    expect(await db.tabQuestion.findUniqueOrThrow({ where: { id: main.id } })).toMatchObject({ agentId: null });
  });

  it('surfaces the open questions of the conversation, never a suggestion nor a closed one (TER-477)', async () => {
    const { question } = await open('tsurf1');
    const closedOne = (await open('tsurf2')).question;
    await repo.closeOne(closedOne.id, 'answered_in_tab');
    expect(question.surfaced_at).toBeNull();
    const now = new Date('2030-01-01T00:00:00.000Z');
    const surfaced = await repo.surfaceOpen(conversationId, now);
    expect(surfaced.map((r) => r.id)).toContain(question.id);
    expect(surfaced.map((r) => r.id)).not.toContain(closedOne.id);
    expect(surfaced.every((r) => r.kind !== 'suggestion' && r.status === 'open')).toBe(true);
    expect(surfaced.find((r) => r.id === question.id)?.surfaced_at).toBe(now.toISOString());
    await repo.closeOne(question.id, 'answered_in_tab');
  });

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

  it('attaches a suggestion to a still-open question, and only to one still open', async () => {
    const { question } = await open('t14');
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: newId(), similarity: 0.9, selected: [0], source: { question: 'Qual cor?', project_name: 'proj', answered_at: '2026-09-20T00:00:00.000Z' } }],
    };
    const withSuggestion = await repo.setSuggestion(question.id, suggestion);
    expect(withSuggestion).toMatchObject({ id: question.id, suggestion });
    expect((await repo.findByIdForUser(question.id, userId))?.suggestion).toEqual(suggestion);

    await repo.claim(question.id, userId, { answers: [{ selected: [0] }] });
    expect(await repo.setSuggestion(question.id, suggestion)).toBeUndefined(); // no longer open
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
    expect(await repo.open({ tab_id: 't12', project_id: projectId, conversation_id: null, kind: 'permission', payload: { tool_name: 'Write' }, tool_use_id: null, agent_id: null })).toEqual({ question: null, closed: [] });
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
        ? { tab_id: tid(tabId), project_id: projectId, conversation_id: null, kind, payload, tool_use_id: 'toolu_1', agent_id: null }
        : { tab_id: tid(tabId), project_id: projectId, conversation_id: null, kind, payload: { tool_name: 'Edit' }, tool_use_id: null, agent_id: null },
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

  const openSuggestion = (tabId: string, text = 'commit it') => repo.open({ tab_id: tid(tabId), project_id: projectId, conversation_id: conversationId, kind: 'suggestion', payload: { text }, tool_use_id: null, agent_id: null });

  it('hasOpenQuestion counts open questions and permissions, never suggestions (agentic board follower)', async () => {
    await openSuggestion('thq');
    expect(await repo.hasOpenQuestion(tid('thq'))).toBe(false);
    const { question } = await open('thq');
    expect(await repo.hasOpenQuestion(tid('thq'))).toBe(true);
    await repo.closeOne(question.id, 'answered_in_tab');
    expect(await repo.hasOpenQuestion(tid('thq'))).toBe(false);
    await openPermission('thq', 'Bash');
    expect(await repo.hasOpenQuestion(tid('thq'))).toBe(true);
  });

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

  it('a resume card (TER-643) opens on an idle tab only, and expires what the dead process left open', async () => {
    const exited = (tabId: string) => repo.open({ tab_id: tid(tabId), project_id: projectId, conversation_id: conversationId, kind: 'suggestion', payload: { text: 'claude --continue', exited: true, last_at: null }, tool_use_id: null, agent_id: null });
    const left = (await open('tx1')).question;
    expect(await exited('tx1')).toEqual({ question: null, closed: [] }); // still waiting: no card
    await db.tab.update({ where: { id: tid('tx1') }, data: { state: 'idle' } });
    const r = await exited('tx1');
    expect(r.question).toMatchObject({ kind: 'suggestion', status: 'open', payload: { text: 'claude --continue', exited: true } });
    expect(r.closed).toEqual([expect.objectContaining({ id: left.id, status: 'expired' })]);
    // and a plain suggestion still needs a tab waiting for input
    expect(await openSuggestion('tx1')).toEqual({ question: null, closed: [] });
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

  const autoAnswer = (over: Partial<AutoAnswer> = {}): AutoAnswer => ({
    answer: { answers: [{ selected: [0] }] },
    by: 'memory',
    reason: 'Mesma pergunta respondida antes',
    sources: [{ kind: 'decision', id: newId() }],
    due_at: new Date(Date.now() + 60_000).toISOString(),
    status: 'scheduled',
    ...over,
  });
  const dueNow = () => new Date(Date.now() - 1000).toISOString();

  it('setAutoAnswer: only an open row, and only while no countdown is already scheduled', async () => {
    const { question } = await open('ta1');
    const auto = autoAnswer();
    const withAuto = await repo.setAutoAnswer(question.id, auto);
    expect(withAuto).toMatchObject({ id: question.id, auto_answer: auto });

    // Already scheduled: a second call changes nothing.
    expect(await repo.setAutoAnswer(question.id, autoAnswer({ reason: 'outro motivo' }))).toBeUndefined();
    expect((await repo.findByIdForUser(question.id, userId))?.auto_answer).toMatchObject({ reason: 'Mesma pergunta respondida antes' });

    // No longer open (answered from the chat): never gets a countdown.
    const { question: answeredQ } = await open('ta2');
    await repo.claim(answeredQ.id, userId, { answers: [{ selected: [0] }] });
    expect(await repo.setAutoAnswer(answeredQ.id, autoAnswer())).toBeUndefined();
  });

  it('setAutoAnswer: never over a countdown already claimed (sent), so a failed send cannot be followed by a second one', async () => {
    const { question } = await open('ta11');
    await repo.setAutoAnswer(question.id, autoAnswer({ due_at: dueNow() }));
    expect((await repo.claimAutoAnswer(question.id))?.auto_answer?.status).toBe('sent');
    expect(await repo.setAutoAnswer(question.id, autoAnswer({ reason: 'de novo' }))).toBeUndefined();
    // The sweeper's own failure path still finds its claimed countdown.
    expect((await repo.finishAutoAnswer(question.id, 'failed', 'PROMPT_MOVED'))?.auto_answer).toMatchObject({ status: 'failed', reason: 'Mesma pergunta respondida antes' });
  });

  it('setAutoAnswer: never over a countdown the person cancelled, so an overlapping call cannot restart it', async () => {
    const { question } = await open('ta14');
    await repo.setAutoAnswer(question.id, autoAnswer());
    expect((await repo.cancelAutoAnswer(question.id, userId))?.auto_answer?.status).toBe('cancelled');
    expect(await repo.setAutoAnswer(question.id, autoAnswer({ reason: 'de novo' }))).toBeUndefined();
    expect((await repo.findByIdForUser(question.id, userId))?.auto_answer).toMatchObject({ status: 'cancelled', reason: 'Mesma pergunta respondida antes', decided_by: userId });
  });

  it('cancelScheduledForUser: every scheduled countdown of this user becomes cancelled — never a sent one, never another user\'s', async () => {
    const otherProject = newId();
    await db.project.create({ data: { id: otherProject, key: `Q${otherProject.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'other', ownerId: otherUserId } });
    const otherConversation = (await chat.getOrCreateForProject(otherUserId, otherProject)).id;
    try {
      const { question: scheduled } = await open('tc10');
      await repo.setAutoAnswer(scheduled.id, autoAnswer());
      const { question: sent } = await open('tc11');
      await repo.setAutoAnswer(sent.id, autoAnswer({ due_at: dueNow() }));
      await repo.claimAutoAnswer(sent.id);
      const { question: foreign } = await repo.open({ tab_id: 'tc12', project_id: otherProject, conversation_id: otherConversation, kind: 'choice', payload, tool_use_id: null, agent_id: null });
      await repo.setAutoAnswer(foreign!.id, autoAnswer());

      const cancelled = await repo.cancelScheduledForUser(userId);
      expect(cancelled.map((q) => q.id)).toContain(scheduled.id);
      expect(cancelled.map((q) => q.id)).not.toContain(sent.id);
      expect(cancelled.map((q) => q.id)).not.toContain(foreign!.id);
      expect(cancelled.find((q) => q.id === scheduled.id)).toMatchObject({ status: 'open', user_id: userId, auto_answer: { status: 'cancelled', decided_by: userId } });
      expect((await repo.findByIdForUser(sent.id, userId))?.auto_answer?.status).toBe('sent');
      expect((await repo.findByIdForUser(foreign!.id, otherUserId))?.auto_answer?.status).toBe('scheduled');
      // Nothing left to cancel: a second call is a no-op.
      expect((await repo.cancelScheduledForUser(userId)).map((q) => q.id)).not.toContain(scheduled.id);
    } finally {
      await db.project.deleteMany({ where: { id: otherProject } });
    }
  });

  it('claimAutoAnswer: scheduled → sent, only once due, exactly one winner of two racing claims, never after cancelAutoAnswer', async () => {
    const { question: notDue } = await open('ta3');
    await repo.setAutoAnswer(notDue.id, autoAnswer());
    expect(await repo.claimAutoAnswer(notDue.id)).toBeUndefined(); // due_at in the future

    const { question: raced } = await open('ta4');
    await repo.setAutoAnswer(raced.id, autoAnswer({ due_at: dueNow() }));
    const [a, b] = await Promise.all([repo.claimAutoAnswer(raced.id), repo.claimAutoAnswer(raced.id)]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners.length).toBe(1);
    expect(winners[0]!.auto_answer?.status).toBe('sent');

    const { question: cancelledFirst } = await open('ta5');
    await repo.setAutoAnswer(cancelledFirst.id, autoAnswer({ due_at: dueNow() }));
    await repo.cancelAutoAnswer(cancelledFirst.id, userId);
    expect(await repo.claimAutoAnswer(cancelledFirst.id)).toBeUndefined();
  });

  it('finishAutoAnswer: sent → failed with the code, only a claimed (sent) countdown', async () => {
    const { question } = await open('ta6');
    await repo.setAutoAnswer(question.id, autoAnswer({ due_at: dueNow() }));
    expect(await repo.finishAutoAnswer(question.id, 'failed', 'PROMPT_MOVED')).toBeUndefined(); // still scheduled, not sent
    await repo.claimAutoAnswer(question.id);
    const failed = await repo.finishAutoAnswer(question.id, 'failed', 'PROMPT_MOVED');
    expect(failed?.auto_answer).toMatchObject({ status: 'failed', error_code: 'PROMPT_MOVED' });
  });

  it('listDueAutoAnswers: only scheduled, due, open rows', async () => {
    const { question: due } = await open('ta7');
    await repo.setAutoAnswer(due.id, autoAnswer({ due_at: dueNow() }));
    const { question: notDue } = await open('ta8');
    await repo.setAutoAnswer(notDue.id, autoAnswer());
    const { question: cancelled } = await open('ta9');
    await repo.setAutoAnswer(cancelled.id, autoAnswer({ due_at: dueNow() }));
    await repo.cancelAutoAnswer(cancelled.id, userId);
    const { question: noLongerOpen } = await open('ta10');
    await repo.setAutoAnswer(noLongerOpen.id, autoAnswer({ due_at: dueNow() }));
    await repo.claim(noLongerOpen.id, userId, { answers: [{ selected: [0] }] });

    const dueRows = await repo.listDueAutoAnswers(new Date(), 1000);
    const ids = dueRows.map((r) => r.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(notDue.id);
    expect(ids).not.toContain(cancelled.id);
    expect(ids).not.toContain(noLongerOpen.id);
  });

  /** Moves a claimed countdown's `claimed_at` back by `minutes` on the database's own clock. */
  const backdateClaim = (id: string, minutes: number) =>
    db.$executeRaw`UPDATE "tab_questions" SET "auto_answer" = jsonb_set("auto_answer", '{claimed_at}', to_jsonb(now() - ${minutes} * interval '1 minute')) WHERE "id" = ${id}`;
  const LOST_AFTER_MS = 2 * 60_000;

  it('claimAutoAnswer stamps claimed_at with the database clock, not the caller\'s tick time', async () => {
    const { question } = await open('tl0');
    await repo.setAutoAnswer(question.id, autoAnswer({ due_at: new Date(Date.now() - 10 * 60_000).toISOString() }));
    // A tick that started long ago (a slow batch) still stamps the claim as happening now.
    const claimed = await repo.claimAutoAnswer(question.id, new Date(Date.now() - 5 * 60_000));
    const [{ db_now }] = await db.$queryRaw<{ db_now: Date }[]>`SELECT now() AS db_now`;
    expect(claimed?.auto_answer?.status).toBe('sent');
    expect(Math.abs(new Date(claimed!.auto_answer!.claimed_at!).getTime() - db_now.getTime())).toBeLessThan(5_000);
  });

  it('failLostAutoAnswers: only open rows claimed longer ago than the limit, on the database clock', async () => {
    const longDue = () => new Date(Date.now() - 10 * 60_000).toISOString();
    const { question: lost } = await open('tl1');
    await repo.setAutoAnswer(lost.id, autoAnswer({ due_at: longDue() }));
    await repo.claimAutoAnswer(lost.id);
    await backdateClaim(lost.id, 5);
    // Claimed just now, with a due_at long past (a late tick): not lost.
    const { question: fresh } = await open('tl2');
    await repo.setAutoAnswer(fresh.id, autoAnswer({ due_at: longDue() }));
    await repo.claimAutoAnswer(fresh.id);
    // Sent and answered: the send finished, nothing to recover.
    const { question: done } = await open('tl3');
    await repo.setAutoAnswer(done.id, autoAnswer({ due_at: longDue() }));
    await repo.claimAutoAnswer(done.id);
    await repo.claim(done.id, userId, { answers: [{ selected: [0] }] }, new Date(), 'auto');
    await backdateClaim(done.id, 5);
    // Still scheduled: not the sender's.
    const { question: waiting } = await open('tl4');
    await repo.setAutoAnswer(waiting.id, autoAnswer({ due_at: longDue() }));

    const failed = await repo.failLostAutoAnswers('SENDER_LOST', LOST_AFTER_MS);
    const ids = failed.map((r) => r.id);
    expect(ids).toContain(lost.id);
    expect(ids).not.toContain(fresh.id);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(waiting.id);
    expect(failed.find((r) => r.id === lost.id)).toMatchObject({ status: 'open', auto_answer: { status: 'failed', error_code: 'SENDER_LOST' } });
    expect(await repo.failLostAutoAnswers('SENDER_LOST', LOST_AFTER_MS)).not.toContainEqual(expect.objectContaining({ id: lost.id }));
  });

  it('failLostAutoAnswers: a row claimed before claimed_at existed falls back to its due_at', async () => {
    const { question } = await open('tl5');
    await repo.setAutoAnswer(question.id, autoAnswer({ due_at: new Date(Date.now() - 10 * 60_000).toISOString(), status: 'sent' as const }));
    // setAutoAnswer refuses over sent, so this row is stored as `sent` from the start: no claimed_at.
    const failed = await repo.failLostAutoAnswers('SENDER_LOST', LOST_AFTER_MS);
    expect(failed.map((r) => r.id)).toContain(question.id);
  });

  it("claim(..., 'auto') needs the countdown still `sent`: a recovered (failed) countdown can never be typed", async () => {
    const { question } = await open('tl6');
    await repo.setAutoAnswer(question.id, autoAnswer({ due_at: new Date(Date.now() - 10 * 60_000).toISOString() }));
    await repo.claimAutoAnswer(question.id);
    await backdateClaim(question.id, 5);
    await repo.failLostAutoAnswers('SENDER_LOST', LOST_AFTER_MS);
    expect(await repo.claim(question.id, userId, { answers: [{ selected: [0] }] }, undefined, 'auto')).toBeUndefined();
    expect((await repo.findByIdForUser(question.id, userId))?.status).toBe('open');
    // The person can still answer it by hand.
    expect((await repo.claim(question.id, userId, { answers: [{ selected: [1] }] }))?.answered_via).toBe('card');
  });

  it('markWoken: true for the one winner, false for every call after, and false for a row not open or already carrying an auto_answer (fix round 1)', async () => {
    const { question } = await open('ta11');
    expect(await repo.markWoken(question.id)).toBe(true);
    expect(await repo.markWoken(question.id)).toBe(false);
    expect(await repo.markWoken(newId())).toBe(false); // never existed

    // Answered from the tab between the card's publish and this claim: never woken for.
    const { question: answered } = await open('ta11b');
    await repo.claim(answered.id, userId, { answers: [{ selected: [0] }] });
    expect(await repo.markWoken(answered.id)).toBe(false);

    // The repeat path (or a prior answer_tab_question) scheduled a countdown in the same window:
    // the row is still `open`, but already has an answer on the way — never woken for either.
    const { question: withAuto } = await open('ta11c');
    await repo.setAutoAnswer(withAuto.id, autoAnswer());
    expect(await repo.markWoken(withAuto.id)).toBe(false);
  });

  it('claim: answered_via defaults to "card"; claim(..., \'auto\') stores "auto"', async () => {
    const { question: q1 } = await open('ta12');
    const claimed1 = await repo.claim(q1.id, userId, { answers: [{ selected: [0] }] });
    expect(claimed1?.answered_via).toBe('card');

    // 'auto' only over a countdown this sender claimed (`sent`): not a bare open row, not a scheduled one.
    const { question: q2 } = await open('ta13');
    expect(await repo.claim(q2.id, userId, { answers: [{ selected: [0] }] }, undefined, 'auto')).toBeUndefined();
    await repo.setAutoAnswer(q2.id, autoAnswer({ due_at: dueNow() }));
    expect(await repo.claim(q2.id, userId, { answers: [{ selected: [0] }] }, undefined, 'auto')).toBeUndefined();
    await repo.claimAutoAnswer(q2.id);
    const claimed2 = await repo.claim(q2.id, userId, { answers: [{ selected: [0] }] }, undefined, 'auto');
    expect(claimed2?.answered_via).toBe('auto');
  });

  it('listOpenChoicesForUser: only this user\'s open choice rows — never a permission, never one already answered, never another user\'s — and project_id narrows further', async () => {
    const project2 = newId();
    await db.project.create({ data: { id: project2, key: `Q${project2.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'proj2', ownerId: userId } });
    const conversation2 = (await chat.getOrCreateForProject(userId, project2)).id;
    try {
      const { question: openChoice } = await open('lq1');
      const { question: openPerm } = await openPermission('lq2', 'Bash');
      const { question: answered } = await open('lq3');
      await repo.claim(answered.id, userId, { answers: [{ selected: [0] }] });
      const { question: otherProjectChoice } = await repo.open({ tab_id: 'lq4', project_id: project2, conversation_id: conversation2, kind: 'choice', payload, tool_use_id: null, agent_id: null });

      const mine = await repo.listOpenChoicesForUser(userId);
      const ids = mine.map((q) => q.id);
      expect(ids).toContain(openChoice.id);
      expect(ids).toContain(otherProjectChoice!.id);
      expect(ids).not.toContain(openPerm!.id);
      expect(ids).not.toContain(answered.id);
      expect(mine.every((q) => q.kind === 'choice' && q.status === 'open')).toBe(true);

      // The shared project already carries open choice rows left behind by earlier tests in this
      // file, so this narrowed read is checked by containment, not by exact membership.
      const idsInProject1 = (await repo.listOpenChoicesForUser(userId, projectId)).map((q) => q.id);
      expect(idsInProject1).toContain(openChoice.id);
      expect(idsInProject1).not.toContain(otherProjectChoice!.id);
      expect((await repo.listOpenChoicesForUser(userId, project2)).map((q) => q.id)).toEqual([otherProjectChoice!.id]);
      expect(await repo.listOpenChoicesForUser(otherUserId)).toEqual([]);
    } finally {
      await db.project.deleteMany({ where: { id: project2 } }); // cascades its conversation and questions
    }
  });

  it('listOpenChoicesForUser: at most LIST_OPEN_CHOICES_MAX rows, newest first', async () => {
    const lonely = newId();
    const project3 = newId();
    await db.user.create({ data: { id: lonely, email: `${lonely}@test.local`, name: 'lonely' } });
    await db.project.create({ data: { id: project3, key: `Q${project3.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'proj3', ownerId: lonely } });
    try {
      const conv = (await chat.getOrCreateForProject(lonely, project3)).id;
      const base = Date.parse('2026-09-26T00:00:00.000Z');
      const ids = Array.from({ length: LIST_OPEN_CHOICES_MAX + 2 }, () => newId());
      await db.tabQuestion.createMany({ data: ids.map((id, i) => ({ id, tabId: `lm${i}`, projectId: project3, conversationId: conv, kind: 'choice', payload, status: 'open', createdAt: new Date(base + i * 1000) })) });
      const listed = await repo.listOpenChoicesForUser(lonely);
      expect(listed).toHaveLength(LIST_OPEN_CHOICES_MAX);
      expect(listed.map((q) => q.id)).toEqual(ids.slice(2).reverse());
    } finally {
      await db.project.deleteMany({ where: { id: project3 } });
      await db.user.deleteMany({ where: { id: lonely } });
    }
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
