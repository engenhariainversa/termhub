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
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: projectId } }); // cascades its conversations and questions
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.$disconnect();
  });

  const open = async (tabId: string, now?: Date) => {
    const r = await repo.open({ tab_id: tabId, project_id: projectId, conversation_id: conversationId, kind: 'choice', payload, tool_use_id: 'toolu_1' }, now);
    return { question: r.question!, closed: r.closed };
  };
  const openPermission = (tabId: string, tool: string) => repo.open({ tab_id: tabId, project_id: projectId, conversation_id: conversationId, kind: 'permission', payload: { tool_name: tool }, tool_use_id: null });

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
    // A closing path that does not end the queue (a question event with no chat) keeps it.
    await openPermission('t12', 'Edit'); // queues again
    await repo.closeForTab('t12', 'answered_in_tab', new Date(), { endsQueue: false });
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
});
