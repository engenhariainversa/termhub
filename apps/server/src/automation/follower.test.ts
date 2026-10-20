import { describe, expect, it, vi } from 'vitest';
import { AGENT_EXITED_TEXT, EXITED_RESUME_PROMPT } from '../chat/agent-exited.js';
import { ControlError, type ControlContext } from '../control/context.js';
import { DEFAULT_AUTOMATION_TOOLS } from '../control/agents.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { AutomationEventInput } from '../db/repositories/automation-events.js';
import type { Tab, Task } from '../db/repositories/types.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { monitorBus } from '../monitor/bus.js';
import { RATE_LIMIT_TEXT } from '../monitor/state.js';
import { cancelRun, endRunsOfMergedCard, TAB_CLOSED, UNTAGGED, escalateAutomationRun, escalationReasonText, escalationText, resumeAutomationRun, SLOT_FREE_REASONS, ANSWER_CAP, followRun, getRunCard, PERMISSION_NEEDED, QUESTION_EXPIRED, QUESTION_UNANSWERED, QUESTION_WAIT_MS, TRUST_WAIT_MS, onTabChange, PR_GRACE_MS, reportCard, startFollower, sweepRuns, tabHasActiveRun, type FollowerDeps } from './follower.js';
import { stoppedTabWakeText, type StoppedTabWake } from '../chat/wake.js';
import { automationBus } from './events.js';
import { chatBus, type ChatEvent } from '../chat/bus.js';
import { RESUME_TEXT, serverMessage } from './prompts.js';

const ME = 'instance-me';
let seq = 0;

/** One project, one card, one running run in one tab, and fakes that keep what is written. */
function world(o: {
  run?: Partial<AutomationRun>;
  tab?: Partial<Tab>;
  task?: Partial<Task>;
  resumeMax?: number;
  /** budgets in USD (null = off) and what the day / the card spent */
  dailyBudget?: number | null;
  cardBudget?: number | null;
  daySpent?: number;
  cardSpent?: number;
  enabled?: boolean;
  paused?: boolean;
  openQuestion?: boolean;
  /** the tab's newest question row (`latestQuestionForTab`) */
  question?: TabQuestion;
  prs?: Array<{ state: string; head_ref: string; url: string; number: number; merged_at?: Date | null }>;
  /** when the run's newest `escalated` event was recorded (`lastForRun`) */
  escalatedAt?: string;
  /** the owner's active project conversation; null = none */
  conversation?: { id: string } | null;
} = {}) {
  const runId = `run${++seq}`;
  const run: AutomationRun = {
    id: runId, project_id: 'p1', task_id: 't1', role: 'implementer', status: 'running', waiting_reason: null, tab_id: 'tab1', machine_id: 'm1', account_id: 'a1',
    branch: 'TER-1-card', worktree_path: '/w/TER-1', resume_count: 0, fix_count: 0, restart_count: 0, claimed_by: ME, heartbeat_at: new Date(), started_at: new Date(),
    ended_at: null, created_at: new Date(), allowed_tools: null, last_typed_at: null, woken_at: null, ...o.run,
  };
  const tab = { id: 'tab1', project_id: 'p1', machine_id: 'm1', state: 'waiting_input', state_text: 'Pronto.', state_tool: 'claude', state_at: `2026-10-05T10:00:0${seq % 10}.000Z`, rate_limited_at: null, ...o.tab } as Tab;
  const task = { id: 't1', project_id: 'p1', ref: 'TER-1', title: 'Card', description: 'd', type: 'task', status: 'doing', tab_id: 'tab1', auto: true, parent_id: null, epic_id: null, column_id: 'c2', ...o.task } as Task;
  const events: AutomationEventInput[] = [];
  const isActive = () => ['queued', 'starting', 'running', 'waiting'].includes(run.status);
  const repos = {
    automationRuns: {
      activeByTab: vi.fn(async (id: string) => (id === run.tab_id && isActive() ? { ...run } : null)),
      findById: vi.fn(async () => ({ ...run })),
      followedBy: vi.fn(async (instance: string) => (instance === run.claimed_by && ['running', 'waiting'].includes(run.status) ? [{ ...run }] : [])),
      updateActive: vi.fn(async (_id: string, instance: string, patch: Partial<AutomationRun>, opts?: { unlessWaitingFor?: string }) => {
        if (instance !== run.claimed_by || !isActive()) return false;
        if (opts?.unlessWaitingFor && run.status === 'waiting' && run.waiting_reason === opts.unlessWaitingFor) return false;
        Object.assign(run, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
        return true;
      }),
      bump: vi.fn(async (_id: string, field: 'resume_count' | 'restart_count') => ++run[field]),
      claimWake: vi.fn(async (_id: string, instance: string, at: Date) => {
        if (instance !== run.claimed_by || run.woken_at) return false;
        run.woken_at = at;
        return true;
      }),
      noteTyped: vi.fn(async (_id: string, at: Date) => void (run.last_typed_at = at)),
    },
    tabs: { findById: vi.fn(async () => tab) },
    tabQuestions: { hasOpenQuestion: vi.fn(async () => o.openQuestion ?? o.question?.status === 'open'), latestQuestionForTab: vi.fn(async () => o.question) },
    taskPullRequests: { listByTasks: vi.fn(async () => o.prs ?? []) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    projectSetup: { get: vi.fn(async () => ({ data: { automation: { enabled: o.enabled ?? true, resume_max: o.resumeMax ?? 3, allowed_tools: null, daily_budget_usd: o.dailyBudget ?? null, card_budget_usd: o.cardBudget ?? null } } })) },
    automationPauses: { state: vi.fn(async () => ({ user: o.paused ? new Date() : null, project: null })) },
    users: { findById: vi.fn(async () => ({ id: 'u1' })) },
    tabUsage: {
      ownerTimeZone: vi.fn(async () => null),
      costOfDay: vi.fn(async () => o.daySpent ?? 0),
      totalsByTask: vi.fn(async (ids: string[]) => new Map([[ids[0]!, { tokens: 1, cost_usd: o.cardSpent ?? 0 }]])),
    },
    machines: { findById: vi.fn(async () => ({ id: 'm1', owner_id: 'u1' })) },
    tasks: {
      findById: vi.fn(async () => task),
      setTab: vi.fn(async (_id: string, tabId: string) => Object.assign(task, { tab_id: tabId })),
      startWork: vi.fn(async () => Object.assign(task, { status: 'doing' })),
      childIds: vi.fn(async () => ['s1']),
      findByIds: vi.fn(async () => [{ id: 's1', ref: 'TER-2', title: 'Sub', status: 'todo' }]),
    },
    automationEvents: {
      insert: vi.fn(async (e: AutomationEventInput) => (events.push(e), { ...e, id: `e${events.length}`, created_at: '' })),
      insertOnce: vi.fn(async (e: AutomationEventInput) => (events.some((x) => x.kind === e.kind && x.payload?.day === e.payload?.day) ? null : (events.push(e), { ...e, id: `e${events.length}`, created_at: '' }))),
      lastForRun: vi.fn(async () => (o.escalatedAt ? { kind: 'escalated', created_at: o.escalatedAt } : null)),
    },
    chat: {
      findLatestActiveForProject: vi.fn(async () => (o.conversation === undefined ? { id: 'cp' } : (o.conversation ?? undefined))),
      getOrCreateForProject: vi.fn(async () => ({ id: 'c-new' })),
      findByIdForUser: vi.fn(async (id: string) => ({ id, archived_at: id === 'c-archived' ? '2026-10-01T00:00:00.000Z' : null })),
      addMessage: vi.fn(async (m: { conversation_id: string; text: string }) => ({ id: `m${++seq}`, role: 'assistant', created_at: '', ...m })),
    },
  } as unknown as Repositories;
  const type = vi.fn(async (_ctx: ControlContext, _tabId: string, _text: string) => {});
  // a restart line goes to the shell, through a file when long (TER-988): not through `type`
  const typeLine = vi.fn(async (_ctx: ControlContext, _tabId: string, _line: string) => {});
  const restartLine = vi.fn(async () => 'claude --resume …');
  const onRateLimited = vi.fn(async () => {});
  // the clock is well past the stop's grace unless a test moves it
  let now = new Date('2026-10-05T12:00:00.000Z');
  const deps: FollowerDeps = { repos, instance: ME, lifecycle: { draining: false }, type, typeLine, restartLine, onRateLimited, settleMs: 0, now: () => now };
  const setNow = (d: Date) => (now = d);
  const setPrs = (list: NonNullable<typeof o.prs>) => (o.prs = list);
  const setPaused = (p: boolean) => (o.paused = p);
  return { run, tab, task, events, repos, deps, type, typeLine, restartLine, onRateLimited, setNow, setPrs, setPaused, kinds: () => events.map((e) => e.kind) };
}

const tabCtx = (repos: Repositories, tabId = 'tab1') => ({ repos, token: { id: 'tok', scopes: ['read', 'memory'], tab: { id: tabId, project_id: 'p1' } } }) as unknown as ControlContext;

describe('following a run (spec D15, F-13)', () => {
  it('a stop with no card and no PR is resumed with the marked message, counted and recorded', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.type.mock.calls[0]![1]).toBe('tab1');
    expect(w.type.mock.calls[0]![2]).toBe(serverMessage(RESUME_TEXT));
    expect(w.type.mock.calls[0]![2].startsWith('[termhub automático] ')).toBe(true);
    expect(w.run.resume_count).toBe(1);
    expect(w.events).toEqual([expect.objectContaining({ kind: 'run_resumed', run_id: w.run.id, payload: { tab_id: 'tab1', count: 1 } })]);
  });

  it.each(['working', 'waiting_background', 'waiting_permission'] as const)('%s is never a stop', async (state) => {
    const w = world({ tab: { state } });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
  });

  it('a stop with an open question card is left to the card', async () => {
    const w = world({ openQuestion: true });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('running');
  });

  it('a stop on the usage limit goes to the rate-limit branch first, never a resume', async () => {
    for (const tab of [{ state_text: `${RATE_LIMIT_TEXT} — volta às 15h` }, { rate_limited_at: '2026-10-05T10:00:00.000Z' }]) {
      const w = world({ tab, prs: [{ state: 'open', head_ref: 'TER-1-card', url: 'https://github.com/o/r/pull/9', number: 9 }] });
      await followRun(w.deps, w.run.id);
      expect(w.onRateLimited).toHaveBeenCalledTimes(1);
      expect(w.type).not.toHaveBeenCalled();
      expect(w.run.status).toBe('running');
    }
  });

  it('a stop with an open PR from the run\'s branch ends the run done (PR fallback, D17)', async () => {
    const w = world({ prs: [{ state: 'open', head_ref: 'TER-1-card', url: 'https://github.com/o/r/pull/9', number: 9 }] });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('done');
    expect(w.run.ended_at).toBeInstanceOf(Date);
    expect(w.kinds()).toEqual(['run_done', 'pr_opened']);
    expect(w.events[0]!.payload).toMatchObject({ via: 'pull_request', pr_url: 'https://github.com/o/r/pull/9' });
    expect(w.events[1]!.payload).toMatchObject({ pr_url: 'https://github.com/o/r/pull/9', number: 9, branch: 'TER-1-card' });
    // the card stays where the agent put it
    expect(w.repos.tasks.startWork).not.toHaveBeenCalled();
  });

  it('an integrator stopping with the epic PR open is resumed, not ended (the server opened that PR before it)', async () => {
    const w = world({ run: { role: 'integrator', branch: 'epic/TER-1-x' }, prs: [{ state: 'open', head_ref: 'epic/TER-1-x', url: 'https://github.com/o/r/pull/9', number: 9 }] });
    await followRun(w.deps, w.run.id);
    expect(w.run.status).toBe('running');
    expect(w.type).toHaveBeenCalledTimes(1);
  });

  it('a fixer stopping with its PR open is resumed, not ended (the PR existed before the fixer started)', async () => {
    const w = world({ run: { role: 'fixer', branch: 'TER-1-card' }, prs: [{ state: 'open', head_ref: 'TER-1-card', url: 'https://github.com/o/r/pull/9', number: 9 }] });
    await followRun(w.deps, w.run.id);
    expect(w.run.status).toBe('running');
    expect(w.type).toHaveBeenCalledTimes(1);
  });

  it('a PR from another branch, or closed, does not end the run', async () => {
    const w = world({ prs: [{ state: 'open', head_ref: 'other', url: 'u1', number: 1 }, { state: 'closed', head_ref: 'TER-1-card', url: 'u2', number: 2 }] });
    await followRun(w.deps, w.run.id);
    expect(w.run.status).toBe('running');
    expect(w.type).toHaveBeenCalledTimes(1);
  });

  it('past resume_max the run waits and is escalated (the wake/escalate hook), with nothing typed', async () => {
    const w = world({ run: { resume_count: 3 } });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'resume_cap' });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', payload: { reason: 'resume_cap', tab_id: 'tab1' } })]);
  });

  it('resume_max 0 escalates on the first stop', async () => {
    const w = world({ resumeMax: 0 });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.resume_count).toBe(0);
    expect(w.run.status).toBe('waiting');
    expect(w.kinds()).toEqual(['escalated']);
  });

  it('a paused project types nothing and counts nothing (D24)', async () => {
    const w = world({ paused: true });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.repos.automationRuns.bump).not.toHaveBeenCalled();
    expect(w.run.status).toBe('running');
  });

  it('a pause pressed while the follower decides still stops the typing (checked right before it)', async () => {
    const w = world();
    vi.mocked(w.repos.automationPauses.state).mockResolvedValueOnce({ user: null, project: null }).mockResolvedValue({ user: new Date(), project: null });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
  });

  it('a project whose automation was turned off types nothing', async () => {
    const w = world({ enabled: false });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('running');
  });

  it('a card whose tag was removed finishes its turn and is not resumed (spec §13, F-23)', async () => {
    const w = world({ task: { auto: false } });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.repos.automationRuns.bump).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'cancelled', waiting_reason: 'untagged' });
  });

  it('the same tab state delivered twice is acted on once', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    await followRun(w.deps, w.run.id);
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.run.resume_count).toBe(1);
  });

  it('only a running run driven by this instance is followed', async () => {
    for (const run of [{ claimed_by: 'other-colour' }, { status: 'waiting' as const }, { status: 'done' as const }]) {
      const w = world({ run });
      await followRun(w.deps, w.run.id);
      expect(w.type).not.toHaveBeenCalled();
      expect(w.events).toEqual([]);
    }
  });

  it('a draining instance acts on nothing', async () => {
    const w = world();
    await followRun({ ...w.deps, lifecycle: { draining: true } }, w.run.id);
    await onTabChange({ ...w.deps, lifecycle: { draining: true } }, { tab: w.tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    expect(w.type).not.toHaveBeenCalled();
  });
});

