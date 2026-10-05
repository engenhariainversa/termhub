import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { AutomationEventInput } from '../db/repositories/automation-events.js';
import type { AutoAnswer, TabQuestion } from '../db/repositories/tab-questions.js';
import type { ChoicePayload } from '../chat/tab-question-payload.js';

// the card's republish is the chat's business, not this module's
vi.mock('../chat/tab-questions.js', () => ({ publishTabQuestions: vi.fn(async () => []) }));
const { automationAnswer, recommendedOption, RECOMMENDED_REASON } = await import('./answers.js');
const { QUESTION_UNANSWERED } = await import('./follower.js');
const { normaliseLabel, parseAskUserQuestion } = await import('../chat/tab-question-payload.js');

type Item = ChoicePayload['questions'][number];
const item = (labels: Array<[string, boolean]>, question = 'Qual abordagem?', header = 'Abordagem'): Item => ({
  question,
  header,
  multi_select: false,
  options: labels.map(([label, recommended]) => ({ label, description: '', recommended })),
});
const one = (i: Item): ChoicePayload => ({ questions: [i] });

const card = (payload: ChoicePayload, over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 'tab1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload, tool_use_id: 'toolu_1',
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null,
  created_at: '2026-10-05T12:00:00.000Z', suggestion: null, auto_answer: null, answered_via: null, woken_at: null, surfaced_at: null, ...over,
});

const run = (): AutomationRun => ({
  id: 'run1', project_id: 'p1', task_id: 't1', role: 'implementer', status: 'running', waiting_reason: null, tab_id: 'tab1', machine_id: 'm1', account_id: 'a1',
  branch: 'TER-1-card', worktree_path: '/w', resume_count: 0, fix_count: 0, restart_count: 0, allowed_tools: null, last_typed_at: null, claimed_by: 'me',
  heartbeat_at: new Date(), started_at: new Date(), ended_at: null, created_at: new Date(),
});

