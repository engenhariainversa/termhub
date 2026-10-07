import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDecision } from '../db/repositories/chat-decisions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutoAnswer, TabQuestion } from '../db/repositories/tab-questions.js';
import type { ChoicePayload } from './tab-question-payload.js';
import type { SuggestionItem } from './decision-text.js';
import type { ControlContext } from '../control/context.js';

vi.mock('./tab-questions.js', () => ({ publishTabQuestions: vi.fn(async () => []) }));
const { publishTabQuestions } = await import('./tab-questions.js');
const { cancelAutoAnswer, maybeScheduleRepeat, precedentBacks, recoverLostAutoAnswers, scheduleAutoAnswer, sendDueAutoAnswers, startAutoAnswerSweeper } = await import('./auto-answer.js');
const { HttpError } = await import('../lib/errors.js');

const yesNo = (question: string, header = 'Isolamento'): ChoicePayload['questions'][number] => ({
  question,
  header,
  multi_select: false,
  options: [
    { label: 'Sim', description: '', recommended: false },
    { label: 'Não', description: '', recommended: false },
  ],
});

const decision = (over: Partial<ChatDecision> & { id: string }): ChatDecision => ({
  user_id: 'u1',
  project_id: 'p1',
  project_name: 'termhub',
  conversation_id: null,
  tab_question_id: null,
  question_index: 0,
  header: 'Isolamento',
  question: 'Usar git worktree?',
  options: [{ label: 'Sim', description: '' }, { label: 'Não', description: '' }],
  multi_select: false,
  answer: { labels: ['Sim'] },
  embed_model: 'm',
  suggested_count: 0,
  accepted_count: 0,
  auto_count: 0,
  trust: 'person',
  created_at: '2026-09-24T10:00:00.000Z',
  ...over,
});

const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1',
  tab_id: 't1',
  project_id: 'p1',
  conversation_id: 'c1',
  user_id: 'u1',
  kind: 'choice',
  payload: { questions: [yesNo('Usar git worktree?')] },
  tool_use_id: null,
  status: 'open',
  answer: null,
  error_code: null,
  answered_by: null,
  answered_at: null,
  closed_at: null,
  injected_at: null,
  created_at: '2026-09-26T00:00:00.000Z',
  suggestion: null,
  auto_answer: null,
  answered_via: null,
  woken_at: null,
  ...over,
});

describe('precedentBacks', () => {
  const payload: ChoicePayload = { questions: [yesNo('Usar git worktree?')] };

  it('backs an answer equal to what a cited decision maps to', () => {
    expect(precedentBacks([decision({ id: 'd1' })], payload, { answers: [{ selected: [0] }] })).toBe(true);
  });

  it('matches labels across case and accents (labelKey)', () => {
    const d = decision({ id: 'd1', answer: { labels: ['NAO'] } });
    expect(precedentBacks([d], payload, { answers: [{ selected: [1] }] })).toBe(true);
  });

  it('does not back the opposite answer', () => {
    const d = decision({ id: 'd1', answer: { labels: ['Não'] } });
    expect(precedentBacks([d], payload, { answers: [{ selected: [0] }] })).toBe(false);
  });

  it('compares a free-text answer with sameAnswer (trimmed, exact)', () => {
    const d = decision({ id: 'd1', answer: { labels: [], text: 'usar a branch main ' } });
    expect(precedentBacks([d], payload, { answers: [{ selected: [], text: 'usar a branch main' }] })).toBe(true);
    expect(precedentBacks([d], payload, { answers: [{ selected: [], text: 'usar outra branch' }] })).toBe(false);
  });

  it('needs a backing decision for every question of the card', () => {
    const two: ChoicePayload = { questions: [yesNo('Usar git worktree?'), yesNo('Rodar os testes?', 'Testes')] };
    const d = decision({ id: 'd1' });
    expect(precedentBacks([d], two, { answers: [{ selected: [0] }, { selected: [1] }] })).toBe(false);
    expect(precedentBacks([d], two, { answers: [{ selected: [0] }, { selected: [0] }] })).toBe(true);
  });

  it('no decisions backs nothing', () => {
    expect(precedentBacks([], payload, { answers: [{ selected: [0] }] })).toBe(false);
  });
});

