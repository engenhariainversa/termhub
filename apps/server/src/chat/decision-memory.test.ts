import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnsweredChoiceRow, DecisionNeighbour, NewDecision } from '../db/repositories/chat-decisions.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import type { TabQuestionSuggestion } from './decision-text.js';
import { backfillDecisions, decisionsOf, embedPending, recordDecisions, startDecisionSweeper, SWEEP_INTERVAL_MS, suggestFor } from './decision-memory.js';
import { EmbedError } from './embeddings.js';
import type { ChoicePayload } from './tab-question-payload.js';

const log = () => ({ info: vi.fn(), warn: vi.fn() });
const embedder = () => ({ embed: vi.fn(async (texts: string[]) => ({ model: 'm', vectors: texts.map(() => [1, 0]) })) });

const item = { question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: false }] };
const item1 = { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: [{ label: 'Maçã', description: 'fruta', recommended: false }, { label: 'Banana', description: '', recommended: false }] };
const payload: ChoicePayload = { questions: [item] };
const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload, tool_use_id: 'toolu_1',
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', suggestion: null, ...over,
});

let seq = 0;
function neighbour(over: Partial<DecisionNeighbour> = {}): DecisionNeighbour {
  seq += 1;
  return {
    id: `d${seq}`, user_id: 'u1', project_id: 'p1', project_name: 'Proj', conversation_id: 'c1', tab_question_id: null,
    question_index: 0, header: 'Cor', question: 'Qual cor?', options: [{ label: 'Sim', description: '' }, { label: 'Não', description: '' }],
    multi_select: false, answer: { labels: ['Sim'] }, embed_model: 'm', suggested_count: 0, accepted_count: 0,
    created_at: '2026-09-20T00:00:00.000Z', similarity: 0.9, ...over,
  };
}

function fakeRepos(opts: { chatSuggestions?: boolean; nearest?: (userId: string, vector: number[], opts: { multiSelect: boolean; k: number }) => Promise<DecisionNeighbour[]> } = {}) {
  return {
    users: { chatSuggestions: vi.fn(async () => opts.chatSuggestions ?? true) },
    chatDecisions: { nearest: vi.fn(opts.nearest ?? (async () => [])), bumpSuggested: vi.fn(async () => {}) },
  };
}

