import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { ChatRepository } from './chat.js';
import { UsersRepository } from './users.js';
import { ChatDecisionsRepository, type NewDecision } from './chat-decisions.js';

const DIM = 384;
/** A unit vector with a 1 at index `i`: cosine similarity to itself is exactly 1, and to another such
 *  vector (a different `i`) exactly 0 — so `nearest`'s ordering and `similarity` are exact, not fuzzy. */
const vec = (i: number): number[] => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
/** A normalised blend of `vec(i)` and `vec(j)`, weight `w` on `i`: still a unit vector, so its cosine
 *  similarity to `vec(i)` is exactly `w / sqrt(w^2 + (1-w)^2)` — closer to 1 than an unrelated vector. */
const mix = (i: number, j: number, w: number): number[] => {
  const raw = Array.from({ length: DIM }, (_, k) => (k === i ? w : k === j ? 1 - w : 0));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / norm);
};

const choicePayload = { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] };
const options = [{ label: 'Azul', description: '' }, { label: 'Verde', description: '' }];
const answer = { labels: ['Azul'] };

describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('ChatDecisionsRepository (Postgres)', () => {
  let db: PrismaClient;
  let repo: ChatDecisionsRepository;
  let users: UsersRepository;
  let chat: ChatRepository;
  let userId: string;
  let otherUserId: string;
  let projectId: string;
  let conversationId: string;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repo = new ChatDecisionsRepository(db);
    users = new UsersRepository(db);
    chat = new ChatRepository(db);
    userId = newId();
    otherUserId = newId();
    projectId = newId();
    await db.user.create({ data: { id: userId, email: `${userId}@test.local`, name: 'test' } });
    await db.user.create({ data: { id: otherUserId, email: `${otherUserId}@test.local`, name: 'other' } });
    await db.project.create({ data: { id: projectId, key: `D${projectId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'proj', ownerId: userId } });
    conversationId = (await chat.getOrCreateForProject(userId, projectId)).id;
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { id: projectId } }); // cascades its conversations and tab_questions
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }); // cascades their chat_decisions
    await db.$disconnect();
  });

  const newDecision = (over: Partial<NewDecision> = {}): NewDecision => ({
    user_id: userId,
    project_id: projectId,
    conversation_id: conversationId,
    tab_question_id: null,
    question_index: 0,
    header: 'Fonte',
    question: 'Qual fonte usar?',
    options,
    multi_select: false,
    answer,
    ...over,
  });

  let decisionAId: string;

  it('insertMany returns the rows; the same (tab_question_id, question_index) again inserts nothing', async () => {
    const tabQuestionId = newId();
    const [row] = await repo.insertMany([newDecision({ tab_question_id: tabQuestionId })]);
    expect(row).toMatchObject({
      user_id: userId,
      project_id: projectId,
      project_name: 'proj',
      conversation_id: conversationId,
      tab_question_id: tabQuestionId,
      question_index: 0,
      header: 'Fonte',
      question: 'Qual fonte usar?',
      options,
      multi_select: false,
      answer,
      embed_model: null,
      suggested_count: 0,
      accepted_count: 0,
    });
    expect(row!.id).toBeTruthy();
    expect(row!.created_at).toBeTruthy();
    decisionAId = row!.id;

    // Same (tab_question_id, question_index) again: nothing inserted, the row stays alone.
    expect(await repo.insertMany([newDecision({ tab_question_id: tabQuestionId })])).toEqual([]);
    const stillOne = await db.chatDecision.count({ where: { tabQuestionId: tabQuestionId } });
    expect(stillOne).toBe(1);
  });

  it('listToEmbed returns rows without an embedding; setEmbedding clears it from the list and sets embed_model', async () => {
    const before = await repo.listToEmbed(1000, '#q1');
    expect(before.map((d) => d.id)).toContain(decisionAId);
    const found = before.find((d) => d.id === decisionAId)!;
    expect(found).toMatchObject({ header: 'Fonte', question: 'Qual fonte usar?', options });

    await repo.setEmbedding(decisionAId, vec(1), 'm#q1');

    const after = await repo.listToEmbed(1000, '#q1');
    expect(after.map((d) => d.id)).not.toContain(decisionAId);

    const page = await repo.listForUser(userId, { limit: 1000 });
    expect(page.items.find((d) => d.id === decisionAId)).toMatchObject({ embed_model: 'm#q1' });
  });

  it('nearest: best match first, scoped to the user and the multi_select shape, only embedded rows', async () => {
    const [b] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Estilo', question: 'Qual estilo?' })]);
    await repo.setEmbedding(b!.id, mix(1, 2, 0.5), 'm#q1');

    const [multi] = await repo.insertMany([newDecision({ tab_question_id: newId(), multi_select: true, header: 'Multi', question: 'Quais opcoes?' })]);
    await repo.setEmbedding(multi!.id, vec(1), 'm#q1');

    const [unembedded] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'SemEmbedding', question: 'Ainda sem embedding?' })]);

    const [otherUserRow] = await repo.insertMany([
      newDecision({ user_id: otherUserId, project_id: null, conversation_id: null, tab_question_id: newId(), header: 'Outro', question: 'Pergunta de outro usuario?' }),
    ]);
    await repo.setEmbedding(otherUserRow!.id, vec(1), 'm#q1');

    const neighbours = await repo.nearest(userId, vec(1), { multiSelect: false, k: 5, embedModel: 'm#q1' });
    expect(neighbours[0]).toMatchObject({ id: decisionAId, project_name: 'proj' });
    expect(neighbours[0]!.similarity).toBeCloseTo(1, 5);
    expect(neighbours[1]!.id).toBe(b!.id);

    const ids = neighbours.map((n) => n.id);
    expect(ids).not.toContain(multi!.id);
    expect(ids).not.toContain(unembedded!.id);
    expect(ids).not.toContain(otherUserRow!.id);
  });

  it('listToEmbed also returns rows embedded under another text version, null embeddings first', async () => {
    const [stale] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Velha', question: 'Embedding antigo?' })]);
    await repo.setEmbedding(stale!.id, vec(3), 'm'); // previous release: untagged
    const [other] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Outra', question: 'Versao q10?' })]);
    await repo.setEmbedding(other!.id, vec(4), 'm#q10'); // a suffix that only starts like '#q1'
    const [fresh] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Nova', question: 'Sem embedding?' })]);

    const ids = (await repo.listToEmbed(1000, '#q1')).map((d) => d.id);
    expect(ids).toContain(stale!.id);
    expect(ids).toContain(other!.id);
    expect(ids.indexOf(fresh!.id)).toBeLessThan(ids.indexOf(stale!.id));

    await repo.setEmbedding(stale!.id, vec(3), 'm#q1');
    await repo.setEmbedding(other!.id, vec(4), 'm#q1');
    await repo.setEmbedding(fresh!.id, vec(5), 'm#q1');
    const after = (await repo.listToEmbed(1000, '#q1')).map((d) => d.id);
    expect(after).not.toContain(stale!.id);
    expect(after).not.toContain(other!.id);
    expect(after).not.toContain(fresh!.id);
  });

  it('nearest only compares vectors with exactly the same embed_model', async () => {
    const [untagged] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'SemTag', question: 'Vetor antigo?' })]);
    await repo.setEmbedding(untagged!.id, vec(7), 'm');
    const [longer] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Q10', question: 'Outra versao?' })]);
    await repo.setEmbedding(longer!.id, vec(7), 'm#q10');
    const [tagged] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'ComTag', question: 'Vetor novo?' })]);
    await repo.setEmbedding(tagged!.id, vec(7), 'm#q1');

    const ids = (await repo.nearest(userId, vec(7), { multiSelect: false, k: 50, embedModel: 'm#q1' })).map((n) => n.id);
    expect(ids).toContain(tagged!.id);
    expect(ids).not.toContain(untagged!.id);
    expect(ids).not.toContain(longer!.id);
  });

  it('bumpSuggested / bumpAccepted increment their counters', async () => {
    await repo.bumpSuggested([decisionAId]);
    await repo.bumpSuggested([decisionAId]);
    await repo.bumpAccepted([decisionAId]);

    const page = await repo.listForUser(userId, { limit: 1000 });
    expect(page.items.find((d) => d.id === decisionAId)).toMatchObject({ suggested_count: 2, accepted_count: 1 });
  });

  it('listForUser: newest first, q matches header/question/answer case-insensitively, paginates by cursor, only the user\'s rows', async () => {
    // Dated far in the future so these three rows are always the newest for userId, regardless of when
    // other tests in this file ran (their rows use the DB default `now()`).
    const t0 = Date.parse('2030-01-01T00:00:00.000Z');
    const at = (i: number) => new Date(t0 + i * 1000);
    const mk = (i: number, header: string, question: string, ownerId = userId) => ({
      id: newId(),
      userId: ownerId,
      projectId,
      conversationId,
      questionIndex: 0,
      header,
      question,
      options,
      multiSelect: false,
      answer,
      createdAt: at(i),
    });
    const rowA = mk(0, 'Idioma', 'Qual idioma?');
    const rowB = mk(1, 'Cor', 'Qual cor?');
    const rowC = mk(2, 'Tema', 'Qual tema?');
    const otherRow = mk(3, 'Cor', 'Qual cor?', otherUserId);
    await db.chatDecision.createMany({ data: [rowA, rowB, rowC, otherRow] });

    const all = await repo.listForUser(userId, { limit: 1000 });
    const ids = all.items.map((d) => d.id);
    expect(ids.indexOf(rowC.id)).toBeLessThan(ids.indexOf(rowB.id));
    expect(ids.indexOf(rowB.id)).toBeLessThan(ids.indexOf(rowA.id));
    expect(ids).not.toContain(otherRow.id); // only this user's rows

    const filtered = await repo.listForUser(userId, { q: 'COR', limit: 1000 });
    expect(filtered.items.map((d) => d.id)).toEqual([rowB.id]);

    const page1 = await repo.listForUser(userId, { limit: 1 });
    expect(page1.items.map((d) => d.id)).toEqual([rowC.id]);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await repo.listForUser(userId, { limit: 1, cursor: page1.next_cursor! });
    expect(page2.items.map((d) => d.id)).toEqual([rowB.id]);

    // A cursor that cannot be decoded is treated as "no cursor": the first page again.
    const garbage = await repo.listForUser(userId, { limit: 1, cursor: 'not-a-real-cursor' });
    expect(garbage.items.map((d) => d.id)).toEqual([rowC.id]);
  });

  it('listForUser: q searches the project name and the answer\'s label/text values, never the raw jsonb keys', async () => {
    const otherProjectId = newId();
    await db.project.create({ data: { id: otherProjectId, key: `Z${otherProjectId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'Zebrafino', ownerId: userId } });
    try {
      const base = { userId, conversationId, questionIndex: 0, header: 'Busca', question: 'Qual busca?', options, multiSelect: false };
      const inOther = { ...base, id: newId(), projectId: otherProjectId, answer: { labels: ['Azul'] } };
      const byLabel = { ...base, id: newId(), projectId, answer: { labels: ['Magentado'] } };
      const byText = { ...base, id: newId(), projectId, answer: { labels: [], text: 'resposta livrestranha' } };
      await db.chatDecision.createMany({ data: [inOther, byLabel, byText] });

      const ids = async (q: string) => (await repo.listForUser(userId, { q, limit: 1000 })).items.map((d) => d.id);
      expect(await ids('zebrafino')).toEqual([inOther.id]);
      expect(await ids('magentad')).toEqual([byLabel.id]);
      expect(await ids('LIVRESTRANHA')).toEqual([byText.id]);
      // The jsonb keys are not content: every answer holds "labels", none of them should match it.
      expect(await ids('labels')).toEqual([]);
      expect(await ids('text')).toEqual([]);
    } finally {
      await db.project.deleteMany({ where: { id: otherProjectId } });
    }
  });

  it('deleteForUser: true for the owner\'s row, false for another user\'s or a missing id', async () => {
    const [row] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Layout', question: 'Qual layout?' })]);
    expect(await repo.deleteForUser(row!.id, otherUserId)).toBe(false);
    expect(await repo.deleteForUser(row!.id, userId)).toBe(true);
    expect(await repo.deleteForUser(row!.id, userId)).toBe(false); // already gone
    expect(await repo.deleteForUser(newId(), userId)).toBe(false); // never existed
  });

  it('countForUser', async () => {
    const before = await repo.countForUser(userId);
    await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Prioridade', question: 'Qual prioridade?' })]);
    expect(await repo.countForUser(userId)).toBe(before + 1);
  });

  it('listAnsweredChoicesWithoutDecision: an answered choice without decisions, never a permission nor an open choice, gone once recorded', async () => {
    const answeredChoiceId = newId();
    const permissionId = newId();
    const openChoiceId = newId();
    // Answered a couple of minutes ago: fresh enough to be well past the "answered in the last minute"
    // guard (claim sets `status: 'answered'` before the keys are actually sent — see the next test).
    const answeredAt = new Date(Date.now() - 2 * 60 * 1000);
    await db.tabQuestion.createMany({
      data: [
        { id: answeredChoiceId, tabId: 'tqd1', projectId, conversationId, kind: 'choice', payload: choicePayload, status: 'answered', answer: { answers: [{ selected: [0] }] }, answeredBy: userId, answeredAt },
        { id: permissionId, tabId: 'tqd2', projectId, conversationId, kind: 'permission', payload: { tool_name: 'Bash' }, status: 'answered', answer: { allow: true }, answeredBy: userId, answeredAt },
        { id: openChoiceId, tabId: 'tqd3', projectId, conversationId, kind: 'choice', payload: choicePayload, status: 'open' },
      ],
    });

    const before = await repo.listAnsweredChoicesWithoutDecision(10_000);
    const beforeIds = before.map((r) => r.id);
    expect(beforeIds).toContain(answeredChoiceId);
    expect(beforeIds).not.toContain(permissionId);
    expect(beforeIds).not.toContain(openChoiceId);
    const found = before.find((r) => r.id === answeredChoiceId)!;
    expect(found).toMatchObject({ project_id: projectId, conversation_id: conversationId, answered_by: userId });

    // excludeIds: the row is skipped while listed, back once it is not.
    const excluded = await repo.listAnsweredChoicesWithoutDecision(10_000, [answeredChoiceId]);
    expect(excluded.map((r) => r.id)).not.toContain(answeredChoiceId);
    const notExcluded = await repo.listAnsweredChoicesWithoutDecision(10_000, [newId()]);
    expect(notExcluded.map((r) => r.id)).toContain(answeredChoiceId);

    await repo.insertMany([newDecision({ tab_question_id: answeredChoiceId, header: 'Cor', question: 'Qual cor?' })]);

    const after = await repo.listAnsweredChoicesWithoutDecision(10_000);
    expect(after.map((r) => r.id)).not.toContain(answeredChoiceId);
  });

  it('listAnsweredChoicesWithoutDecision: ignores a row answered in the last minute', async () => {
    const justAnsweredId = newId();
    await db.tabQuestion.create({
      data: { id: justAnsweredId, tabId: 'tqd4', projectId, conversationId, kind: 'choice', payload: choicePayload, status: 'answered', answer: { answers: [{ selected: [0] }] }, answeredBy: userId, answeredAt: new Date() },
    });

    const rows = await repo.listAnsweredChoicesWithoutDecision(10_000);
    expect(rows.map((r) => r.id)).not.toContain(justAnsweredId);
  });

  it('users.chatSuggestions defaults to true; setChatSuggestions(false) turns it off', async () => {
    expect(await users.chatSuggestions(userId)).toBe(true);
    await users.setChatSuggestions(userId, false);
    expect(await users.chatSuggestions(userId)).toBe(false);
  });

  it('users.chatAutodecide defaults to false; setChatAutodecide(true) turns it on', async () => {
    expect(await users.chatAutodecide(userId)).toBe(false);
    await users.setChatAutodecide(userId, true);
    expect(await users.chatAutodecide(userId)).toBe(true);
    await users.setChatAutodecide(userId, false);
    expect(await users.chatAutodecide(userId)).toBe(false);
  });

  it('findManyForUser: only the requested ids this user owns', async () => {
    const [mine] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Meu', question: 'Minha pergunta?' })]);
    const [theirs] = await repo.insertMany([newDecision({ user_id: otherUserId, project_id: null, conversation_id: null, tab_question_id: newId(), header: 'Deles', question: 'Pergunta deles?' })]);
    const found = await repo.findManyForUser([mine!.id, theirs!.id, newId()], userId);
    expect(found.map((d) => d.id)).toEqual([mine!.id]);
  });

  it('bumpAuto increments auto_count', async () => {
    const [row] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Auto', question: 'Pergunta auto?' })]);
    expect(row!.auto_count).toBe(0);
    await repo.bumpAuto([row!.id]);
    await repo.bumpAuto([row!.id]);
    const page = await repo.listForUser(userId, { limit: 1000 });
    expect(page.items.find((d) => d.id === row!.id)).toMatchObject({ auto_count: 2 });
  });

  it('nearestAny: best match first across both multi_select shapes, scoped to the user, only embedded rows', async () => {
    const [single] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Any1', question: 'Any pergunta 1?' })]);
    await repo.setEmbedding(single!.id, vec(1), 'm');
    const [multi] = await repo.insertMany([newDecision({ tab_question_id: newId(), multi_select: true, header: 'Any2', question: 'Any pergunta 2?' })]);
    await repo.setEmbedding(multi!.id, mix(1, 2, 0.7), 'm');
    const [unembedded] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Any3', question: 'Any pergunta 3?' })]);
    const [otherUserRow] = await repo.insertMany([
      newDecision({ user_id: otherUserId, project_id: null, conversation_id: null, tab_question_id: newId(), header: 'Any4', question: 'Any pergunta 4?' }),
    ]);
    await repo.setEmbedding(otherUserRow!.id, vec(1), 'm');

    const neighbours = await repo.nearestAny(userId, vec(1), 10);
    const ids = neighbours.map((n) => n.id);
    expect(ids.indexOf(single!.id)).toBeLessThan(ids.indexOf(multi!.id)); // both shapes present, best first
    expect(ids).not.toContain(unembedded!.id);
    expect(ids).not.toContain(otherUserRow!.id);
  });

  it('similarityTo: cosine similarity of the named rows to a vector, only this user\'s embedded rows', async () => {
    const [same] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Sim1', question: 'Sim pergunta 1?' })]);
    await repo.setEmbedding(same!.id, vec(5), 'm');
    const [near] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Sim2', question: 'Sim pergunta 2?' })]);
    await repo.setEmbedding(near!.id, mix(5, 6, 0.5), 'm');
    const [unembedded] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Sim3', question: 'Sim pergunta 3?' })]);
    const [foreign] = await repo.insertMany([
      newDecision({ user_id: otherUserId, project_id: null, conversation_id: null, tab_question_id: newId(), header: 'Sim4', question: 'Sim pergunta 4?' }),
    ]);
    await repo.setEmbedding(foreign!.id, vec(5), 'm');
    const [otherVersion] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Sim5', question: 'Sim pergunta 5?' })]);
    await repo.setEmbedding(otherVersion!.id, vec(5), 'm#old');

    const sims = await repo.similarityTo([same!.id, near!.id, unembedded!.id, foreign!.id, otherVersion!.id], userId, vec(5), 'm');
    expect(sims.get(same!.id)).toBeCloseTo(1, 5);
    expect(sims.get(near!.id)!).toBeGreaterThan(0);
    expect(sims.get(near!.id)!).toBeLessThan(1);
    expect(sims.has(unembedded!.id)).toBe(false);
    expect(sims.has(foreign!.id)).toBe(false);
    expect(sims.has(otherVersion!.id)).toBe(false); // another model / text version is never compared (TER-204)
    expect((await repo.similarityTo([], userId, vec(5), 'm')).size).toBe(0);
  });

  it('textSearch: matches the question and answer labels case-insensitively, only this user\'s rows, similarity-free ranking; punctuation-only query returns []', async () => {
    const [row] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Busca texto', question: 'Qual worktree usar isolado?', answer: { labels: ['Ultravioleta777'] } })]);
    await repo.insertMany([
      newDecision({ user_id: otherUserId, project_id: null, conversation_id: null, tab_question_id: newId(), header: 'Busca texto', question: 'Qual worktree usar isolado?', answer: { labels: ['Ultravioleta777'] } }),
    ]);

    const byQuestion = await repo.textSearch(userId, 'worktree isolado', 5);
    expect(byQuestion.map((d) => d.id)).toContain(row!.id);
    expect(byQuestion.every((d) => d.user_id === userId)).toBe(true);
    expect(byQuestion[0]!.rank).toBe(1);

    const byLabel = await repo.textSearch(userId, 'ULTRAVIOLETA777', 5);
    expect(byLabel.map((d) => d.id)).toEqual([row!.id]);

    expect(await repo.textSearch(userId, '!!!', 5)).toEqual([]);
  });
  it('textSearch and nearestAny with a projectId return only that project\'s rows (TER-212)', async () => {
    const otherProjectId = newId();
    await db.project.create({ data: { id: otherProjectId, key: `E${otherProjectId.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'proj2', ownerId: userId } });
    try {
      const [mine] = await repo.insertMany([newDecision({ tab_question_id: newId(), header: 'Escopo', question: 'Qual escopo Quasar888?' })]);
      const [elsewhere] = await repo.insertMany([newDecision({ project_id: otherProjectId, conversation_id: null, tab_question_id: newId(), header: 'Escopo', question: 'Qual escopo Quasar888?' })]);
      const [noProject] = await repo.insertMany([newDecision({ project_id: null, conversation_id: null, tab_question_id: newId(), header: 'Escopo', question: 'Qual escopo Quasar888?' })]);
      for (const row of [mine, elsewhere, noProject]) await repo.setEmbedding(row!.id, vec(9), 'm');

      expect((await repo.textSearch(userId, 'Quasar888', 10)).map((d) => d.id).sort()).toEqual([mine!.id, elsewhere!.id, noProject!.id].sort());
      expect((await repo.textSearch(userId, 'Quasar888', 10, projectId)).map((d) => d.id)).toEqual([mine!.id]);
      const near = (await repo.nearestAny(userId, vec(9), 50, projectId)).map((d) => d.id);
      expect(near).toContain(mine!.id);
      expect(near).not.toContain(elsewhere!.id);
      expect(near).not.toContain(noProject!.id);
    } finally {
      await db.chatDecision.deleteMany({ where: { projectId: otherProjectId } });
      await db.project.deleteMany({ where: { id: otherProjectId } });
    }
  });

  it('replayDataset: only one user\'s rows on both sides, earlier neighbours only, never the same card (TER-1009)', async () => {
    // A fresh user, so the rows the other tests left behind do not enter the dataset.
    const me = newId();
    await db.user.create({ data: { id: me, email: `${me}@test.local`, name: 'replay' } });
    try {
      const at = (day: number) => new Date(Date.UTC(2026, 8, day, 12));
      const add = async (over: Partial<NewDecision>, vector: number[] | null, model: string, day: number) => {
        const [row] = await repo.insertMany([newDecision({ user_id: me, conversation_id: null, tab_question_id: newId(), ...over })]);
        if (vector) await repo.setEmbedding(row!.id, vector, model);
        await db.$executeRaw`UPDATE "chat_decisions" SET "created_at" = ${at(day)} WHERE "id" = ${row!.id}`;
        return row!;
      };
      const foreign = await add({ user_id: otherUserId }, vec(20), 'm#q1', 1); // another user: never seen
      const a = await add({}, vec(20), 'm#q1', 2);
      const b = await add({}, mix(20, 21, 0.9), 'm#q1', 3);
      const multi = await add({ multi_select: true }, vec(20), 'm#q1', 4);
      const loose = await add({ project_id: null }, vec(20), 'm#q1', 5);
      const card = newId();
      const q0 = await add({ tab_question_id: card, question_index: 0 }, vec(22), 'm#q1', 6);
      const q1 = await add({ tab_question_id: card, question_index: 1 }, vec(22), 'm#q1', 7);
      await add({}, vec(20), 'm', 8); // embedded under an older text version: left out, counted
      await add({}, null, 'm#q1', 9); // not embedded yet: left out, counted

      const ds = await repo.replayDataset(me, '#q1', 5, 100);
      expect(ds.decisions.map((d) => d.id)).toEqual([a.id, b.id, multi.id, loose.id, q0.id, q1.id]);
      expect(ds.unembedded).toBe(2);
      expect(ds.older).toEqual([]);
      const ids = (pairs: typeof ds.replay, id: string) => pairs.filter((p) => p.id === id).map((p) => p.neighbour_id);
      // Replay: same shape, any project, strictly earlier, best first.
      expect(ids(ds.replay, a.id)).toEqual([]);
      expect(ids(ds.replay, b.id)).toEqual([a.id]);
      expect(ds.replay.find((p) => p.id === b.id)!.similarity).toBeCloseTo(0.9 / Math.sqrt(0.82), 5);
      expect(ids(ds.replay, multi.id)).toEqual([]);
      expect(ids(ds.replay, loose.id).sort()).toEqual([a.id, b.id].sort());
      expect(ids(ds.replay, q1.id)).not.toContain(q0.id);
      // Scope: the single nearest earlier question of the same project (or both account-wide), any shape.
      expect(ids(ds.scope, b.id)).toEqual([a.id]);
      expect(ids(ds.scope, multi.id)).toEqual([a.id]);
      expect(ids(ds.scope, loose.id)).toEqual([]);
      expect(ids(ds.scope, q1.id)).not.toContain(q0.id);
      const every = [...ds.decisions, ...ds.older].map((d) => d.id);
      expect(every).not.toContain(foreign.id);
      expect([...ds.replay, ...ds.scope].map((p) => p.neighbour_id)).not.toContain(foreign.id);

      // A window of the newest 3: their neighbours further back come in `older`.
      const window = await repo.replayDataset(me, '#q1', 5, 3);
      expect(window.decisions.map((d) => d.id)).toEqual([loose.id, q0.id, q1.id]);
      expect(window.older.map((d) => d.id)).toEqual(expect.arrayContaining([a.id, b.id]));

      // The other user's dataset never holds one of this user's rows either.
      const theirs = await repo.replayDataset(otherUserId, '#q1', 5, 100);
      expect(theirs.decisions.map((d) => d.id)).toContain(foreign.id);
      const mine = new Set(every);
      expect([...theirs.decisions, ...theirs.older].filter((d) => mine.has(d.id))).toEqual([]);
    } finally {
      await db.user.deleteMany({ where: { id: me } });
    }
  });
});