describe('scheduleAutoAnswer', () => {
  beforeEach(() => vi.mocked(publishTabQuestions).mockClear());

  it('stores a scheduled countdown due 60 s from now and republishes the card', async () => {
    const now = new Date('2026-09-26T12:00:00.000Z');
    const setAutoAnswer = vi.fn(async (_id: string, auto: AutoAnswer) => row({ auto_answer: auto }));
    const repos = { tabQuestions: { setAutoAnswer } } as unknown as Repositories;
    const answer = { answers: [{ selected: [0] }] };
    const r = await scheduleAutoAnswer(repos, { row: row(), answer, by: 'concierge', reason: 'motivo', sources: [{ kind: 'decision', id: 'd1' }] }, now);
    expect(setAutoAnswer).toHaveBeenCalledWith('q1', {
      answer,
      by: 'concierge',
      reason: 'motivo',
      sources: [{ kind: 'decision', id: 'd1' }],
      due_at: '2026-09-26T12:01:00.000Z',
      status: 'scheduled',
    });
    expect(r?.auto_answer?.status).toBe('scheduled');
    expect(publishTabQuestions).toHaveBeenCalledWith(repos, 'tab_question', [r], { update: true });
  });

  it('a row that moved on (closed, or already counting down) schedules nothing and publishes nothing', async () => {
    const repos = { tabQuestions: { setAutoAnswer: vi.fn(async () => undefined) } } as unknown as Repositories;
    const r = await scheduleAutoAnswer(repos, { row: row(), answer: { answers: [{ selected: [0] }] }, by: 'memory', reason: 'r', sources: [] });
    expect(r).toBeNull();
    expect(publishTabQuestions).not.toHaveBeenCalled();
  });
});

const item = (over: Partial<SuggestionItem> = {}): SuggestionItem => ({
  question_index: 0,
  decision_id: 'd1',
  similarity: 0.99,
  selected: [0],
  source: { question: 'Usar git worktree?', project_name: 'termhub', answered_at: '2026-09-24T10:00:00.000Z' },
  ...over,
});