describe('suggestFor', () => {
  it('pre-selects the most recent candidate above the threshold', async () => {
    const older = neighbour({ id: 'd-old', similarity: 0.95, created_at: '2026-09-10T00:00:00.000Z', answer: { labels: ['Não'] } });
    const newer = neighbour({ id: 'd-new', similarity: 0.9, created_at: '2026-09-20T00:00:00.000Z', answer: { labels: ['Sim'] } });
    const repos = fakeRepos({ nearest: async () => [older, newer] });
    const l = log();
    const result = await suggestFor(repos as never, row(), { embedder: embedder(), threshold: 0.85, log: l });
    expect(result).toEqual({
      items: [{ question_index: 0, decision_id: 'd-new', similarity: 0.9, selected: [0], source: { question: newer.question, project_name: newer.project_name, answered_at: newer.created_at } }],
    });
    expect(repos.chatDecisions.bumpSuggested).toHaveBeenCalledWith(['d-new']);
    expect(l.info).toHaveBeenCalledWith({ tabQuestionId: 'q1', items: 1, best: 0.9 }, expect.any(String));
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('Qual cor');
  });

  it('asks only for decisions that hold on this card: its project and conversation (TER-1014)', async () => {
    const repos = fakeRepos();
    const r = row();
    await suggestFor(repos as never, r, { embedder: embedder(), threshold: 0.85, log: log() });
    expect(repos.chatDecisions.nearest).toHaveBeenCalledWith('u1', expect.anything(), expect.objectContaining({ place: { projectId: r.project_id, conversationId: r.conversation_id } }));
  });

  it('ignores candidates below the threshold', async () => {
    const below = neighbour({ id: 'd-low', similarity: 0.84, answer: { labels: ['Sim'] } });
    const repos = fakeRepos({ nearest: async () => [below] });
    const result = await suggestFor(repos as never, row(), { embedder: embedder(), threshold: 0.85, log: log() });
    expect(result).toBeNull();
    expect(repos.chatDecisions.bumpSuggested).not.toHaveBeenCalled();
  });

  it('skips a candidate whose labels do not map to the current options', async () => {
    const older = neighbour({ id: 'd-old', similarity: 0.9, created_at: '2026-09-10T00:00:00.000Z', answer: { labels: ['Sim'] } });
    const newer = neighbour({ id: 'd-new', similarity: 0.95, created_at: '2026-09-20T00:00:00.000Z', answer: { labels: ['Talvez'] } });
    const repos = fakeRepos({ nearest: async () => [older, newer] });
    const result = await suggestFor(repos as never, row(), { embedder: embedder(), threshold: 0.85, log: log() });
    expect(result?.items).toEqual([{ question_index: 0, decision_id: 'd-old', similarity: 0.9, selected: [0], source: { question: older.question, project_name: older.project_name, answered_at: older.created_at } }]);
    expect(repos.chatDecisions.bumpSuggested).toHaveBeenCalledWith(['d-old']);
  });

  it('embeds every question in one call and asks nearest per question with its multi-select shape', async () => {
    const item1 = { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: [{ label: 'Maçã', description: '', recommended: false }, { label: 'Banana', description: '', recommended: false }] };
    const twoQuestions: ChoicePayload = { questions: [item, item1] };
    const match = neighbour({ id: 'd-match', similarity: 0.9, question_index: 0, answer: { labels: ['Sim'] } });
    const nearest = vi.fn(async (_userId: string, _vector: number[], opts: { multiSelect: boolean; k: number }) => (opts.multiSelect ? [] : [match]));
    const repos = { users: { chatSuggestions: vi.fn(async () => true) }, chatDecisions: { nearest, bumpSuggested: vi.fn(async () => {}) } };
    const e = embedder();
    const result = await suggestFor(repos as never, row({ payload: twoQuestions }), { embedder: e, threshold: 0.85, log: log() });
    expect(e.embed).toHaveBeenCalledTimes(1);
    expect(e.embed.mock.calls[0]![0]).toHaveLength(2);
    expect(result?.items).toEqual([{ question_index: 0, decision_id: 'd-match', similarity: 0.9, selected: [0], source: { question: match.question, project_name: match.project_name, answered_at: match.created_at } }]);
    expect(nearest).toHaveBeenCalledWith('u1', [1, 0], { multiSelect: false, k: 5, embedModel: 'm#q1', place: { projectId: 'p1', conversationId: 'c1' } });
    expect(nearest).toHaveBeenCalledWith('u1', [1, 0], { multiSelect: true, k: 5, embedModel: 'm#q1', place: { projectId: 'p1', conversationId: 'c1' } });
  });

  it('embeds the normalised question only and searches vectors of the same model and text version', async () => {
    const nearest = vi.fn(async () => []);
    const repos = { users: { chatSuggestions: vi.fn(async () => true) }, chatDecisions: { nearest, bumpSuggested: vi.fn(async () => {}) } };
    const e = embedder();
    await suggestFor(repos as never, row(), { embedder: e, threshold: 0.85, log: log() });
    expect(e.embed).toHaveBeenCalledWith(['qual cor']);
    expect(nearest).toHaveBeenCalledWith('u1', [1, 0], { multiSelect: false, k: 5, embedModel: 'm#q1', place: { projectId: 'p1', conversationId: 'c1' } });
  });

  it('gives null without calling the embedder for a non-choice row, no embedder, or suggestions off', async () => {
    const e = embedder();
    expect(await suggestFor(fakeRepos() as never, row({ kind: 'permission', payload: { tool_name: 'Bash' } as never }), { embedder: e, threshold: 0.85, log: log() })).toBeNull();
    expect(await suggestFor(fakeRepos() as never, row(), { embedder: null, threshold: 0.85, log: log() })).toBeNull();
    expect(await suggestFor(fakeRepos({ chatSuggestions: false }) as never, row(), { embedder: e, threshold: 0.85, log: log() })).toBeNull();
    expect(e.embed).not.toHaveBeenCalled();
  });

  it('gives null without calling the embedder for a payload with no questions', async () => {
    const e = embedder();
    expect(await suggestFor(fakeRepos() as never, row({ payload: { questions: [] } }), { embedder: e, threshold: 0.85, log: log() })).toBeNull();
    expect(e.embed).not.toHaveBeenCalled();
  });

  it('logs a warning and returns null when the embedder rejects', async () => {
    const repos = fakeRepos();
    const l = log();
    const failing = { embed: vi.fn(async () => { throw new EmbedError('EMBED_UNREACHABLE'); }) };
    const result = await suggestFor(repos as never, row(), { embedder: failing, threshold: 0.85, log: l });
    expect(result).toBeNull();
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', code: 'EMBED_UNREACHABLE' }, expect.any(String));
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('Qual cor');
  });

  it('resolves null within the timeout when the embedder hangs', async () => {
    const repos = fakeRepos();
    const hanging = { embed: vi.fn(() => new Promise<never>(() => {})) };
    const start = Date.now();
    const result = await suggestFor(repos as never, row(), { embedder: hanging, threshold: 0.85, timeoutMs: 20, log: log() });
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('never bumps or logs a suggestion found only after the timeout already gave up on it', async () => {
    const match = neighbour({ id: 'd-late', similarity: 0.9, answer: { labels: ['Sim'] } });
    const repos = fakeRepos({ nearest: async () => [match] });
    const slow = { embed: vi.fn(() => new Promise<{ model: string; vectors: number[][] }>((resolve) => setTimeout(() => resolve({ model: 'm', vectors: [[1, 0]] }), 40))) };
    const l = log();
    const result = await suggestFor(repos as never, row(), { embedder: slow, threshold: 0.85, timeoutMs: 20, log: l });
    expect(result).toBeNull();
    // Let the abandoned `work()` run to completion (it would otherwise find `match` and act on it).
    await new Promise((r) => setTimeout(r, 60));
    expect(repos.chatDecisions.bumpSuggested).not.toHaveBeenCalled();
    expect(l.info).not.toHaveBeenCalled();
  });

  it('gives null without calling nearest for a question whose normalised text is empty', async () => {
    const blank = { question: '?!', header: 'Cor', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: false }] };
    const selfMatch = neighbour({ id: 'd-self', similarity: 1, answer: { labels: ['Sim'] } });
    const nearest = vi.fn(async () => [selfMatch]);
    const repos = { users: { chatSuggestions: vi.fn(async () => true) }, chatDecisions: { nearest, bumpSuggested: vi.fn(async () => {}) } };
    const result = await suggestFor(repos as never, row({ payload: { questions: [blank] } }), { embedder: embedder(), threshold: 0.85, log: log() });
    expect(result).toBeNull();
    expect(nearest).not.toHaveBeenCalled();
  });

  it('skips nearest for an empty question but still suggests for a normal one on the same card', async () => {
    const blank = { question: '?', header: 'Cor', multi_select: false, options: [{ label: 'Sim', description: '', recommended: false }, { label: 'Não', description: '', recommended: false }] };
    const twoQuestions: ChoicePayload = { questions: [blank, item1] };
    const match = neighbour({ id: 'd-match', similarity: 0.9, question_index: 1, answer: { labels: ['Maçã', 'Banana'] } });
    const nearest = vi.fn(async () => [match]);
    const repos = { users: { chatSuggestions: vi.fn(async () => true) }, chatDecisions: { nearest, bumpSuggested: vi.fn(async () => {}) } };
    const result = await suggestFor(repos as never, row({ payload: twoQuestions }), { embedder: embedder(), threshold: 0.85, log: log() });
    expect(nearest).toHaveBeenCalledTimes(1);
    expect(nearest).toHaveBeenCalledWith('u1', [1, 0], { multiSelect: true, k: 5, embedModel: 'm#q1', place: { projectId: 'p1', conversationId: 'c1' } });
    expect(result?.items).toEqual([
      { question_index: 1, decision_id: 'd-match', similarity: 0.9, selected: [0, 1], source: { question: match.question, project_name: match.project_name, answered_at: match.created_at } },
    ]);
  });

  it('logs a warning and returns null when nearest rejects', async () => {
    const repos = fakeRepos({
      nearest: async () => {
        throw Object.assign(new Error('db down'), { code: 'P2024' });
      },
    });
    const l = log();
    const result = await suggestFor(repos as never, row(), { embedder: embedder(), threshold: 0.85, log: l });
    expect(result).toBeNull();
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', code: 'P2024' }, expect.any(String));
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('Qual cor');
  });
});

