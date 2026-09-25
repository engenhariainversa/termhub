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

  const open = (tabId: string, now?: Date) => repo.open({ tab_id: tabId, project_id: projectId, conversation_id: conversationId, kind: 'choice', payload, tool_use_id: 'toolu_1' }, now);

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

  it('findLatestActiveForProject: the most recently active non-archived conversation', async () => {
    expect((await chat.findLatestActiveForProject(projectId))?.id).toBe(conversationId);
    await chat.archive(conversationId);
    expect(await chat.findLatestActiveForProject(projectId)).toBeUndefined();
    expect(await chat.findLatestActiveForProject('nope')).toBeUndefined();
  });
});