function world(q: TabQuestion, o: { wakes?: boolean | 'throws'; noWaker?: boolean; openNow?: TabQuestion | undefined } = {}) {
  const r = run();
  const events: AutomationEventInput[] = [];
  const scheduled: AutoAnswer[] = [];
  const repos = {
    tabQuestions: {
      setAutoAnswer: vi.fn(async (_id: string, auto: AutoAnswer) => (scheduled.push(auto), { ...q, auto_answer: auto })),
      findOpenForTab: vi.fn(async () => ('openNow' in o ? o.openNow : q)),
    },
    tabs: { findById: vi.fn(async () => ({ id: 'tab1', name: 'api' })) },
    automationRuns: {
      updateActive: vi.fn(async (_id: string, instance: string, patch: Partial<AutomationRun>) => {
        if (instance !== r.claimed_by) return false;
        Object.assign(r, patch);
        return true;
      }),
    },
    automationEvents: { insert: vi.fn(async (e: AutomationEventInput) => (events.push(e), { ...e, id: `e${events.length}`, created_at: '' })) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
  } as unknown as Repositories;
  const wake = vi.fn(async () => {
    if (o.wakes === 'throws') throw new Error('boom');
    return o.wakes ?? true;
  });
  const deps = { repos, waker: o.noWaker ? undefined : { wake } };
  return { run: r, events, scheduled, repos, deps, wake, kinds: () => events.map((e) => e.kind) };
}

describe('recommendedOption (F-18)', () => {
  it('reads the option the agent marked, by `recommended`', () => {
    expect(recommendedOption(one(item([['Worktree', true], ['Branch', false]])))).toBe('Worktree');
  });

  it('none, two marked, or a card of several questions → null', () => {
    expect(recommendedOption(one(item([['A', false], ['B', false]])))).toBeNull();
    expect(recommendedOption(one(item([['A', true], ['B', true]])))).toBeNull();
    expect(recommendedOption({ questions: [item([['A', true], ['B', false]]), item([['C', false], ['D', false]])] })).toBeNull();
  });

  it('"(Recomendado)" is recognised at parse time like "(Recommended)"', () => {
    expect(normaliseLabel('Azul (Recomendado)')).toEqual({ label: 'Azul', recommended: true });
    expect(normaliseLabel('Blue (Recommended)')).toEqual({ label: 'Blue', recommended: true });
    expect(normaliseLabel('(Recomendado)')).toEqual({ label: '(Recomendado)', recommended: false });
    const parsed = parseAskUserQuestion({ questions: [{ question: 'Qual?', header: 'H', options: [{ label: 'Sim (recomendado)', description: '' }, { label: 'Não', description: '' }] }] });
    expect(parsed && recommendedOption(parsed)).toBe('Sim');
  });
});

describe('automationAnswer (spec D18)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1. a repeat already counting down wins: nothing else is scheduled or woken', async () => {
    const auto: AutoAnswer = { answer: { answers: [{ selected: [1] }] }, by: 'memory', reason: 'Mesma pergunta respondida antes', sources: [{ kind: 'decision', id: 'd1' }], due_at: '', status: 'scheduled' };
    const w = world(card(one(item([['Worktree', true], ['Branch', false]])), { auto_answer: auto }));
    expect(await automationAnswer(w.deps, card(one(item([['Worktree', true], ['Branch', false]])), { auto_answer: auto }), w.run)).toBe('repeat');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
    expect(w.wake).not.toHaveBeenCalled();
    expect(w.events).toEqual([expect.objectContaining({ kind: 'question_answered', run_id: 'run1', payload: { via: 'repeat', tab_id: 'tab1', question_id: 'q1' } })]);
  });

  it('2. the recommended option is scheduled with by "automation" and the usual 60 s countdown', async () => {
    const q = card(one(item([['Branch', false], ['Worktree', true]])));
    const w = world(q);
    const before = Date.now();
    expect(await automationAnswer(w.deps, q, w.run)).toBe('recommended');
    expect(w.scheduled).toHaveLength(1);
    const auto = w.scheduled[0]!;
    expect(auto).toMatchObject({ answer: { answers: [{ selected: [1] }] }, by: 'automation', reason: RECOMMENDED_REASON, sources: [], status: 'scheduled' });
    const due = Date.parse(auto.due_at) - before;
    expect(due).toBeGreaterThanOrEqual(59_000);
    expect(due).toBeLessThanOrEqual(61_000);
    expect(w.wake).not.toHaveBeenCalled();
    expect(w.kinds()).toEqual(['question_answered']);
    expect(w.events[0]!.payload).toMatchObject({ via: 'recommended' });
    expect(w.run.status).toBe('running');
  });

  it('a "(Recomendado)" option the keyword block catches ("deploy") is never chosen: the chat is woken instead', async () => {
    const q = card(one(item([['Fazer deploy agora', true], ['Esperar', false]])));
    const w = world(q);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('woken');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
    expect(w.wake).toHaveBeenCalledWith(q, 'api', { automatic: true });
  });

  it('the keyword block on the question itself also stops the recommended path', async () => {
    const q = card(one(item([['Sim', true], ['Não', false]], 'Faço o merge na main?', 'Merge')));
    const w = world(q);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('woken');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
  });

  it('two "(Recomendado)" options → none is chosen', async () => {
    const q = card(one(item([['A', true], ['B', true]])));
    const w = world(q);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('woken');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
  });

  it('a card with several questions skips the recommended path', async () => {
    const q = card({ questions: [item([['A', true], ['B', false]]), item([['C', true], ['D', false]], 'Outra?', 'Outra')] });
    const w = world(q);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('woken');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
  });

  it('4. the wake budget spent (the waker says no) → the run waits for the person, escalated', async () => {
    const q = card(one(item([['A', false], ['B', false]])));
    const w = world(q, { wakes: false });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('escalated');
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: QUESTION_UNANSWERED });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', run_id: 'run1', payload: { reason: QUESTION_UNANSWERED, tab_id: 'tab1' } })]);
  });

  it('no waker at all, or a wake that throws, also escalates', async () => {
    for (const o of [{ noWaker: true }, { wakes: 'throws' as const }]) {
      const q = card(one(item([['A', false], ['B', false]])));
      const w = world(q, o);
      expect(await automationAnswer(w.deps, q, w.run)).toBe('escalated');
      expect(w.run.status).toBe('waiting');
    }
  });

  it('a card that moved on before the escalation is left alone (no escalation of a closed card)', async () => {
    const q = card(one(item([['A', false], ['B', false]])));
    const w = world(q, { wakes: false, openNow: undefined });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('closed');
    expect(w.run.status).toBe('running');
    expect(w.events).toEqual([]);
  });

  it('a recommended countdown that lost to one scheduled meanwhile counts as the repeat, never escalates', async () => {
    const q = card(one(item([['A', true], ['B', false]])));
    const counting = card(q.payload as ChoicePayload, { auto_answer: { answer: { answers: [{ selected: [0] }] }, by: 'concierge', reason: 'r', sources: [], due_at: '', status: 'scheduled' } });
    const w = world(q, { openNow: counting });
    vi.mocked(w.repos.tabQuestions.setAutoAnswer).mockResolvedValueOnce(undefined);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('repeat');
    expect(w.wake).not.toHaveBeenCalled();
    expect(w.run.status).toBe('running');
  });

  it('a permission card or a closed card is not touched', async () => {
    const w = world(card(one(item([['A', true], ['B', false]]))));
    expect(await automationAnswer(w.deps, card(one(item([['A', true], ['B', false]])), { kind: 'permission', payload: { tool_name: 'Bash' } }), w.run)).toBe('closed');
    expect(await automationAnswer(w.deps, card(one(item([['A', true], ['B', false]])), { status: 'answered_in_tab' }), w.run)).toBe('closed');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
    expect(w.wake).not.toHaveBeenCalled();
  });
});