function fakeChatDecisions(overrides: Record<string, unknown> = {}) {
  return {
    insertMany: vi.fn(async (rows: NewDecision[]) =>
      rows.map((r, i) => ({ id: `d${i + 1}`, ...r, project_name: null, embed_model: null, suggested_count: 0, accepted_count: 0, created_at: '2026-09-26T00:00:00.000Z' })),
    ),
    bumpAccepted: vi.fn(async () => {}),
    setEmbedding: vi.fn(async () => {}),
    listToEmbed: vi.fn(async () => []),
    listAnsweredChoicesWithoutDecision: vi.fn(async () => []),
    ...overrides,
  };
}

describe('decisionsOf', () => {
  it('gives one NewDecision per question, options without recommended, user from the argument', () => {
    const twoQ: ChoicePayload = { questions: [item, item1] };
    const answered = row({ payload: twoQ, answer: { answers: [{ selected: [0] }, { selected: [1, 0] }] } as never, answered_by: 'u2' });
    const result = decisionsOf(answered, answered.answered_by ?? answered.user_id);
    expect(result).toEqual<NewDecision[]>([
      {
        user_id: 'u2', project_id: 'p1', conversation_id: 'c1', tab_question_id: 'q1', question_index: 0,
        header: 'Cor', question: 'Qual cor?', options: [{ label: 'Sim', description: '' }, { label: 'Não', description: '' }],
        multi_select: false, answer: { labels: ['Sim'] }, trust: 'person',
      },
      {
        user_id: 'u2', project_id: 'p1', conversation_id: 'c1', tab_question_id: 'q1', question_index: 1,
        header: 'Frutas', question: 'Quais frutas?', options: [{ label: 'Maçã', description: 'fruta' }, { label: 'Banana', description: '' }],
        multi_select: true, answer: { labels: ['Banana', 'Maçã'] }, trust: 'person',
      },
    ]);
  });

  it('keeps free text and gives an empty array for an unanswered row', () => {
    const answered = row({ payload: { questions: [item] }, answer: { answers: [{ selected: [], text: 'Talvez' }] } as never });
    expect(decisionsOf(answered, 'u1')[0]).toMatchObject({ answer: { labels: [], text: 'Talvez' } });
    expect(decisionsOf(row({ answer: null }), 'u1')).toEqual([]);
  });
});