describe('maybeScheduleRepeat', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  const reposFor = (switchOn = true, decisions: ChatDecision[] = [decision({ id: 'd1' }), decision({ id: 'd2', answer: { labels: ['Não'] } })]) => {
    const setAutoAnswer = vi.fn(async (_id: string, auto: AutoAnswer) => row({ auto_answer: auto }));
    const chatAutodecide = vi.fn(async () => switchOn);
    const findManyForUser = vi.fn(async (ids: string[], userId: string) => decisions.filter((d) => ids.includes(d.id) && d.user_id === userId));
    return { repos: { tabQuestions: { setAutoAnswer }, users: { chatAutodecide }, chatDecisions: { findManyForUser } } as unknown as Repositories, setAutoAnswer, chatAutodecide, findManyForUser };
  };
  beforeEach(() => vi.mocked(publishTabQuestions).mockClear());

  it('switch on + every question suggested from a decision: schedules by memory, without publishing', async () => {
    const { repos, setAutoAnswer, chatAutodecide } = reposFor();
    const r = await maybeScheduleRepeat(repos, row({ suggestion: { items: [item()] } }), now);
    expect(chatAutodecide).toHaveBeenCalledWith('u1');
    expect(setAutoAnswer).toHaveBeenCalledWith('q1', {
      answer: { answers: [{ selected: [0] }] },
      by: 'memory',
      reason: 'Mesma pergunta respondida antes',
      sources: [{ kind: 'decision', id: 'd1' }],
      due_at: '2026-09-26T12:01:00.000Z',
      status: 'scheduled',
    });
    expect(r?.auto_answer?.status).toBe('scheduled');
    // `openTabQuestion` publishes the card once, carrying the countdown.
    expect(publishTabQuestions).not.toHaveBeenCalled();
  });

  it('a suggested decision the countdown made (trust derived) is no precedent: null (TER-1006)', async () => {
    const { repos, setAutoAnswer } = reposFor(true, [decision({ id: 'd1', trust: 'derived' })]);
    expect(await maybeScheduleRepeat(repos, row({ suggestion: { items: [item()] } }), now)).toBeNull();
    expect(setAutoAnswer).not.toHaveBeenCalled();
  });

  it('carries a free-text past answer as text', async () => {
    const { repos, setAutoAnswer } = reposFor(true, [decision({ id: 'd1', answer: { labels: [], text: 'usar a main' } })]);
    await maybeScheduleRepeat(repos, row({ suggestion: { items: [item({ selected: [], text: 'usar a main' })] } }), now);
    expect(setAutoAnswer.mock.calls[0]![1].answer).toEqual({ answers: [{ selected: [], text: 'usar a main' }] });
  });

  it('switch off → null, nothing stored', async () => {
    const { repos, setAutoAnswer } = reposFor(false);
    expect(await maybeScheduleRepeat(repos, row({ suggestion: { items: [item()] } }), now)).toBeNull();
    expect(setAutoAnswer).not.toHaveBeenCalled();
  });

  it('a concierge-only suggestion item (no decision_id) → null', async () => {
    const { repos, setAutoAnswer } = reposFor();
    expect(await maybeScheduleRepeat(repos, row({ suggestion: { items: [item({ decision_id: '', by: 'concierge', reason: 'r', similarity: 0 })] } }), now)).toBeNull();
    expect(setAutoAnswer).not.toHaveBeenCalled();
  });

  it('a blocked question (header, question or suggested label) → null', async () => {
    for (const payload of [
      { questions: [yesNo('Fazer deploy agora?')] },
      { questions: [yesNo('Seguir?', 'Produção')] },
      { questions: [{ ...yesNo('Seguir?'), options: [{ label: 'Push', description: '', recommended: false }, { label: 'Não', description: '', recommended: false }] }] },
    ]) {
      const { repos, setAutoAnswer } = reposFor();
      expect(await maybeScheduleRepeat(repos, row({ payload, suggestion: { items: [item()] } }), now)).toBeNull();
      expect(setAutoAnswer).not.toHaveBeenCalled();
    }
  });

  it('a blocked free-text answer → null', async () => {
    const { repos } = reposFor();
    expect(await maybeScheduleRepeat(repos, row({ suggestion: { items: [item({ selected: [], text: 'faça o merge' })] } }), now)).toBeNull();
  });

  it('an item below the 0.98 hard floor → null, whatever the suggestion threshold', async () => {
    const { repos, setAutoAnswer } = reposFor();
    expect(await maybeScheduleRepeat(repos, row({ suggestion: { items: [item({ similarity: 0.97 })] } }), now)).toBeNull();
    expect(setAutoAnswer).not.toHaveBeenCalled();
    expect(await maybeScheduleRepeat(repos, row({ suggestion: { items: [item({ similarity: 0.98 })] } }), now)).not.toBeNull();
  });

  it('two questions, only one suggested → null', async () => {
    const { repos, setAutoAnswer } = reposFor();
    const payload = { questions: [yesNo('Usar git worktree?'), yesNo('Rodar os testes?', 'Testes')] };
    expect(await maybeScheduleRepeat(repos, row({ payload, suggestion: { items: [item()] } }), now)).toBeNull();
    expect(setAutoAnswer).not.toHaveBeenCalled();
  });

  it('two questions, both suggested: one countdown citing both decisions', async () => {
    const { repos, setAutoAnswer } = reposFor();
    const payload = { questions: [yesNo('Usar git worktree?'), yesNo('Rodar os testes?', 'Testes')] };
    await maybeScheduleRepeat(repos, row({ payload, suggestion: { items: [item(), item({ question_index: 1, decision_id: 'd2', selected: [1] })] } }), now);
    expect(setAutoAnswer.mock.calls[0]![1]).toMatchObject({ answer: { answers: [{ selected: [0] }, { selected: [1] }] }, sources: [{ kind: 'decision', id: 'd1' }, { kind: 'decision', id: 'd2' }] });
  });

  const described = (desc1: string): ChoicePayload['questions'][number] => ({
    question: 'Como seguir?',
    header: 'Próximo passo',
    multi_select: false,
    options: [
      { label: 'Opção 1', description: desc1, recommended: false },
      { label: 'Opção 2', description: 'deixar como está', recommended: false },
    ],
  });
  const describedDecision = (desc1: string) =>
    decision({ id: 'd1', header: 'Próximo passo', question: 'Como seguir?', answer: { labels: ['Opção 1'] }, options: [{ label: 'Opção 1', description: desc1 }, { label: 'Opção 2', description: 'deixar como está' }] });

  it('a blocked description of the suggested option → null', async () => {
    const { repos, setAutoAnswer } = reposFor(true, [describedDecision('faz merge e push para main')]);
    expect(await maybeScheduleRepeat(repos, row({ payload: { questions: [described('faz merge e push para main')] }, suggestion: { items: [item()] } }), now)).toBeNull();
    expect(setAutoAnswer).not.toHaveBeenCalled();
  });

  it('the cited decision\'s option meant something else (another description) → null; the same one schedules', async () => {
    const other = reposFor(true, [describedDecision('abrir uma issue')]);
    expect(await maybeScheduleRepeat(other.repos, row({ payload: { questions: [described('rodar os testes de novo')] }, suggestion: { items: [item()] } }), now)).toBeNull();
    expect(other.findManyForUser).toHaveBeenCalledWith(['d1'], 'u1');
    expect(other.setAutoAnswer).not.toHaveBeenCalled();
    const same = reposFor(true, [describedDecision('Rodar os testes de novo.')]);
    expect(await maybeScheduleRepeat(same.repos, row({ payload: { questions: [described('rodar os testes de novo')] }, suggestion: { items: [item()] } }), now)).not.toBeNull();
  });

  it('a cited decision forgotten since the suggestion (or another user\'s) → null', async () => {
    const { repos, setAutoAnswer } = reposFor(true, []);
    expect(await maybeScheduleRepeat(repos, row({ suggestion: { items: [item()] } }), now)).toBeNull();
    expect(setAutoAnswer).not.toHaveBeenCalled();
  });

  it('no suggestion, a permission row, or a card that already had a countdown → null', async () => {
    const { repos, chatAutodecide } = reposFor();
    expect(await maybeScheduleRepeat(repos, row(), now)).toBeNull();
    expect(await maybeScheduleRepeat(repos, row({ kind: 'permission', payload: { tool_name: 'Bash' }, suggestion: { items: [item()] } }), now)).toBeNull();
    const cancelled: AutoAnswer = { answer: { answers: [{ selected: [0] }] }, by: 'memory', reason: 'r', sources: [], due_at: '', status: 'cancelled' };
    expect(await maybeScheduleRepeat(repos, row({ auto_answer: cancelled, suggestion: { items: [item()] } }), now)).toBeNull();
    expect(chatAutodecide).not.toHaveBeenCalled();
  });
});