describe('budgets (TER-892, spike R8)', () => {
  it('off by default: nothing is read and the stop is resumed as before (M1)', async () => {
    const w = world({ daySpent: 999, cardSpent: 999 });
    await followRun(w.deps, w.run.id);
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.repos.tabUsage.costOfDay).not.toHaveBeenCalled();
    expect(w.repos.tabUsage.totalsByTask).not.toHaveBeenCalled();
  });

  it('a day at its budget resumes nothing and keeps the run going; the day after it resumes', async () => {
    const w = world({ dailyBudget: 10, daySpent: 10 });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('running');
    expect(w.run.resume_count).toBe(0);
    expect(w.kinds()).toEqual(['budget_hit']);
    // tomorrow's meter starts from zero
    const next = world({ dailyBudget: 10, daySpent: 0 });
    await followRun(next.deps, next.run.id);
    expect(next.type).toHaveBeenCalledTimes(1);
  });

  it('an exited agent is not restarted while the day is at its budget', async () => {
    const w = world({ dailyBudget: 10, daySpent: 12, tab: { state: 'idle', state_text: AGENT_EXITED_TEXT } });
    await followRun(w.deps, w.run.id);
    expect(w.typeLine).not.toHaveBeenCalled();
    expect(w.run.restart_count).toBe(0);
  });

  it('a card past its own budget is parked and escalated, not resumed', async () => {
    const w = world({ cardBudget: 5, cardSpent: 5.5 });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'card_budget' });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', payload: { reason: 'card_budget', tab_id: 'tab1' } })]);
    expect(SLOT_FREE_REASONS).toContain('card_budget');
    expect(escalationText('card_budget')).toContain('Orçamento do card estourado');
  });

  it('a card under its budget is resumed', async () => {
    const w = world({ cardBudget: 5, cardSpent: 4 });
    await followRun(w.deps, w.run.id);
    expect(w.type).toHaveBeenCalledTimes(1);
  });
});