describe('recordDecisions', () => {
  it('inserts via insertMany, bumps accepted_count only for suggestion items matching the answer, then embeds the inserted rows', async () => {
    const chatDecisions = fakeChatDecisions();
    const suggestion: TabQuestionSuggestion = {
      items: [
        { question_index: 0, decision_id: 'sugg-match', similarity: 0.9, selected: [0], source: { question: 'x', project_name: null, answered_at: '2026-09-01T00:00:00.000Z' } },
      ],
    };
    const answered = row({ answered_by: 'u1', answer: { answers: [{ selected: [0] }] } as never, suggestion });
    const e = embedder();
    await recordDecisions({ chatDecisions } as never, answered, { embedder: e, log: log() });
    expect(chatDecisions.insertMany).toHaveBeenCalledWith(decisionsOf(answered, 'u1'));
    expect(chatDecisions.bumpAccepted).toHaveBeenCalledWith(['sugg-match']);
    // The embed is fire-and-forget: give its microtasks a turn before checking it landed.
    await new Promise((r) => setTimeout(r, 0));
    expect(e.embed).toHaveBeenCalledWith(['qual cor']);
    expect(chatDecisions.setEmbedding).toHaveBeenCalledWith('d1', [1, 0], 'm#q1');
  });

  it('never bumps an empty decision_id (a concierge suggestion that cited no decision)', async () => {
    const chatDecisions = fakeChatDecisions();
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: '', similarity: 0, selected: [0], source: { question: 'x', project_name: null, answered_at: '2026-09-01T00:00:00.000Z' }, by: 'concierge', reason: 'r', sources: ['doc:i1'] }],
    };
    const answered = row({ answered_by: 'u1', answer: { answers: [{ selected: [0] }] } as never, suggestion });
    await recordDecisions({ chatDecisions } as never, answered, { embedder: null, log: log() });
    expect(chatDecisions.bumpAccepted).not.toHaveBeenCalled();
  });

  it('does not bump accepted for a suggestion item the answer does not match', async () => {
    const chatDecisions = fakeChatDecisions();
    const suggestion: TabQuestionSuggestion = {
      items: [{ question_index: 0, decision_id: 'sugg-miss', similarity: 0.9, selected: [1], source: { question: 'x', project_name: null, answered_at: '2026-09-01T00:00:00.000Z' } }],
    };
    const answered = row({ answered_by: 'u1', answer: { answers: [{ selected: [0] }] } as never, suggestion });
    await recordDecisions({ chatDecisions } as never, answered, { embedder: null, log: log() });
    expect(chatDecisions.bumpAccepted).not.toHaveBeenCalled();
  });

  it('still inserts with no embedder, leaving embedding for the sweeper', async () => {
    const chatDecisions = fakeChatDecisions();
    const answered = row({ answered_by: 'u1', answer: { answers: [{ selected: [0] }] } as never });
    await recordDecisions({ chatDecisions } as never, answered, { embedder: null, log: log() });
    expect(chatDecisions.insertMany).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(chatDecisions.setEmbedding).not.toHaveBeenCalled();
  });

  it('does nothing for a permission row', async () => {
    const chatDecisions = fakeChatDecisions();
    const permRow = row({ kind: 'permission', payload: { tool_name: 'Bash' } as never, answer: { allow: true } as never, answered_by: 'u1' });
    await recordDecisions({ chatDecisions } as never, permRow, { embedder: embedder(), log: log() });
    expect(chatDecisions.insertMany).not.toHaveBeenCalled();
  });

  it('warns and resolves when insertMany rejects', async () => {
    const chatDecisions = fakeChatDecisions({
      insertMany: vi.fn(async () => {
        throw Object.assign(new Error('db down'), { code: 'P2024' });
      }),
    });
    const l = log();
    const answered = row({ answered_by: 'u1', answer: { answers: [{ selected: [0] }] } as never });
    await expect(recordDecisions({ chatDecisions } as never, answered, { embedder: embedder(), log: l })).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', code: 'P2024' }, expect.any(String));
  });
});