const scheduled = (over: Partial<AutoAnswer> = {}): AutoAnswer => ({
  answer: { answers: [{ selected: [0] }] },
  by: 'memory',
  reason: 'Mesma pergunta respondida antes',
  sources: [{ kind: 'decision', id: 'd1' }, { kind: 'doc', id: 'm9' }],
  due_at: '2026-09-26T12:01:00.000Z',
  status: 'scheduled',
  ...over,
});

describe('sendDueAutoAnswers', () => {
  const now = () => new Date('2026-09-26T12:01:05.000Z');
  const user = { id: 'u1', email: 'a@x', name: 'Ana', nickname: 'ana', role_id: 'r1', password_hash: 'h' };
  const log = () => ({ info: vi.fn(), warn: vi.fn() });
  function fake(opts: { claimOnce?: boolean; user?: typeof user | undefined; autodecide?: boolean; decisions?: string[]; auto?: Partial<AutoAnswer> } = {}) {
    const due = row({ auto_answer: scheduled(opts.auto) });
    let claimed = false;
    const tabQuestions = {
      listDueAutoAnswers: vi.fn(async () => [due]),
      claimAutoAnswer: vi.fn(async () => {
        if (opts.claimOnce && claimed) return undefined;
        claimed = true;
        return { ...due, auto_answer: { ...due.auto_answer!, status: 'sent' as const } };
      }),
      finishAutoAnswer: vi.fn(async (_id: string, status: 'failed', code: string) => ({ ...due, auto_answer: { ...due.auto_answer!, status, error_code: code } })),
    };
    const repos = {
      tabQuestions,
      users: { findById: vi.fn(async (id: string) => ('user' in opts ? opts.user : id === 'u1' ? user : undefined)), chatAutodecide: vi.fn(async () => opts.autodecide ?? true) },
      chatDecisions: {
        bumpAuto: vi.fn(async () => {}),
        findManyForUser: vi.fn(async (ids: string[], userId: string) => (userId === 'u1' ? ids.filter((id) => (opts.decisions ?? ['d1', 'd2']).includes(id)).map((id) => decision({ id })) : [])),
      },
      roles: { findById: vi.fn(async () => ({ id: 'r1', name: 'x', is_admin: false })), permissionsOf: vi.fn(async () => []) },
    };
    return { repos, due, tabQuestions };
  }
  beforeEach(() => vi.mocked(publishTabQuestions).mockClear());

  it('claims, sends through the answer path as the row\'s user (via auto, no embedder), then bumps the decisions', async () => {
    const { repos, tabQuestions } = fake();
    const answer = vi.fn(async () => ({}) as never);
    const l = log();
    expect(await sendDueAutoAnswers(repos as unknown as Repositories, l, { now, answer })).toBe(1);
    expect(tabQuestions.listDueAutoAnswers).toHaveBeenCalledWith(now(), 20);
    expect(tabQuestions.claimAutoAnswer).toHaveBeenCalledWith('q1', now());
    expect(answer).toHaveBeenCalledTimes(1);
    const [ctx, id, body, deps] = answer.mock.calls[0]! as unknown as [ControlContext, string, unknown, { via: string; embedder: unknown; log: unknown }];
    expect(ctx.scope.user.id).toBe('u1');
    expect(ctx.token).toBeUndefined();
    expect(id).toBe('q1');
    expect(body).toEqual({ answers: [{ selected: [0] }] });
    expect(deps).toMatchObject({ via: 'auto', embedder: null, log: l });
    expect(tabQuestions.claimAutoAnswer.mock.invocationCallOrder[0]!).toBeLessThan(answer.mock.invocationCallOrder[0]!);
    // Only the decisions: a memory item has no auto counter.
    expect(repos.chatDecisions.bumpAuto).toHaveBeenCalledWith(['d1']);
    expect(tabQuestions.finishAutoAnswer).not.toHaveBeenCalled();
    expect(l.info).toHaveBeenCalledWith({ tabQuestionId: 'q1', by: 'memory' }, 'auto answer sent');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('Mesma pergunta');
  });

  it('a 409 at send time marks the countdown failed, republishes the card and sends nothing else', async () => {
    const { repos, tabQuestions } = fake();
    const answer = vi.fn(async () => {
      throw new HttpError(409, 'A pergunta mudou na aba', 'TAB_PROMPT_CHANGED');
    });
    const l = log();
    expect(await sendDueAutoAnswers(repos as unknown as Repositories, l, { now, answer })).toBe(0);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'TAB_PROMPT_CHANGED');
    expect(publishTabQuestions).toHaveBeenCalledWith(repos, 'tab_question', [expect.objectContaining({ id: 'q1', auto_answer: expect.objectContaining({ status: 'failed', error_code: 'TAB_PROMPT_CHANGED' }) })], { update: true });
    expect(repos.chatDecisions.bumpAuto).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', code: 'TAB_PROMPT_CHANGED' }, 'auto answer failed');
  });

  it('a 502 → failed with its code', async () => {
    const { repos, tabQuestions } = fake();
    const answer = vi.fn(async () => {
      throw new HttpError(502, 'Não foi possível responder na aba', 'AGENT_OFFLINE');
    });
    await sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer });
    expect(tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'AGENT_OFFLINE');
  });

  it('a user who lost terminals:write → failed FORBIDDEN (grants re-read at send time, nothing typed)', async () => {
    const { repos, tabQuestions } = fake({ user: { ...user, role_id: null as unknown as string } });
    expect(await sendDueAutoAnswers(repos as unknown as Repositories, log(), { now })).toBe(0);
    expect(tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'FORBIDDEN');
    expect(repos.chatDecisions.bumpAuto).not.toHaveBeenCalled();
  });

  it('a user that no longer exists → failed USER_GONE', async () => {
    const { repos, tabQuestions } = fake({ user: undefined });
    const answer = vi.fn();
    await sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer });
    expect(answer).not.toHaveBeenCalled();
    expect(tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'USER_GONE');
  });

  it('a claim lost (another color, another tick) sends nothing', async () => {
    const { repos, tabQuestions } = fake();
    tabQuestions.claimAutoAnswer.mockResolvedValue(undefined as never);
    const answer = vi.fn();
    expect(await sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer })).toBe(0);
    expect(answer).not.toHaveBeenCalled();
  });

  it('shouldStop is checked before each claim', async () => {
    const { repos, tabQuestions } = fake();
    tabQuestions.listDueAutoAnswers.mockResolvedValue([row({ id: 'q1', auto_answer: scheduled() }), row({ id: 'q2', auto_answer: scheduled() })] as never);
    let calls = 0;
    const shouldStop = () => calls++ >= 1;
    await sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer: vi.fn(async () => ({}) as never), shouldStop });
    expect(tabQuestions.claimAutoAnswer).toHaveBeenCalledTimes(1);
  });

  it('two sweepers, one send', async () => {
    const { repos } = fake({ claimOnce: true });
    const answer = vi.fn(async () => ({}) as never);
    const [a, b] = await Promise.all([sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer }), sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer })]);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(a + b).toBe(1);
  });

  it('the switch turned off mid-countdown → failed AUTODECIDE_OFF, nothing typed (D8)', async () => {
    const { repos, tabQuestions } = fake({ autodecide: false });
    const answer = vi.fn();
    expect(await sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer })).toBe(0);
    expect(repos.users.chatAutodecide).toHaveBeenCalledWith('u1');
    expect(answer).not.toHaveBeenCalled();
    expect(tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'AUTODECIDE_OFF');
    expect(publishTabQuestions).toHaveBeenCalledTimes(1);
  });

  it('a cited decision forgotten mid-countdown → failed PRECEDENT_FORGOTTEN, nothing typed', async () => {
    const { repos, tabQuestions } = fake({ decisions: [] });
    const answer = vi.fn();
    expect(await sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer })).toBe(0);
    expect(repos.chatDecisions.findManyForUser).toHaveBeenCalledWith(['d1'], 'u1');
    expect(answer).not.toHaveBeenCalled();
    expect(tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'PRECEDENT_FORGOTTEN');
  });

  it('a cited decision downgraded to derived meanwhile is no precedent: PRECEDENT_FORGOTTEN (TER-1006)', async () => {
    const { repos, tabQuestions } = fake();
    repos.chatDecisions.findManyForUser.mockImplementation(async (ids: string[]) => ids.map((id) => decision({ id, trust: 'derived' })));
    const answer = vi.fn();
    expect(await sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer })).toBe(0);
    expect(answer).not.toHaveBeenCalled();
    expect(tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'PRECEDENT_FORGOTTEN');
  });

  it("the same check applies to a concierge countdown's decision sources; its memory items are not decisions", async () => {
    const auto = { by: 'concierge' as const, sources: [{ kind: 'decision' as const, id: 'd1' }, { kind: 'decision' as const, id: 'd2' }, { kind: 'doc' as const, id: 'm1' }] };
    const gone = fake({ auto, decisions: ['d1'] });
    const answer = vi.fn(async () => ({}) as never);
    await sendDueAutoAnswers(gone.repos as unknown as Repositories, log(), { now, answer });
    expect(gone.repos.chatDecisions.findManyForUser).toHaveBeenCalledWith(['d1', 'd2'], 'u1');
    expect(answer).not.toHaveBeenCalled();
    expect(gone.tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'PRECEDENT_FORGOTTEN');
    const kept = fake({ auto, decisions: ['d1', 'd2'] });
    expect(await sendDueAutoAnswers(kept.repos as unknown as Repositories, log(), { now, answer })).toBe(1);
  });

  it('a failed bump after a successful send does not turn the send into a failure', async () => {
    const { repos, tabQuestions } = fake();
    repos.chatDecisions.bumpAuto.mockRejectedValue(new Error('db'));
    expect(await sendDueAutoAnswers(repos as unknown as Repositories, log(), { now, answer: vi.fn(async () => ({}) as never) })).toBe(1);
    expect(tabQuestions.finishAutoAnswer).not.toHaveBeenCalled();
  });
});