describe('no stop is abandoned (review round 1)', () => {
  it('a stop seen while paused is resumed once the pause is lifted (sweep and the resumed event)', async () => {
    const w = world({ paused: true });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    w.setPaused(false);
    await sweepRuns(w.deps);
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.run.resume_count).toBe(1);
    // a later sweep with the tab still in the same state types nothing more
    await sweepRuns(w.deps);
    expect(w.type).toHaveBeenCalledTimes(1);
  });

  it('the follower looks again when the automation bus says a pause was lifted', async () => {
    const w = world({ paused: true });
    const stop = startFollower(w.deps, { sweepMs: 60 * 60_000 });
    try {
      await followRun(w.deps, w.run.id);
      expect(w.type).not.toHaveBeenCalled();
      w.setPaused(false);
      automationBus.publish({ id: 'e', project_id: 'p1', task_id: null, run_id: null, kind: 'resumed', payload: {}, created_at: '', owner_id: 'u1' });
      await vi.waitFor(() => expect(w.type).toHaveBeenCalledTimes(1));
    } finally {
      stop();
    }
  });

  it('a transient failure typing is tried again by the next look', async () => {
    const w = world();
    w.type.mockRejectedValueOnce(new Error('machine offline'));
    await followRun(w.deps, w.run.id);
    expect(w.events).toEqual([]);
    await sweepRuns(w.deps);
    expect(w.type).toHaveBeenCalledTimes(2);
    expect(w.kinds()).toEqual(['run_resumed']);
  });

  it('a stop younger than the PR grace is left alone; a PR linked meanwhile ends the run instead of a resume', async () => {
    const w = world();
    w.setNow(new Date(Date.parse(w.tab.state_at!) + 5_000));
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    w.setPrs([{ state: 'open', head_ref: 'TER-1-card', url: 'https://github.com/o/r/pull/9', number: 9 }]);
    w.setNow(new Date(Date.parse(w.tab.state_at!) + 40_000));
    await sweepRuns(w.deps);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('done');
  });

  it('past the grace with no PR, the stop is resumed', async () => {
    const w = world();
    w.setNow(new Date(Date.parse(w.tab.state_at!) + PR_GRACE_MS + 1));
    await followRun(w.deps, w.run.id);
    expect(w.type).toHaveBeenCalledTimes(1);
  });

  it('a run parked in waiting ends done when its PR is linked later (D17, both orders)', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: 'resume_cap' } });
    await sweepRuns(w.deps);
    expect(w.run.status).toBe('waiting');
    w.setPrs([{ state: 'open', head_ref: 'TER-1-card', url: 'u', number: 5 }]);
    await sweepRuns(w.deps);
    expect(w.run.status).toBe('done');
    expect(w.kinds()).toEqual(['run_done', 'pr_opened']);
    expect(w.type).not.toHaveBeenCalled();
  });
});

describe('a tab that keeps stopping: wake the chat once, then escalate (D15, TER-887)', () => {
  const withWake = (w: ReturnType<typeof world>, woke = true) => {
    const wakeStopped = vi.fn(async (_i: StoppedTabWake) => woke);
    w.deps.wakeStopped = wakeStopped;
    return wakeStopped;
  };

  it('wakes the chat once past resume_max, naming ids and the card only; nothing typed, run still followed', async () => {
    const w = world({ run: { resume_count: 3 } });
    const wake = withWake(w);
    await followRun(w.deps, w.run.id);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith({ ownerId: 'u1', projectId: 'p1', runId: w.run.id, tabId: 'tab1', cardRef: 'TER-1', cardTitle: 'Card', tabName: null });
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.woken_at).toBeInstanceOf(Date);
    expect(w.run.status).toBe('running');
    expect(w.events).toEqual([]);
    // the next sweep, the tab not having moved: no second wake, no escalation yet
    await followRun(w.deps, w.run.id);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(w.run.status).toBe('running');
  });

  it('a second stop after the wake escalates', async () => {
    const w = world({ run: { resume_count: 3 } });
    const wake = withWake(w);
    await followRun(w.deps, w.run.id);
    w.tab.state_at = new Date(w.run.woken_at!.getTime() + 60_000).toISOString();
    w.setNow(new Date(w.run.woken_at!.getTime() + 2 * 60_000 + PR_GRACE_MS));
    await followRun(w.deps, w.run.id);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'resume_cap' });
    expect(w.kinds()).toEqual(['escalated']);
  });

  it('a chat that did nothing for QUESTION_WAIT_MS is escalated too', async () => {
    const w = world({ run: { resume_count: 3 } });
    withWake(w);
    await followRun(w.deps, w.run.id);
    w.setNow(new Date(w.run.woken_at!.getTime() + QUESTION_WAIT_MS));
    await followRun(w.deps, w.run.id);
    expect(w.kinds()).toEqual(['escalated']);
  });

  it('a wake that could not start escalates at once', async () => {
    const w = world({ run: { resume_count: 3 } });
    withWake(w, false);
    await followRun(w.deps, w.run.id);
    expect(w.kinds()).toEqual(['escalated']);
    expect(w.run.status).toBe('waiting');
  });

  it('a paused project is not woken for, but the person is still told (D24 does not hold back an escalation)', async () => {
    const w = world({ run: { resume_count: 3 }, paused: true });
    const wake = withWake(w);
    await followRun(w.deps, w.run.id);
    expect(wake).not.toHaveBeenCalled();
    expect(w.run.woken_at).toBeNull();
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'resume_cap' });
    expect(w.kinds()).toEqual(['escalated']);
    expect(w.repos.chat.addMessage).toHaveBeenCalledTimes(1);
  });

  it('paused, below the cap: nothing is typed and nobody is told', async () => {
    const w = world({ run: { resume_count: 1 }, paused: true });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
    expect(w.run.status).toBe('running');
  });

  it('an untagged card is not woken for: the run is cancelled', async () => {
    const w = world({ run: { resume_count: 3 }, task: { auto: false } });
    const wake = withWake(w);
    await followRun(w.deps, w.run.id);
    expect(wake).not.toHaveBeenCalled();
    expect(w.run.status).toBe('cancelled');
  });

  it('a stop under resume_max is resumed, never woken for', async () => {
    const w = world({ run: { resume_count: 1 } });
    const wake = withWake(w);
    await followRun(w.deps, w.run.id);
    expect(wake).not.toHaveBeenCalled();
    expect(w.type).toHaveBeenCalledTimes(1);
  });

  it('a question the automation could not answer escalates without waking for a stop', async () => {
    const w = world({ question: { id: 'q1', kind: 'choice', status: 'open', auto_answer: null, created_at: '2026-10-05T10:00:00.000Z' } as unknown as TabQuestion });
    const wake = withWake(w);
    w.setNow(new Date('2026-10-05T12:00:00.000Z'));
    await followRun(w.deps, w.run.id);
    expect(wake).not.toHaveBeenCalled();
    expect(w.kinds()).toEqual(['escalated']);
  });

  it('escalate_automation_run hands a run over to the person (the chat tool), from its own project only', async () => {
    const w = world({ run: { resume_count: 3 } });
    const ctx = (ok: boolean) => ({ repos: w.repos, scoped: { project: vi.fn(async () => { if (!ok) throw new Error('NOT_FOUND'); return {}; }) } }) as unknown as ControlContext;
    await expect(escalateAutomationRun(ctx(false), { run_id: w.run.id, reason: 'x' })).rejects.toThrow();
    expect(w.run.status).toBe('running');
    await expect(escalateAutomationRun(ctx(true), { run_id: w.run.id, reason: 'não sei continuar' })).resolves.toEqual({ ok: true });
    await expect(escalateAutomationRun(ctx(true), { run_id: w.run.id, reason: 'de novo' })).resolves.toEqual({ ok: true });
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'resume_cap' });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', payload: { reason: 'resume_cap', tab_id: 'tab1' } })]);
  });
});

describe('the stopped-tab wake text', () => {
  it('is pt-BR, starts with Automático:, names the card and the run, and carries no tab content', () => {
    const text = stoppedTabWakeText({ runId: 'r1', tabId: 'tab1', cardRef: 'TER-1', cardTitle: 'Título «x»', tabName: 'api' });
    expect(text.startsWith('Automático: ')).toBe(true);
    expect(text).toContain('TER-1');
    expect(text).toContain('escalate_automation_run');
    expect(text).toContain('run_id "r1"');
    expect(text).toContain('send_input');
    expect(text).toContain('tab_id tab1');
  });
});