describe('backfillDecisions', () => {
  it('turns answered choice rows without a decision into insertMany calls and returns the inserted count', async () => {
    const ansRow: AnsweredChoiceRow = { id: 'tq1', project_id: 'p1', conversation_id: 'c1', answered_by: 'u9', answered_via: 'card', payload: { questions: [item] }, answer: { answers: [{ selected: [0] }] } };
    const chatDecisions = fakeChatDecisions({ listAnsweredChoicesWithoutDecision: vi.fn(async (limit: number) => (limit > 0 ? [ansRow] : [])) });
    const result = await backfillDecisions({ chatDecisions } as never);
    expect(result).toEqual({ inserted: 1, skipped: [] });
    expect(chatDecisions.insertMany).toHaveBeenCalledWith(
      decisionsOf({ id: 'tq1', project_id: 'p1', conversation_id: 'c1', payload: ansRow.payload as never, answer: ansRow.answer as never }, 'u9'),
    );
  });

  it('records a click (or a row from before answered_via) as person, an automatic answer as derived (TER-1006)', async () => {
    const base = { project_id: 'p1', conversation_id: 'c1', answered_by: 'u9', payload: { questions: [item] }, answer: { answers: [{ selected: [0] }] } };
    const rows: AnsweredChoiceRow[] = [
      { ...base, id: 'tq1', answered_via: 'card' },
      { ...base, id: 'tq2', answered_via: null },
      { ...base, id: 'tq3', answered_via: 'auto' },
      { ...base, id: 'tq4', answered_via: 'automation' },
    ];
    const chatDecisions = fakeChatDecisions({ listAnsweredChoicesWithoutDecision: vi.fn(async () => rows) });
    const result = await backfillDecisions({ chatDecisions } as never);
    expect(result).toEqual({ inserted: 4, skipped: [] });
    const trustOf = vi.mocked(chatDecisions.insertMany).mock.calls.map(([d]) => [d[0]!.tab_question_id, d[0]!.trust]);
    expect(trustOf).toEqual([
      ['tq1', 'person'],
      ['tq2', 'person'],
      ['tq3', 'derived'],
      ['tq4', 'derived'],
    ]);
  });

  it('skips a row whose payload or answer does not parse, without aborting the rest of the batch', async () => {
    const badPayload = { id: 'tq1', project_id: 'p1', conversation_id: 'c1', answered_by: 'u9', answered_via: 'card', payload: { nope: true }, answer: { answers: [{ selected: [0] }] } };
    const badAnswer = { id: 'tq2', project_id: 'p1', conversation_id: 'c1', answered_by: 'u9', answered_via: 'card', payload: { questions: [item] }, answer: { nope: true } };
    const good: AnsweredChoiceRow = { id: 'tq3', project_id: 'p1', conversation_id: 'c1', answered_by: 'u9', answered_via: 'card', payload: { questions: [item] }, answer: { answers: [{ selected: [0] }] } };
    const chatDecisions = fakeChatDecisions({ listAnsweredChoicesWithoutDecision: vi.fn(async () => [badPayload, badAnswer, good]) });
    const result = await backfillDecisions({ chatDecisions } as never);
    expect(result).toEqual({ inserted: 1, skipped: ['tq1', 'tq2'] });
    expect(chatDecisions.insertMany).toHaveBeenCalledTimes(1);
    expect(chatDecisions.insertMany).toHaveBeenCalledWith(decisionsOf({ id: 'tq3', project_id: 'p1', conversation_id: 'c1', payload: good.payload as never, answer: good.answer as never }, 'u9'));
  });

  it('skips an answer that does not fit its own payload (an index out of range) instead of throwing', async () => {
    // `item` has 2 options: index 5 does not exist. This parses fine on its own (both `choicePayload`
    // and `choiceAnswerBody` are shape-only schemas) but `checkChoiceAnswer` catches the mismatch —
    // without that check, `answerToDecision` would throw and abort the whole batch (the bug being fixed).
    const misfit = { id: 'tq1', project_id: 'p1', conversation_id: 'c1', answered_by: 'u9', answered_via: 'card', payload: { questions: [item] }, answer: { answers: [{ selected: [5] }] } };
    const good: AnsweredChoiceRow = { id: 'tq2', project_id: 'p1', conversation_id: 'c1', answered_by: 'u9', answered_via: 'card', payload: { questions: [item] }, answer: { answers: [{ selected: [0] }] } };
    const chatDecisions = fakeChatDecisions({ listAnsweredChoicesWithoutDecision: vi.fn(async () => [misfit, good]) });
    const result = await backfillDecisions({ chatDecisions } as never);
    expect(result).toEqual({ inserted: 1, skipped: ['tq1'] });
    expect(chatDecisions.insertMany).toHaveBeenCalledTimes(1);
  });

  it('skips a row whose insert itself throws, without aborting the rest of the batch', async () => {
    const rowA: AnsweredChoiceRow = { id: 'tq1', project_id: 'p1', conversation_id: 'c1', answered_by: 'u9', answered_via: 'card', payload: { questions: [item] }, answer: { answers: [{ selected: [0] }] } };
    const rowB: AnsweredChoiceRow = { id: 'tq2', project_id: 'p1', conversation_id: 'c1', answered_by: 'u9', answered_via: 'card', payload: { questions: [item] }, answer: { answers: [{ selected: [1] }] } };
    const insertMany = vi.fn(async (rows: NewDecision[]) => {
      if (rows[0]!.tab_question_id === 'tq1') throw new Error('db down');
      return rows.map((r, i) => ({ id: `d${i + 1}`, ...r, project_name: null, embed_model: null, suggested_count: 0, accepted_count: 0, created_at: '2026-09-26T00:00:00.000Z' }));
    });
    const chatDecisions = fakeChatDecisions({ listAnsweredChoicesWithoutDecision: vi.fn(async () => [rowA, rowB]), insertMany });
    const result = await backfillDecisions({ chatDecisions } as never);
    expect(result).toEqual({ inserted: 1, skipped: ['tq1'] });
  });

  it('passes excludeIds through to listAnsweredChoicesWithoutDecision', async () => {
    const chatDecisions = fakeChatDecisions();
    await backfillDecisions({ chatDecisions } as never, 32, ['already-skipped']);
    expect(chatDecisions.listAnsweredChoicesWithoutDecision).toHaveBeenCalledWith(32, ['already-skipped']);
  });
});