/** The automation side of a card's tab (agentic board D18, F-17): an active run, its project on, not paused. */
const automation = (o: { run?: boolean; enabled?: boolean; paused?: boolean } = {}) => ({
  automationRuns: { activeByTab: vi.fn(async (tabId: string) => ((o.run ?? true) && tabId === 't1' ? { id: 'run1', project_id: 'p1', tab_id: 't1', status: 'running' } : null)) },
  projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
  projectSetup: { get: vi.fn(async () => ({ data: { automation: { enabled: o.enabled ?? true } } })) },
  automationPauses: { state: vi.fn(async () => ({ user: o.paused ? new Date() : null, project: null })) },
});

describe('automatic tabs bypass "Responder sozinho" (agentic board D18, preflight F-17)', () => {
  const now = () => new Date('2026-09-26T12:01:05.000Z');
  const user = { id: 'u1', email: 'a@x', name: 'Ana', nickname: 'ana', role_id: 'r1', password_hash: 'h' };
  const log = () => ({ info: vi.fn(), warn: vi.fn() });
  beforeEach(() => vi.mocked(publishTabQuestions).mockClear());

  const repeatRepos = (o: Parameters<typeof automation>[0]) => {
    const setAutoAnswer = vi.fn(async (_id: string, auto: AutoAnswer) => row({ auto_answer: auto }));
    const repos = {
      tabQuestions: { setAutoAnswer },
      users: { chatAutodecide: vi.fn(async () => false) },
      chatDecisions: { findManyForUser: vi.fn(async () => [decision({ id: 'd1' })]) },
      ...automation(o),
    } as unknown as Repositories;
    return { repos, setAutoAnswer };
  };

  it('the repeat path schedules with the switch off when the tab has a live automatic run', async () => {
    const { repos, setAutoAnswer } = repeatRepos({});
    const r = await maybeScheduleRepeat(repos, row({ suggestion: { items: [item()] } }), now());
    expect(r?.auto_answer).toMatchObject({ by: 'memory', status: 'scheduled' });
    expect(setAutoAnswer).toHaveBeenCalledTimes(1);
  });

  it('…but not when that project is paused, turned off, or the tab has no run (a manual tab: as before)', async () => {
    for (const o of [{ paused: true }, { enabled: false }, { run: false }]) {
      const { repos, setAutoAnswer } = repeatRepos(o);
      expect(await maybeScheduleRepeat(repos, row({ suggestion: { items: [item()] } }), now())).toBeNull();
      expect(setAutoAnswer).not.toHaveBeenCalled();
    }
  });

  function sendRepos(auto: Partial<AutoAnswer>, o: Parameters<typeof automation>[0] & { autodecide?: boolean }) {
    const due = row({ auto_answer: { answer: { answers: [{ selected: [0] }] }, by: 'automation', reason: 'Opção recomendada pelo agente', sources: [], due_at: '2026-09-26T12:01:00.000Z', status: 'scheduled', ...auto } });
    const tabQuestions = {
      listDueAutoAnswers: vi.fn(async () => [due]),
      claimAutoAnswer: vi.fn(async () => ({ ...due, auto_answer: { ...due.auto_answer!, status: 'sent' as const } })),
      finishAutoAnswer: vi.fn(async (_id: string, status: 'failed', code: string) => ({ ...due, auto_answer: { ...due.auto_answer!, status, error_code: code } })),
    };
    const repos = {
      tabQuestions,
      users: { findById: vi.fn(async () => user), chatAutodecide: vi.fn(async () => o.autodecide ?? false) },
      chatDecisions: { bumpAuto: vi.fn(async () => {}), findManyForUser: vi.fn(async (ids: string[]) => ids.map((id) => decision({ id }))) },
      ...automation(o),
    } as unknown as Repositories;
    return { repos, tabQuestions };
  }

  it('a recommended countdown (`by: automation`) is sent with the switch off while the run is live', async () => {
    const { repos, tabQuestions } = sendRepos({}, {});
    const answer = vi.fn(async () => ({}) as never);
    expect(await sendDueAutoAnswers(repos, log(), { now, answer })).toBe(1);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(tabQuestions.finishAutoAnswer).not.toHaveBeenCalled();
  });

  it('paused (or turned off, or the run gone) at send time → failed AUTOMATION_OFF, nothing typed — even with the switch on (D24)', async () => {
    for (const o of [{ paused: true, autodecide: true }, { enabled: false, autodecide: true }, { run: false, autodecide: true }]) {
      const { repos, tabQuestions } = sendRepos({}, o);
      const answer = vi.fn();
      expect(await sendDueAutoAnswers(repos, log(), { now, answer })).toBe(0);
      expect(answer).not.toHaveBeenCalled();
      expect(tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'AUTOMATION_OFF');
    }
  });

  it('a memory or concierge countdown in a live automatic tab is sent with the switch off; in a paused one it is AUTODECIDE_OFF as before', async () => {
    const live = sendRepos({ by: 'memory', sources: [{ kind: 'decision', id: 'd1' }] }, {});
    expect(await sendDueAutoAnswers(live.repos, log(), { now, answer: vi.fn(async () => ({}) as never) })).toBe(1);
    const paused = sendRepos({ by: 'concierge', sources: [{ kind: 'decision', id: 'd1' }] }, { paused: true });
    expect(await sendDueAutoAnswers(paused.repos, log(), { now, answer: vi.fn() })).toBe(0);
    expect(paused.tabQuestions.finishAutoAnswer).toHaveBeenCalledWith('q1', 'failed', 'AUTODECIDE_OFF');
  });
});