describe('an agent that exited (spec D15, F-12)', () => {
  const exited = { state: 'idle' as const, state_text: AGENT_EXITED_TEXT };

  it('is restarted once in the same tab, with the run\'s permission profile and the marked message', async () => {
    const w = world({ tab: exited });
    await followRun(w.deps, w.run.id);
    expect(w.restartLine).toHaveBeenCalledWith(w.repos, w.tab, expect.objectContaining({ id: 'm1' }), {
      permission: { mode: 'auto', allowedTools: DEFAULT_AUTOMATION_TOOLS, branch: w.run.branch, worktree: w.run.worktree_path },
      prompt: serverMessage(EXITED_RESUME_PROMPT),
    });
    expect(w.typeLine).toHaveBeenCalledWith(expect.anything(), 'tab1', 'claude --resume …');
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.restart_count).toBe(1);
    expect(w.events).toEqual([expect.objectContaining({ kind: 'run_resumed', payload: { tab_id: 'tab1', restart: true, count: 1 } })]);
  });

  it('the restart keeps the allow list stored on the run, not the setup\'s current one', async () => {
    const w = world({ tab: exited, run: { allowed_tools: ['Bash(make:*)'] } });
    await followRun(w.deps, w.run.id);
    expect(w.restartLine).toHaveBeenCalledWith(w.repos, w.tab, expect.anything(), expect.objectContaining({ permission: { mode: 'auto', allowedTools: ['Bash(make:*)'], branch: w.run.branch, worktree: w.run.worktree_path } }));
  });

  it('is never restarted on an account exclusive to another project: the run ends blocked for the person (TER-990)', async () => {
    const w = world({ tab: exited });
    w.restartLine.mockRejectedValueOnce(new ControlError('ACCOUNT_EXCLUSIVE', 'Conta exclusiva do projeto DR Horton'));
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'blocked', waiting_reason: 'account_exclusive' });
    expect(w.kinds()).toEqual(['run_blocked', 'escalated']);
  });

  it('is never restarted without the hard-lock guard: an agent before 0.19.0 ends the run blocked, "atualize o agente" (TER-1005)', async () => {
    const w = world({ tab: exited });
    w.restartLine.mockRejectedValueOnce(new ControlError('GUARD_UNSUPPORTED', 'Atualize o agente de hulk'));
    await followRun(w.deps, w.run.id);
    expect(w.typeLine).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'blocked', waiting_reason: 'agent_outdated' });
    expect(w.kinds()).toEqual(['run_blocked', 'escalated']);
    expect(escalationText('agent_outdated')).toMatch(/^O agente saiu e esta máquina não tem a trava/);
  });

  it('a second exit ends the run blocked and escalates it', async () => {
    const w = world({ tab: exited, run: { restart_count: 1 } });
    await followRun(w.deps, w.run.id);
    expect(w.typeLine).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'blocked', waiting_reason: 'agent_exited' });
    expect(w.kinds()).toEqual(['run_blocked', 'escalated']);
  });

  it('is not restarted while paused, nor once its card was untagged', async () => {
    const paused = world({ tab: exited, paused: true });
    await followRun(paused.deps, paused.run.id);
    expect(paused.typeLine).not.toHaveBeenCalled();
    const untagged = world({ tab: exited, task: { auto: false } });
    await followRun(untagged.deps, untagged.run.id);
    expect(untagged.typeLine).not.toHaveBeenCalled();
    expect(untagged.run.status).toBe('cancelled');
  });

  it('an idle tab that did not exit (a normal end) is left alone', async () => {
    const w = world({ tab: { state: 'idle', state_text: null } });
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
  });
});

