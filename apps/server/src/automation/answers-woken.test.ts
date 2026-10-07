import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { AutomationEventInput } from '../db/repositories/automation-events.js';
import type { AutoAnswer, TabQuestion } from '../db/repositories/tab-questions.js';
import type { ChoicePayload } from '../chat/tab-question-payload.js';

// TER-974: the woken chat's answer in an automatic tab meets the run's caps and cycle detector.
const live = { run: null as AutomationRun | null };
vi.mock('./pause.js', () => ({ automaticRunOfTab: vi.fn(async () => live.run), isPaused: vi.fn(async () => false) }));
vi.mock('../chat/tab-questions.js', () => ({ publishTabQuestions: vi.fn(async () => []) }));
const { ANSWER_CYCLE_MAX, AUTOMATION_ANSWERS_MAX_PER_HOUR, questionCycleHash, WOKEN_ANSWER_STOPPED, wokenAnswerGuard } = await import('./answers.js');

const payload: ChoicePayload = { questions: [{ question: 'Qual?', header: 'H', multi_select: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] };
const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 'tab1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload, tool_use_id: 'toolu_1',
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null,
  created_at: '2026-10-07T12:00:00.000Z', suggestion: null, auto_answer: null, answered_via: null, woken_at: null, surfaced_at: null, ...over,
});
const auto = (by: AutoAnswer['by'] = 'concierge'): AutoAnswer => ({ answer: { answers: [{ selected: [1] }] }, by, reason: 'r', sources: [{ kind: 'decision', id: 'd1' }], due_at: '', status: 'sent' });
const run = (): AutomationRun => ({
  id: 'run1', project_id: 'p1', task_id: 't1', role: 'implementer', status: 'running', waiting_reason: null, tab_id: 'tab1', machine_id: 'm1', account_id: 'a1',
  branch: 'TER-1-card', worktree_path: '/w', resume_count: 0, fix_count: 0, restart_count: 0, allowed_tools: null, last_typed_at: null, woken_at: null, claimed_by: 'me',
  heartbeat_at: new Date(), started_at: new Date(), ended_at: null, created_at: new Date(),
});

function world(o: { lastHour?: number; prior?: Array<Record<string, string>> } = {}) {
  const r = run();
  live.run = r;
  const events: AutomationEventInput[] = [];
  const repos = {
    automationRuns: { updateActive: vi.fn(async (_id: string, _i: string, patch: Partial<AutomationRun>) => (Object.assign(r, patch), true)) },
    automationEvents: {
      insert: vi.fn(async (e: AutomationEventInput) => (events.push(e), { ...e, id: `e${events.length}`, created_at: '' })),
      countForRun: vi.fn(async () => o.lastHour ?? 0),
      payloadsForRun: vi.fn(async () => o.prior ?? []),
    },
    tabQuestions: { findOpenForTab: vi.fn(async () => undefined) },
    tabs: { findById: vi.fn(async () => ({ id: 'tab1', name: 'api' })) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
  } as unknown as Repositories;
  return { run: r, events, guard: wokenAnswerGuard({ repos }), kinds: () => events.map((e) => e.kind) };
}

describe('wokenAnswerGuard (TER-974)', () => {
  it('lets the answer through, then records it for the run with its cycle hash', async () => {
    const w = world();
    expect(await w.guard.before(row(), auto())).toBeNull();
    await w.guard.sent(row(), auto());
    expect(w.events).toEqual([expect.objectContaining({ kind: 'question_answered', run_id: 'run1', payload: { via: 'woken', tab_id: 'tab1', question_id: 'q1', cycle: questionCycleHash(payload, auto().answer) } })]);
  });

  it('stops the same answer to the same question past the cycle, and hands the run to the person', async () => {
    const h = questionCycleHash(payload, auto().answer);
    const w = world({ prior: Array(ANSWER_CYCLE_MAX).fill({ via: 'woken', cycle: h }) });
    expect(await w.guard.before(row(), auto())).toBe(WOKEN_ANSWER_STOPPED);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'answer_cycle' });
    expect(w.kinds()).toEqual(['escalated']);
  });

  it('stops it past the hourly cap of the run\'s answers', async () => {
    const w = world({ lastHour: AUTOMATION_ANSWERS_MAX_PER_HOUR });
    expect(await w.guard.before(row(), auto())).toBe(WOKEN_ANSWER_STOPPED);
    expect(w.run.waiting_reason).toBe('answer_cap');
  });

  it('leaves alone any other countdown, and a tab with no live automatic run', async () => {
    const w = world({ lastHour: AUTOMATION_ANSWERS_MAX_PER_HOUR });
    for (const by of ['memory', 'automation'] as const) {
      expect(await w.guard.before(row(), auto(by))).toBeNull();
      await w.guard.sent(row(), auto(by));
    }
    live.run = null;
    expect(await w.guard.before(row(), auto())).toBeNull();
    await w.guard.sent(row(), auto());
    expect(w.events).toEqual([]);
  });
});