describe('recoverLostAutoAnswers', () => {
  beforeEach(() => vi.mocked(publishTabQuestions).mockClear());

  it('fails, as SENDER_LOST, countdowns claimed over 2 minutes ago on still-open cards, and republishes them', async () => {
    const lost = row({ auto_answer: scheduled({ status: 'failed', error_code: 'SENDER_LOST' }) });
    const failLostAutoAnswers = vi.fn(async () => [lost]);
    const repos = { tabQuestions: { failLostAutoAnswers } } as unknown as Repositories;
    const l = { info: vi.fn(), warn: vi.fn() };
    expect(await recoverLostAutoAnswers(repos, l)).toBe(1);
    // The age is measured on the database's clock, the same one that stamped the claim.
    expect(failLostAutoAnswers).toHaveBeenCalledWith('SENDER_LOST', 120_000);
    expect(publishTabQuestions).toHaveBeenCalledWith(repos, 'tab_question', [lost], { update: true });
    expect(l.warn).toHaveBeenCalledWith({ tabQuestionId: 'q1', code: 'SENDER_LOST' }, 'auto answer sender lost');
  });
});

describe('startAutoAnswerSweeper', () => {
  it('each tick recovers lost countdowns, then sends the due ones', async () => {
    const failLostAutoAnswers = vi.fn(async () => []);
    const listDueAutoAnswers = vi.fn(async () => []);
    const repos = { tabQuestions: { failLostAutoAnswers, listDueAutoAnswers } } as unknown as Repositories;
    const stop = startAutoAnswerSweeper(repos, { info: vi.fn(), warn: vi.fn() }, 60_000);
    await vi.waitFor(() => expect(listDueAutoAnswers).toHaveBeenCalled());
    expect(failLostAutoAnswers.mock.invocationCallOrder[0]!).toBeLessThan(listDueAutoAnswers.mock.invocationCallOrder[0]!);
    await stop();
  });

  it('stop waits for the tick in flight before it resolves (so the database is not closed under a send)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    const listDueAutoAnswers = vi.fn(async () => {
      await gate;
      finished = true;
      return [];
    });
    const repos = { tabQuestions: { failLostAutoAnswers: vi.fn(async () => []), listDueAutoAnswers } } as unknown as Repositories;
    const stop = startAutoAnswerSweeper(repos, { info: vi.fn(), warn: vi.fn() }, 60_000);
    await vi.waitFor(() => expect(listDueAutoAnswers).toHaveBeenCalled());
    let stopped = false;
    const stopping = stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
  });

  it('stop during a batch: the rest of the batch is not claimed, so shutdown ends within the grace period', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const due = ['q1', 'q2', 'q3'].map((id) => row({ id, auto_answer: scheduled() }));
    const claimAutoAnswer = vi.fn(async () => {
      await gate;
      return undefined; // lost to the other color: nothing to send for this one
    });
    const repos = { tabQuestions: { failLostAutoAnswers: vi.fn(async () => []), listDueAutoAnswers: vi.fn(async () => due), claimAutoAnswer } } as unknown as Repositories;
    const stop = startAutoAnswerSweeper(repos, { info: vi.fn(), warn: vi.fn() }, 60_000);
    await vi.waitFor(() => expect(claimAutoAnswer).toHaveBeenCalledTimes(1));
    const stopping = stop();
    release();
    await stopping;
    expect(claimAutoAnswer).toHaveBeenCalledTimes(1);
  });

  it('ticks right away and never throws out of a tick; stop clears the timer', async () => {
    const listDueAutoAnswers = vi.fn(async () => {
      throw Object.assign(new Error('db down'), { code: 'P1001' });
    });
    const repos = { tabQuestions: { listDueAutoAnswers, failLostAutoAnswers: vi.fn(async () => []) } } as unknown as Repositories;
    const l = { info: vi.fn(), warn: vi.fn() };
    const stop = startAutoAnswerSweeper(repos, l, 60_000);
    await vi.waitFor(() => expect(l.warn).toHaveBeenCalledWith({ code: 'P1001' }, 'auto answer sweep failed'));
    stop();
  });
});