describe('the monitor bus subscription', () => {
  it('follows a tab of a run this instance drives, read from the database (also a run taken over)', async () => {
    const w = world();
    const stop = startFollower(w.deps);
    try {
      monitorBus.publish({ tab: w.tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
      await vi.waitFor(() => expect(w.type).toHaveBeenCalledTimes(1));
    } finally {
      stop();
    }
  });

  it('a tab with no active run, or another instance\'s run, is ignored', async () => {
    const none = world();
    await onTabChange(none.deps, { tab: { ...none.tab, id: 'other-tab' }, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    expect(none.type).not.toHaveBeenCalled();
    const theirs = world({ run: { claimed_by: 'other' } });
    await onTabChange(theirs.deps, { tab: theirs.tab, project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    expect(theirs.type).not.toHaveBeenCalled();
  });
});

describe('report_card (spec D17, F-8)', () => {
  it('from a tab without an active run → NO_RUN', async () => {
    const w = world();
    await expect(reportCard(tabCtx(w.repos, 'other-tab'), { status: 'done' })).rejects.toMatchObject({ code: 'NO_RUN' });
    await expect(reportCard({ repos: w.repos } as unknown as ControlContext, { status: 'done' })).rejects.toMatchObject({ code: 'NO_RUN' });
  });

  it('done ends the run with the PR, and the card stays where the agent put it', async () => {
    const w = world({ task: { status: 'done' } });
    expect(await reportCard(tabCtx(w.repos), { status: 'done', pr_url: 'https://github.com/o/r/pull/3' })).toEqual({ ok: true });
    expect(w.run.status).toBe('done');
    expect(w.kinds()).toEqual(['run_done', 'pr_opened']);
    expect(w.events[0]!.payload).toMatchObject({ via: 'report_card', pr_url: 'https://github.com/o/r/pull/3' });
    expect(w.repos.tasks.startWork).not.toHaveBeenCalled();
    expect(w.repos.tasks.setTab).not.toHaveBeenCalled();
  });

  it('done on a run whose card link failed at the start links the card and takes it out of todo', async () => {
    const w = world({ task: { status: 'todo', tab_id: null } });
    await reportCard(tabCtx(w.repos), { status: 'done' });
    expect(w.repos.tasks.setTab).toHaveBeenCalledWith('t1', 'tab1');
    expect(w.repos.tasks.startWork).toHaveBeenCalledWith('t1');
  });

  it('the PR fallback places an unlinked card the same way', async () => {
    const w = world({ task: { status: 'todo', tab_id: null }, prs: [{ state: 'open', head_ref: 'TER-1-card', url: 'u', number: 4 }] });
    await followRun(w.deps, w.run.id);
    expect(w.run.status).toBe('done');
    expect(w.repos.tasks.startWork).toHaveBeenCalledWith('t1');
  });

  it('blocked ends the run blocked with the reason and escalates it', async () => {
    const w = world();
    await reportCard(tabCtx(w.repos), { status: 'blocked', reason: 'Falta a chave da API' });
    expect(w.run).toMatchObject({ status: 'blocked', waiting_reason: 'reported_blocked' });
    expect(w.kinds()).toEqual(['run_blocked', 'escalated']);
    expect(w.events[0]!.payload).toMatchObject({ code: 'reported_blocked', reason: 'Falta a chave da API' });
  });

  it('blocked without a reason is refused and leaves the run as it was', async () => {
    const w = world();
    await expect(reportCard(tabCtx(w.repos), { status: 'blocked' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    expect(w.run.status).toBe('running');
  });

  it('a run already ended by the PR fallback is not ended twice', async () => {
    const w = world({ prs: [{ state: 'open', head_ref: 'TER-1-card', url: 'u', number: 4 }] });
    await followRun(w.deps, w.run.id);
    await expect(reportCard(tabCtx(w.repos), { status: 'done' })).rejects.toMatchObject({ code: 'NO_RUN' });
    expect(w.kinds()).toEqual(['run_done', 'pr_opened']);
  });
});

describe('get_card and the tab tools\' condition', () => {
  it('tabHasActiveRun is true only for a tab token whose tab has an active run of its project', async () => {
    const w = world();
    expect(await tabHasActiveRun(tabCtx(w.repos))).toBe(true);
    expect(await tabHasActiveRun(tabCtx(w.repos, 'other-tab'))).toBe(false);
    expect(await tabHasActiveRun({ repos: w.repos } as unknown as ControlContext)).toBe(false);
    const elsewhere = world({ run: { project_id: 'p2' } });
    expect(await tabHasActiveRun(tabCtx(elsewhere.repos))).toBe(false);
    // fails closed
    expect(await tabHasActiveRun({ token: { tab: { id: 'tab1', project_id: 'p1' } } } as unknown as ControlContext)).toBe(false);
  });

  it('get_card answers the run\'s own card with its subtasks and branch', async () => {
    const w = world();
    const card = await getRunCard(tabCtx(w.repos));
    expect(card).toMatchObject({ id: 't1', ref: 'TER-1', title: 'Card', description: 'd', branch: 'TER-1-card', subtasks: [{ ref: 'TER-2', title: 'Sub', status: 'todo' }] });
    await expect(getRunCard(tabCtx(w.repos, 'other-tab'))).rejects.toMatchObject({ code: 'NO_RUN' });
  });
});

describe('Claude\'s trust question (never answered by the automation)', () => {
  const NOW = new Date('2026-10-05T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const swapText = 'Conta trocada automaticamente: A → B. Se o Claude pedir para confiar na pasta, confirme na aba.';

  it('after an account swap, the tab is never typed into; past the wait the run is parked for the person and escalated once', async () => {
    const w = world({ tab: { state: 'waiting_input', state_text: swapText, state_at: ago(2 * 60_000).toISOString() } });
    await followRun(w.deps, w.run.id); // well past PR_GRACE_MS, still inside TRUST_WAIT_MS
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('running');
    expect(w.events).toEqual([]);

    w.setNow(new Date(NOW.getTime() + TRUST_WAIT_MS));
    await followRun(w.deps, w.run.id);
    await sweepRuns(w.deps);
    await sweepRuns(w.deps);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'needs_person' });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', run_id: w.run.id, payload: { reason: 'trust_prompt', tab_id: 'tab1' } })]);

    // the person confirmed: the resumed session works, and the run is followed again
    Object.assign(w.tab, { state: 'working', state_text: null, state_at: new Date(NOW.getTime() + TRUST_WAIT_MS + 1000).toISOString() });
    await followRun(w.deps, w.run.id);
    expect(w.run).toMatchObject({ status: 'running', waiting_reason: null });
    expect(w.type).not.toHaveBeenCalled();
  });

  it('a first start with no hook at all (trust question of a new worktree) is parked after the wait, never typed into', async () => {
    const w = world({ run: { started_at: ago(60_000) }, tab: { state: null, state_text: null, state_at: null } as Partial<Tab> });
    await sweepRuns(w.deps);
    expect(w.run.status).toBe('running');
    expect(w.events).toEqual([]);

    w.setNow(new Date(ago(60_000).getTime() + TRUST_WAIT_MS));
    await sweepRuns(w.deps);
    await sweepRuns(w.deps);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'needs_person' });
    expect(w.kinds()).toEqual(['escalated']);
    expect(w.events[0]!.payload).toEqual({ reason: 'trust_prompt', tab_id: 'tab1' });
    expect(w.type).not.toHaveBeenCalled();

    // confirmed: SessionStart moved the tab, and the follower takes the run back
    Object.assign(w.tab, { state: 'working', state_at: new Date(NOW.getTime() + TRUST_WAIT_MS).toISOString() });
    await sweepRuns(w.deps);
    expect(w.run).toMatchObject({ status: 'running', waiting_reason: null });
    expect(w.type).not.toHaveBeenCalled();
  });

  it('a first start whose pane is back at the shell is not the trust question: the agent never came up (TER-1005)', async () => {
    const w = world({ run: { started_at: ago(60_000) }, tab: { state: null, state_text: null, state_at: null } as Partial<Tab> });
    const foreground = vi.fn(async () => 'shell' as const);
    w.deps.foreground = foreground;
    w.setNow(new Date(ago(60_000).getTime() + TRUST_WAIT_MS));
    await sweepRuns(w.deps);
    expect(foreground).toHaveBeenCalledWith(expect.objectContaining({ id: 'tab1' }));
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'agent_not_started' });
    expect(w.kinds()).toEqual(['escalated']);
    expect(w.events[0]!.payload).toEqual({ reason: 'agent_not_started', tab_id: 'tab1' });
    expect(w.type).not.toHaveBeenCalled();
    expect(SLOT_FREE_REASONS).toContain('agent_not_started');
    expect(escalationText('agent_not_started')).toBe('O agente não chegou a iniciar: a aba voltou ao terminal. Confira o erro na tela e retome.');
    expect(escalationText('agent_not_started', 'en')).toBe('The agent never started: the tab went back to the shell. Check the error on screen and resume.');

    // Claude in front (or a pane that could not be read) is still the trust question
    for (const pane of ['busy', null] as const) {
      const t = world({ run: { started_at: ago(60_000) }, tab: { state: null, state_text: null, state_at: null } as Partial<Tab> });
      t.deps.foreground = async () => pane;
      t.setNow(new Date(ago(60_000).getTime() + TRUST_WAIT_MS));
      await sweepRuns(t.deps);
      expect(t.events[0]!.payload, String(pane)).toEqual({ reason: 'trust_prompt', tab_id: 'tab1' });
    }
  });

  it('the escalation has a text in both languages', () => {
    expect(escalationText('trust_prompt')).toBe('O agente parou na confirmação de confiança da pasta; confirme na aba para continuar.');
    expect(escalationText('trust_prompt', 'en')).toBe('The agent stopped at the folder trust confirmation; confirm it in the tab to continue.');
    expect(escalationText('nao_existe')).toBeNull();
    expect(escalationReasonText('nao_existe')).toBe('O trabalho automático parou e espera você.');
    expect(escalationReasonText('nao_existe', 'en')).toBe('Automatic work stopped and is waiting for you.');
  });

  it.each(['resume_cap', 'start_failed', 'agent_exited', 'reported_blocked', 'trust_prompt', 'question_unanswered', 'question_expired', 'answer_cap', 'permission_needed'])(
    'the reason %s has its own text in pt-BR and en',
    (reason) => {
      const pt = escalationText(reason);
      const en = escalationText(reason, 'en');
      expect(pt).toBeTruthy();
      expect(en).toBeTruthy();
      expect(en).not.toBe(pt);
    },
  );
});

describe('a question nothing automatic answered (spec §9.1, D18 step 4; carried from Task 18)', () => {
  const NOW_MS = Date.parse('2026-10-05T12:00:00.000Z');
  const iso = (msAgo: number) => new Date(NOW_MS - msAgo).toISOString();
  const question = (over: Partial<TabQuestion> = {}): TabQuestion => ({
    id: 'q1', tab_id: 'tab1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice',
    payload: { questions: [{ question: 'Qual?', header: 'H', multi_select: false, options: [{ label: 'A', description: '', recommended: false }, { label: 'B', description: '', recommended: false }] }] },
    tool_use_id: null, status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null,
    created_at: iso(60_000), suggestion: null, auto_answer: null, answered_via: null, woken_at: null, surfaced_at: null, ...over,
  });
  const countdown = (status: 'scheduled' | 'sent' | 'cancelled' | 'failed') => ({ answer: { answers: [{ selected: [0] }] }, by: 'automation' as const, reason: 'r', sources: [], due_at: iso(0), status });

  it('an open card whose countdown failed escalates the run once, with nothing typed', async () => {
    const w = world({ question: question({ auto_answer: countdown('failed') }) });
    await sweepRuns(w.deps);
    await sweepRuns(w.deps);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: QUESTION_UNANSWERED });
    expect(w.kinds()).toEqual(['escalated']);
    // TER-1011: why — the recommended option's countdown did not go out (no precedent to name)
    expect(w.events[0]!.payload).toEqual({ reason: QUESTION_UNANSWERED, tab_id: 'tab1', why: 'auto_answer_stopped' });
    expect(w.type).not.toHaveBeenCalled();
  });

  it('an open card the woken chat left alone escalates past QUESTION_WAIT_MS, also while the tab shows `working`', async () => {
    const young = world({ question: question({ created_at: iso(QUESTION_WAIT_MS - 1_000) }), tab: { state: 'working' } });
    await sweepRuns(young.deps);
    expect(young.run.status).toBe('running');
    expect(young.events).toEqual([]);

    const old = world({ question: question({ created_at: iso(QUESTION_WAIT_MS) }), tab: { state: 'working' } });
    await sweepRuns(old.deps);
    expect(old.run).toMatchObject({ status: 'waiting', waiting_reason: QUESTION_UNANSWERED });
    expect(old.type).not.toHaveBeenCalled();
  });

  it('a countdown still running, or one the person cancelled (the card is theirs), is left alone', async () => {
    for (const status of ['scheduled', 'sent', 'cancelled'] as const) {
      const w = world({ question: question({ created_at: iso(QUESTION_WAIT_MS * 3), auto_answer: countdown(status) }) });
      await sweepRuns(w.deps);
      expect(w.run.status).toBe('running');
      expect(w.events).toEqual([]);
      expect(w.type).not.toHaveBeenCalled();
    }
  });

  it('a card that expired while the tab still asks (no hook since) escalates instead of a resume being typed into the question', async () => {
    for (const status of ['expired', 'failed'] as const) {
      const w = world({ question: question({ status, closed_at: iso(30 * 60_000) }), tab: { state: 'waiting_input', state_at: iso(40 * 60_000) } });
      await sweepRuns(w.deps);
      expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: QUESTION_EXPIRED });
      expect(w.kinds()).toEqual(['escalated']);
      expect(w.type).not.toHaveBeenCalled();
    }
  });

  it('a closed card the tab moved past (a newer state), or an agent that exited, follows the usual rules', async () => {
    const moved = world({ question: question({ status: 'expired', closed_at: iso(40 * 60_000) }), tab: { state: 'waiting_input', state_at: iso(30 * 60_000) } });
    await sweepRuns(moved.deps);
    expect(moved.run.status).toBe('running');
    expect(moved.kinds()).toEqual(['run_resumed']);

    const exited = world({ question: question({ status: 'expired', closed_at: iso(30 * 60_000) }), tab: { state: 'idle', state_text: AGENT_EXITED_TEXT, state_at: iso(40 * 60_000) } });
    await sweepRuns(exited.deps);
    expect(exited.restartLine).toHaveBeenCalledTimes(1);
    expect(exited.run.status).toBe('running');
  });

  it('a permission card still open past QUESTION_WAIT_MS escalates as permission_needed; a younger or answered one does not', async () => {
    const young = world({ question: question({ kind: 'permission', payload: { tool_name: 'Bash' }, created_at: iso(QUESTION_WAIT_MS - 1_000) }), tab: { state: 'waiting_permission' } });
    await sweepRuns(young.deps);
    expect(young.run.status).toBe('running');
    expect(young.events).toEqual([]);

    const answered = world({ question: question({ kind: 'permission', payload: { tool_name: 'Bash' }, status: 'answered', created_at: iso(QUESTION_WAIT_MS * 3) }), tab: { state: 'working' } });
    await sweepRuns(answered.deps);
    expect(answered.events).toEqual([]);

    const old = world({ question: question({ kind: 'permission', payload: { tool_name: 'Bash' }, created_at: iso(QUESTION_WAIT_MS) }), tab: { state: 'waiting_permission' } });
    await sweepRuns(old.deps);
    expect(old.run).toMatchObject({ status: 'waiting', waiting_reason: PERMISSION_NEEDED });
    expect(old.kinds()).toEqual(['escalated']);
    expect(old.type).not.toHaveBeenCalled();
    expect(escalationText(PERMISSION_NEEDED, 'en')).toBe("The agent asked for a permission the project's rules do not allow; answer it on the card.");
  });

  it('an answered card or no card at all changes nothing', async () => {
    for (const q of [question({ status: 'answered', closed_at: iso(1_000) }), undefined]) {
      const w = world({ question: q, tab: { state: 'working' } });
      await sweepRuns(w.deps);
      expect(w.run.status).toBe('running');
      expect(w.events).toEqual([]);
    }
  });

  it('a run parked on a question (no card, or past the cap) is never typed into while the tab asks it', async () => {
    for (const reason of [QUESTION_UNANSWERED, 'answer_cap']) {
      const w = world({ run: { status: 'waiting', waiting_reason: reason }, tab: { state: 'waiting_input' } });
      await sweepRuns(w.deps);
      await sweepRuns(w.deps);
      expect(w.type).not.toHaveBeenCalled();
      expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: reason });
    }
  });

  it('both reasons have a text in both languages', () => {
    expect(escalationText(QUESTION_UNANSWERED, 'en')).toBe('The agent asked a question automatic mode could not answer; answer it on the card.');
    expect(escalationText(QUESTION_EXPIRED)).toBe('O card da pergunta do agente fechou sem resposta; responda na aba para continuar.');
    expect(escalationText('answer_cap', 'en')).toBe('The agent asked too many questions answered automatically in the last hour; check the tab and answer on the card.');
  });
});