describe('embedPending', () => {
  it('embeds listToEmbed rows in one call and writes each', async () => {
    const rows = [{ id: 'd1', header: 'Cor', question: 'Qual cor?', options: item.options }];
    const chatDecisions = fakeChatDecisions({ listToEmbed: vi.fn(async () => rows) });
    const e = embedder();
    const n = await embedPending({ chatDecisions } as never, e, 32);
    expect(n).toBe(1);
    expect(chatDecisions.listToEmbed).toHaveBeenCalledWith(32, '#q1');
    expect(e.embed).toHaveBeenCalledTimes(1);
    expect(e.embed).toHaveBeenCalledWith(['qual cor']);
    expect(chatDecisions.setEmbedding).toHaveBeenCalledWith('d1', [1, 0], 'm#q1');
  });

  it('returns 0 without calling the embedder when nothing is pending', async () => {
    const chatDecisions = fakeChatDecisions({ listToEmbed: vi.fn(async () => []) });
    const e = embedder();
    const n = await embedPending({ chatDecisions } as never, e);
    expect(n).toBe(0);
    expect(e.embed).not.toHaveBeenCalled();
  });
});

describe('startDecisionSweeper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once immediately and again after intervalMs; the returned stop clears the timer', async () => {
    const chatDecisions = fakeChatDecisions();
    const e = embedder();
    const stop = startDecisionSweeper({ chatDecisions } as never, log(), e, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(chatDecisions.listAnsweredChoicesWithoutDecision).toHaveBeenCalledTimes(1);
    expect(chatDecisions.listToEmbed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(chatDecisions.listAnsweredChoicesWithoutDecision).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(chatDecisions.listAnsweredChoicesWithoutDecision).toHaveBeenCalledTimes(2);
  });

  it('with no embedder it still backfills (spec §4.5: decisions are recorded even with suggestions/embedding off)', async () => {
    const chatDecisions = fakeChatDecisions();
    const stop = startDecisionSweeper({ chatDecisions } as never, log(), null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(chatDecisions.listAnsweredChoicesWithoutDecision).toHaveBeenCalledTimes(1);
    expect(chatDecisions.listToEmbed).not.toHaveBeenCalled();
    stop();
  });

  it('uses the default interval when none is given', async () => {
    const chatDecisions = fakeChatDecisions();
    const stop = startDecisionSweeper({ chatDecisions } as never, log(), null);
    await vi.advanceTimersByTimeAsync(0);
    expect(chatDecisions.listAnsweredChoicesWithoutDecision).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS - 1);
    expect(chatDecisions.listAnsweredChoicesWithoutDecision).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(chatDecisions.listAnsweredChoicesWithoutDecision).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps skipped ids across ticks, passed as excludeIds on the next run', async () => {
    const badRow = { id: 'bad1', project_id: 'p1', conversation_id: 'c1', answered_by: 'u1', payload: { nope: true }, answer: {} };
    const listFn = vi.fn(async () => [badRow]);
    const chatDecisions = fakeChatDecisions({ listAnsweredChoicesWithoutDecision: listFn });
    const stop = startDecisionSweeper({ chatDecisions } as never, log(), null, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(listFn).toHaveBeenNthCalledWith(1, 32, []);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listFn).toHaveBeenNthCalledWith(2, 32, ['bad1']);
    stop();
  });

  it('never runs two ticks at once: a slow tick blocks the next scheduled one', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const listFn = vi.fn(async () => {
      await gate;
      return [];
    });
    const chatDecisions = fakeChatDecisions({ listAnsweredChoicesWithoutDecision: listFn });
    const stop = startDecisionSweeper({ chatDecisions } as never, log(), null, 1000);
    await vi.advanceTimersByTimeAsync(0); // starts tick 1, now awaiting `gate`
    expect(listFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); // the interval fires while tick 1 is still in flight
    expect(listFn).toHaveBeenCalledTimes(1); // skipped: `running` was still true
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0); // let tick 1 finish
    await vi.advanceTimersByTimeAsync(1000); // now a fresh tick can run
    expect(listFn).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a backfill rejection still lets the embed step run, and logs only a code', async () => {
    const chatDecisions = fakeChatDecisions({
      listAnsweredChoicesWithoutDecision: vi.fn(async () => {
        throw Object.assign(new Error('db down, quoting Qual cor?'), { code: 'P2024' });
      }),
    });
    const e = embedder();
    const l = log();
    const stop = startDecisionSweeper({ chatDecisions } as never, l, e, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(chatDecisions.listToEmbed).toHaveBeenCalledTimes(1);
    expect(l.warn).toHaveBeenCalledWith({ code: 'P2024' }, expect.any(String));
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('Qual cor');
    stop();
  });
});