describe('cancelAutoAnswer', () => {
  const ctxFor = (current: TabQuestion | undefined, cancelled: TabQuestion | undefined) => {
    const tabQuestions = {
      findByIdForUser: vi.fn(async (_id: string, userId: string) => (userId === 'u1' ? current : undefined)),
      cancelAutoAnswer: vi.fn(async () => cancelled),
    };
    const repos = { tabQuestions, tabs: { findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]) } };
    return { ctx: { repos, scope: { user: { id: 'u1' } } } as unknown as ControlContext, tabQuestions };
  };
  beforeEach(() => {
    vi.mocked(publishTabQuestions).mockClear();
    vi.mocked(publishTabQuestions).mockImplementation(async (_r, _t, rows) => rows.map((r) => ({ id: r.id, auto_answer: r.auto_answer }) as never));
  });

  it('scheduled → cancelled, republished, the view returned', async () => {
    const cancelled = row({ auto_answer: scheduled({ status: 'cancelled', decided_by: 'u1' }) });
    const { ctx, tabQuestions } = ctxFor(row({ auto_answer: scheduled() }), cancelled);
    const view = await cancelAutoAnswer(ctx, 'q1');
    expect(tabQuestions.cancelAutoAnswer).toHaveBeenCalledWith('q1', 'u1');
    expect(view).toMatchObject({ id: 'q1', auto_answer: { status: 'cancelled' } });
    expect(publishTabQuestions).toHaveBeenCalledWith(ctx.repos, 'tab_question', [cancelled], { update: true });
  });

  it('404 for a foreign or missing row, or a suggestion', async () => {
    await expect(cancelAutoAnswer(ctxFor(undefined, undefined).ctx, 'q1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(cancelAutoAnswer(ctxFor(row({ kind: 'suggestion', payload: { text: 'x' } }), undefined).ctx, 'q1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('409 NOT_SCHEDULED when no countdown is running', async () => {
    const { ctx } = ctxFor(row(), undefined);
    await expect(cancelAutoAnswer(ctx, 'q1')).rejects.toMatchObject({ statusCode: 409, code: 'NOT_SCHEDULED' });
    expect(publishTabQuestions).not.toHaveBeenCalled();
  });
});