describe('escalation to the person: the chat line, the slot, the resume (spec §9.3, TER-888)', () => {
  const owned = (w: ReturnType<typeof world>) => ({ repos: w.repos, scoped: { project: vi.fn(async () => ({})) } }) as unknown as ControlContext;
  const lines = (w: ReturnType<typeof world>) => vi.mocked(w.repos.chat.addMessage).mock.calls.map((c) => c[0]);

  it("a card-less escalation posts 'Automático parou em <ref>: <motivo>' in the project chat and tells its screens", async () => {
    const w = world({ run: { resume_count: 3 } });
    const published: ChatEvent[] = [];
    const off = chatBus.subscribe((e) => void published.push(e));
    try {
      await followRun(w.deps, w.run.id); // no waker: the cap escalates at once
    } finally {
      off();
    }
    expect(lines(w)).toEqual([{ conversation_id: 'cp', role: 'assistant', text: 'Automático parou em TER-1: O agente parou várias vezes sem terminar e o chat não soube continuar; confira a aba.' }]);
    expect(published).toEqual([expect.objectContaining({ type: 'message', user_id: 'u1', conversation_id: 'cp' })]);
  });

  it("the chat's own words (escalate_automation_run) show on the line, never in the event", async () => {
    const w = world({ run: { resume_count: 3 } });
    await escalateAutomationRun(owned(w), { run_id: w.run.id, reason: 'O teste falha e não sei por quê.' });
    expect(lines(w)[0]).toMatchObject({ text: 'Automático parou em TER-1: O teste falha e não sei por quê.' });
    expect(JSON.stringify(w.events)).not.toContain('não sei por quê');
  });

  it("an escalation about a question answers that card: 'Automático parou aqui: <motivo>', in the card's conversation", async () => {
    const card = { id: 'q9', tab_id: 'tab1', conversation_id: 'c-card', user_id: 'u1', kind: 'choice', status: 'open' } as unknown as TabQuestion;
    const w = world({ question: card });
    w.tab.name = 'api';
    const { escalate } = await import('./answers.js');
    await escalate({ repos: w.repos }, { ...w.run }, QUESTION_UNANSWERED);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: QUESTION_UNANSWERED });
    expect(lines(w)).toEqual([
      {
        conversation_id: 'c-card',
        role: 'assistant',
        text: 'Automático parou aqui: O agente fez uma pergunta que o modo automático não soube responder; responda no card.',
        reply_to: { id: null, role: 'assistant', excerpt: 'Card da aba api', card: { kind: 'tab_question', id: 'q9' } },
      },
    ]);
  });

  it('no active project chat: one is opened for the line, so the person is always told (review I3)', async () => {
    const w = world({ run: { resume_count: 3 }, conversation: null });
    await followRun(w.deps, w.run.id);
    expect(w.kinds()).toEqual(['escalated']);
    expect(w.repos.chat.getOrCreateForProject).toHaveBeenCalledWith('u1', 'p1');
    expect(lines(w)).toEqual([expect.objectContaining({ conversation_id: 'c-new', text: expect.stringContaining('Automático parou em TER-1:') })]);
  });

  it('the line never answers an older answered card, nor one in an archived conversation: it stands alone (review M1)', async () => {
    const { escalate } = await import('./answers.js');
    for (const card of [
      { id: 'q1', tab_id: 'tab1', conversation_id: 'c-card', user_id: 'u1', kind: 'choice', status: 'answered' },
      { id: 'q2', tab_id: 'tab1', conversation_id: 'c-archived', user_id: 'u1', kind: 'choice', status: 'open' },
      { id: 'q3', tab_id: 'tab1', conversation_id: 'c-card', user_id: 'other', kind: 'choice', status: 'open' },
    ]) {
      const w = world({ question: card as unknown as TabQuestion });
      await escalate({ repos: w.repos }, { ...w.run }, QUESTION_UNANSWERED);
      expect(lines(w)).toEqual([expect.objectContaining({ conversation_id: 'cp', text: expect.stringContaining('Automático parou em TER-1:') })]);
    }
  });

  it('question_expired answers the card that closed unanswered', async () => {
    const card = { id: 'q4', tab_id: 'tab1', conversation_id: 'c-card', user_id: 'u1', kind: 'choice', status: 'expired' } as unknown as TabQuestion;
    const w = world({ question: card });
    const { escalate } = await import('./answers.js');
    await escalate({ repos: w.repos }, { ...w.run }, QUESTION_EXPIRED);
    expect(lines(w)[0]).toMatchObject({ conversation_id: 'c-card', reply_to: { card: { kind: 'tab_question', id: 'q4' } } });
  });

  it('a run already parked for the same reason is not escalated again (no second event, no second push)', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: QUESTION_UNANSWERED } });
    const { escalate } = await import('./answers.js');
    expect(await escalate({ repos: w.repos }, { ...w.run }, QUESTION_UNANSWERED)).toBe(false);
    expect(w.events).toEqual([]);
    expect(await escalate({ repos: w.repos }, { ...w.run }, PERMISSION_NEEDED)).toBe(true);
    expect(w.kinds()).toEqual(['escalated']);
  });

  it('the line is in the owner\'s language', async () => {
    const w = world({ run: { resume_count: 3 } });
    vi.mocked(w.repos.users.findById).mockResolvedValue({ id: 'u1', locale: 'en' } as never);
    await followRun(w.deps, w.run.id);
    expect(lines(w)[0]).toMatchObject({ text: 'Automatic work stopped at TER-1: The agent stopped several times without finishing and the chat could not carry on; check the tab.' });
  });

  it('every escalation reason frees the slot; waiting on a usage limit does not', () => {
    for (const r of ['needs_person', 'question_unanswered', 'question_expired', 'answer_cap', 'permission_needed', 'resume_cap']) expect(SLOT_FREE_REASONS).toContain(r);
    expect(SLOT_FREE_REASONS).not.toContain('quota');
  });

  it.each([QUESTION_UNANSWERED, QUESTION_EXPIRED, PERMISSION_NEEDED, ANSWER_CAP])(
    '%s: once the card is answered (or the person acts in the tab) the run goes back to running and is followed',
    async (reason) => {
      const w = world({ run: { status: 'waiting', waiting_reason: reason }, tab: { state: 'working', state_at: '2026-10-05T11:59:00.000Z' }, escalatedAt: '2026-10-05T11:50:00.000Z' });
      await sweepRuns(w.deps);
      expect(w.run).toMatchObject({ status: 'running', waiting_reason: null });
      expect(w.events).toEqual([expect.objectContaining({ kind: 'run_resumed', payload: { tab_id: 'tab1', by: 'person', reason } })]);
      expect(w.type).not.toHaveBeenCalled(); // working: the agent's own time
    },
  );

  it.each([QUESTION_UNANSWERED, PERMISSION_NEEDED, ANSWER_CAP])('%s: still waiting while the card is open, or the tab has not moved since the escalation', async (reason) => {
    const open = world({ run: { status: 'waiting', waiting_reason: reason }, tab: { state: 'working', state_at: '2026-10-05T11:59:00.000Z' }, escalatedAt: '2026-10-05T11:50:00.000Z', openQuestion: true });
    await sweepRuns(open.deps);
    expect(open.run.status).toBe('waiting');
    const still = world({ run: { status: 'waiting', waiting_reason: reason }, tab: { state: 'waiting_input', state_at: '2026-10-05T11:40:00.000Z' }, escalatedAt: '2026-10-05T11:50:00.000Z' });
    await sweepRuns(still.deps);
    expect(still.run.status).toBe('waiting');
    expect(still.type).not.toHaveBeenCalled();
  });

  it('needs_person (the trust question) also goes back to running once the tab moves', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: 'needs_person' }, tab: { state: 'working' } });
    await sweepRuns(w.deps);
    expect(w.run).toMatchObject({ status: 'running', waiting_reason: null });
  });

  it('a resume cap is not resumed by itself: resume_automation_run hands it back with a fresh budget', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: 'resume_cap', resume_count: 3 }, tab: { state: 'working', state_at: '2026-10-05T11:59:00.000Z' }, escalatedAt: '2026-10-05T11:50:00.000Z' });
    await sweepRuns(w.deps);
    expect(w.run.status).toBe('waiting');
    const resumeWaiting = vi.fn(async (_id: string, opts: { fresh?: boolean }) => {
      Object.assign(w.run, { status: 'running', waiting_reason: null, ...(opts.fresh ? { resume_count: 0, woken_at: null } : {}) });
      return true;
    });
    Object.assign(w.repos.automationRuns, { resumeWaiting });
    await expect(resumeAutomationRun(owned(w), { run_id: w.run.id })).resolves.toEqual({ ok: true, resumed: true });
    expect(resumeWaiting).toHaveBeenCalledWith(w.run.id, { fresh: true });
    expect(w.run).toMatchObject({ status: 'running', resume_count: 0 });
    expect(w.kinds()).toEqual(['run_resumed']);
    // running already: nothing to do
    await expect(resumeAutomationRun(owned(w), { run_id: w.run.id })).resolves.toEqual({ ok: true, resumed: false });
    expect(resumeWaiting).toHaveBeenCalledTimes(1);
  });

  it('resume_automation_run leaves a run waiting on its account limit alone (review M4)', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: 'quota' } });
    const resumeWaiting = vi.fn(async () => true);
    Object.assign(w.repos.automationRuns, { resumeWaiting });
    await expect(resumeAutomationRun(owned(w), { run_id: w.run.id })).resolves.toEqual({ ok: true, resumed: false });
    expect(resumeWaiting).not.toHaveBeenCalled();
  });

  it('resume_automation_run: another owner\'s run is not found, an ended one is refused', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: QUESTION_UNANSWERED } });
    const foreign = { repos: w.repos, scoped: { project: vi.fn(async () => { throw new Error('NOT_FOUND'); }) } } as unknown as ControlContext;
    await expect(resumeAutomationRun(foreign, { run_id: w.run.id })).rejects.toThrow('NOT_FOUND');
    expect(w.run.status).toBe('waiting');
    w.run.status = 'done';
    await expect(resumeAutomationRun(owned(w), { run_id: w.run.id })).rejects.toThrow('Esta execução automática já terminou');
  });

  it('an agent that exits again while paused: the run ends blocked and the person is told, nothing typed', async () => {
    const w = world({ run: { restart_count: 1 }, tab: { state: 'idle', state_text: AGENT_EXITED_TEXT }, paused: true });
    await followRun(w.deps, w.run.id);
    expect(w.run.status).toBe('blocked');
    expect(w.kinds()).toEqual(['run_blocked', 'escalated']);
    expect(w.typeLine).not.toHaveBeenCalled();
    expect(lines(w)[0]).toMatchObject({ text: 'Automático parou em TER-1: O agente saiu de novo depois de reiniciado; confira a aba.' });
  });

  it("report_card blocked: the agent's reason shows on the line", async () => {
    const w = world();
    await reportCard(tabCtx(w.repos), { status: 'blocked', reason: 'Falta a chave da API.' });
    expect(lines(w)[0]).toMatchObject({ text: 'Automático parou em TER-1: Falta a chave da API.' });
  });
});

describe('runs that must end (final review I1, I2)', () => {
  it('a running run whose tab was closed ends cancelled: nothing typed, the card and slot free, an event', async () => {
    const w = world();
    vi.mocked(w.repos.tabs.findById).mockResolvedValue(undefined);
    await followRun(w.deps, w.run.id);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'cancelled', waiting_reason: TAB_CLOSED });
    expect(w.run.ended_at).toBeInstanceOf(Date);
    expect(w.events).toEqual([expect.objectContaining({ kind: 'run_cancelled', run_id: w.run.id, payload: { reason: TAB_CLOSED, tab_id: 'tab1' } })]);
    // ended: a later sweep finds nothing to follow
    await sweepRuns(w.deps);
    expect(w.events).toHaveLength(1);
  });

  it('a run parked for the person whose tab was closed ends the same way', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: 'permission_needed' } });
    vi.mocked(w.repos.tabs.findById).mockResolvedValue(undefined);
    await sweepRuns(w.deps);
    expect(w.run).toMatchObject({ status: 'cancelled', waiting_reason: TAB_CLOSED });
  });

  it('a parked run whose card lost its tag is cancelled, even while the tab works', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: 'resume_cap' }, task: { auto: false }, tab: { state: 'working' } });
    await sweepRuns(w.deps);
    expect(w.run).toMatchObject({ status: 'cancelled', waiting_reason: UNTAGGED });
    expect(w.kinds()).toEqual(['run_cancelled']);
    expect(w.type).not.toHaveBeenCalled();
  });

  it('a parked run on a card still tagged stays parked', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: 'resume_cap' } });
    await sweepRuns(w.deps);
    expect(w.run.status).toBe('waiting');
    expect(w.events).toEqual([]);
  });

  it('a running run on an untagged card is cancelled at its stop, with the event too', async () => {
    const w = world({ task: { auto: false } });
    await followRun(w.deps, w.run.id);
    expect(w.run).toMatchObject({ status: 'cancelled', waiting_reason: UNTAGGED });
    expect(w.kinds()).toEqual(['run_cancelled']);
  });

  it('cancelRun ends a run once', async () => {
    const w = world();
    expect(await cancelRun(w.repos, { ...w.run }, TAB_CLOSED)).toBe(true);
    expect(await cancelRun(w.repos, { ...w.run }, TAB_CLOSED)).toBe(false);
    expect(w.kinds()).toEqual(['run_cancelled']);
  });

  it('a PR from the run\'s branch merged while the run was on ends it done (parked or at a stop)', async () => {
    const later = new Date(Date.now() + 60_000);
    for (const status of ['running', 'waiting'] as const) {
      const w = world({ run: { status, waiting_reason: status === 'waiting' ? 'permission_needed' : null }, prs: [{ state: 'merged', head_ref: 'TER-1-card', url: 'u', number: 4, merged_at: later }] });
      await followRun(w.deps, w.run.id);
      expect(w.run.status).toBe('done');
      expect(w.type).not.toHaveBeenCalled();
    }
  });

  it('a PR of the branch merged before the run began says nothing about it', async () => {
    const w = world({ prs: [{ state: 'merged', head_ref: 'TER-1-card', url: 'u', number: 4, merged_at: new Date('2026-01-01T00:00:00Z') }] });
    await followRun(w.deps, w.run.id);
    expect(w.run.status).toBe('running');
    expect(w.type).toHaveBeenCalledTimes(1);
  });

  it('endRunsOfMergedCard ends the card\'s running or waiting run done, with no pr_opened and the card left where the merge put it', async () => {
    const w = world({ run: { status: 'waiting', waiting_reason: 'permission_needed' }, task: { status: 'todo', tab_id: null } });
    (w.repos.automationRuns as unknown as { activeByProject: unknown }).activeByProject = vi.fn(async () => [{ ...w.run }]);
    expect(await endRunsOfMergedCard(w.repos, 'p1', 't1', { url: 'u', number: 4 })).toBe(1);
    expect(w.run.status).toBe('done');
    expect(w.kinds()).toEqual(['run_done']);
    expect(w.events[0]!.payload).toMatchObject({ via: 'merged', pr_url: 'u' });
    expect(w.repos.tasks.setTab).not.toHaveBeenCalled();
    expect(w.repos.tasks.startWork).not.toHaveBeenCalled();
    // another card's run is left alone
    expect(await endRunsOfMergedCard(w.repos, 'p1', 't-other', { url: 'u', number: 4 })).toBe(0);
  });
});

describe('GitHub errors and the trust question do not stop the run (TER-1025)', () => {
  /** A world whose setup allows `retries` GitHub waits; `waits` already recorded; the last one `minutesAgo`. */
  function github(o: { retries?: number; waits?: number; minutesAgo?: number; degraded?: string[]; run?: Partial<AutomationRun>; tab?: Partial<Tab>; paused?: boolean } = {}) {
    const w = world({ run: o.run, tab: o.tab, paused: o.paused });
    const now = new Date('2026-10-05T12:00:00.000Z');
    const events = w.repos.automationEvents as unknown as Record<string, unknown>;
    events.countForRun = vi.fn(async (_id: string, kind: string) => (kind === 'github_wait' ? (o.waits ?? 0) : 0));
    events.lastForRun = vi.fn(async (_id: string, kind: string) =>
      kind === 'github_wait' && o.waits ? { kind, payload: { attempt: o.waits }, created_at: new Date(now.getTime() - (o.minutesAgo ?? 6) * 60_000).toISOString() } : null,
    );
    (w.repos.projectSetup as unknown as { get: unknown }).get = vi.fn(async () => ({ data: { automation: { enabled: true, resume_max: 3, allowed_tools: null, daily_budget_usd: null, card_budget_usd: null, github_retries: o.retries ?? 3 } } }));
    w.deps.githubHealth = async () => ({ degraded: o.degraded ?? [] });
    return w;
  }
  const failure = 'push: HTTP 500 (commit_refs)';

  it('report_card blocked with github_transient parks the run for GitHub: no escalation on the first failure', async () => {
    const w = github();
    await reportCard(tabCtx(w.repos), { status: 'blocked', reason: failure, code: 'github_transient' });
    expect(w.run.status).toBe('waiting');
    expect(w.run.waiting_reason).toBe('github_transient');
    expect(w.kinds()).toEqual(['github_wait']);
    expect(w.events[0]!.payload).toMatchObject({ reason: 'github_transient', attempt: 1 });
  });

  it('past github_retries it ends blocked and the person is told', async () => {
    const w = github({ waits: 3 });
    await reportCard(tabCtx(w.repos), { status: 'blocked', reason: failure, code: 'github_transient' });
    expect(w.run.status).toBe('blocked');
    expect(w.kinds()).toEqual(['run_blocked', 'escalated']);
    expect(w.events[1]!.payload).toMatchObject({ reason: 'github_transient' });
  });

  it('a parked run is resumed after its delay once GitHub works, with the retry message', async () => {
    const w = github({ waits: 1, minutesAgo: 6, run: { status: 'waiting', waiting_reason: 'github_transient' } });
    await followRun(w.deps, w.run.id);
    expect(w.run.status).toBe('running');
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.type.mock.calls[0]![2]).toContain('O GitHub voltou a responder');
    expect(w.events).toEqual([expect.objectContaining({ kind: 'run_resumed', payload: expect.objectContaining({ by: 'github', reason: 'github_transient', count: 1 }) })]);
  });

  it('waits while the delay runs, while GitHub reports trouble, and while paused', async () => {
    for (const o of [{ minutesAgo: 2 }, { degraded: ['Git Operations'] }, { paused: true }]) {
      const w = github({ waits: 1, minutesAgo: 6, ...o, run: { status: 'waiting', waiting_reason: 'github_transient' } });
      await followRun(w.deps, w.run.id);
      expect(w.run.status).toBe('waiting');
      expect(w.type).not.toHaveBeenCalled();
    }
  });

  it('a start with no hook whose screen shows the trust question is answered, not escalated', async () => {
    const w = world({ tab: { state_at: null, state: null }, run: { started_at: new Date('2026-10-05T11:59:00.000Z') } });
    (w.repos.automationEvents as unknown as Record<string, unknown>).countForRun = vi.fn(async () => 0);
    const acceptTrust = vi.fn(async () => true);
    w.deps.acceptTrust = acceptTrust;
    await followRun(w.deps, w.run.id);
    expect(acceptTrust).toHaveBeenCalledTimes(1);
    expect(w.run.status).toBe('running');
    expect(w.kinds()).toEqual(['trust_auto_accepted']);
  });

  it('a trust question nothing could answer still goes to the person after TRUST_WAIT_MS', async () => {
    const w = world({ tab: { state_at: null, state: null }, run: { started_at: new Date(Date.parse('2026-10-05T12:00:00.000Z') - TRUST_WAIT_MS) } });
    (w.repos.automationEvents as unknown as Record<string, unknown>).countForRun = vi.fn(async () => 0);
    w.deps.acceptTrust = vi.fn(async () => false);
    w.deps.foreground = async () => 'other' as never;
    await followRun(w.deps, w.run.id);
    expect(w.run.waiting_reason).toBe('needs_person');
    expect(w.events.at(-1)).toMatchObject({ kind: 'escalated', payload: expect.objectContaining({ reason: 'trust_prompt' }) });
  });
});
