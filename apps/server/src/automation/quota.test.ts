import { describe, expect, it, vi } from 'vitest';
import type { AiAccountUsage } from '../ai/index.js';
import type { ControlContext } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { AutomationEventInput } from '../db/repositories/automation-events.js';
import type { Tab, Task } from '../db/repositories/types.js';
import { RATE_LIMIT_TEXT } from '../monitor/state.js';
import { followRun, sweepRuns, type FollowerDeps } from './follower.js';
import { QUOTA_RESUME_TEXT, serverMessage } from './prompts.js';
import { onRateLimit, QUOTA_FALLBACK_MS, resetAt, resumeAfterReset } from './quota.js';

const ME = 'instance-me';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const usage = (windows: Array<{ utilization: number; resets_at: string | null }>, ok = true): AiAccountUsage =>
  ({ account_id: 'a1', fetched_at: NOW.toISOString(), ok, plan: null, error: null, hint: null, windows: windows.map((w, i) => ({ key: `w${i}`, label: `w${i}`, ...w })) }) as AiAccountUsage;

describe('resetAt (spec D16)', () => {
  it('picks the soonest reset still ahead', () => {
    const u = usage([
      { utilization: 40, resets_at: at(5 * 3600_000).toISOString() },
      { utilization: 60, resets_at: at(2 * 3600_000).toISOString() },
      { utilization: 10, resets_at: at(-60_000).toISOString() }, // already past
    ]);
    expect(resetAt(u, NOW)).toEqual(at(2 * 3600_000));
  });

  it('with a full window, waits for the full ones: an earlier reset of a window with room does not free the account', () => {
    const u = usage([
      { utilization: 30, resets_at: at(3600_000).toISOString() },
      { utilization: 100, resets_at: at(3 * 24 * 3600_000).toISOString() },
    ]);
    expect(resetAt(u, NOW)).toEqual(at(3 * 24 * 3600_000));
  });

  it('unknown usage, a failed reading or no reset ahead → one hour', () => {
    for (const u of [null, usage([], false), usage([{ utilization: 100, resets_at: null }]), usage([{ utilization: 100, resets_at: at(-1).toISOString() }])]) {
      expect(resetAt(u, NOW)).toEqual(at(QUOTA_FALLBACK_MS));
    }
  });
});

/** One running run in a tab stuck on the usage limit of account a1, and fakes that keep what is written. */
function world(o: { exhausted?: Map<string, Date>; paused?: boolean; enabled?: boolean; task?: Partial<Task>; usage?: AiAccountUsage | null; machineSwaps?: boolean; dailyBudget?: number | null; daySpent?: number } = {}) {
  const run: AutomationRun = {
    id: `run-${Math.random().toString(36).slice(2)}`, project_id: 'p1', task_id: 't1', role: 'implementer', status: 'running', waiting_reason: null, tab_id: 'tab1', machine_id: 'm1',
    account_id: 'a1', branch: 'TER-1-card', worktree_path: '/w/TER-1', resume_count: 0, fix_count: 0, restart_count: 0, claimed_by: ME, heartbeat_at: NOW, started_at: NOW,
    ended_at: null, created_at: NOW, allowed_tools: null, last_typed_at: null, woken_at: null,
  };
  const tab = {
    id: 'tab1', project_id: 'p1', machine_id: 'm1', ai_account_id: 'a1', state: 'waiting_input', state_text: `${RATE_LIMIT_TEXT} — volta às 15h`, state_tool: 'claude',
    state_at: '2026-10-05T11:59:50.000Z', rate_limited_at: '2026-10-05T11:59:50.000Z',
  } as Tab;
  const task = { id: 't1', project_id: 'p1', ref: 'TER-1', title: 'Card', type: 'task', status: 'doing', tab_id: 'tab1', auto: true, parent_id: null, epic_id: null, column_id: 'c2', ...o.task } as Task;
  const exhausted = o.exhausted ?? new Map<string, Date>();
  const events: AutomationEventInput[] = [];
  const messages: string[] = [];
  let paused = o.paused ?? false;
  let enabled = o.enabled ?? true;
  const isActive = () => ['queued', 'starting', 'running', 'waiting'].includes(run.status);
  const write = (instance: string, patch: Partial<AutomationRun>) => {
    if (instance !== run.claimed_by || !isActive()) return false;
    Object.assign(run, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return true;
  };
  const repos = {
    automationRuns: {
      findById: vi.fn(async () => ({ ...run })),
      followedBy: vi.fn(async (instance: string) => (instance === run.claimed_by && ['running', 'waiting'].includes(run.status) ? [{ ...run }] : [])),
      update: vi.fn(async (_id: string, instance: string, patch: Partial<AutomationRun>) => write(instance, patch)),
      updateActive: vi.fn(async (_id: string, instance: string, patch: Partial<AutomationRun>) => write(instance, patch)),
      bump: vi.fn(async (_id: string, field: 'resume_count' | 'restart_count') => ++run[field]),
      noteTyped: vi.fn(async (_id: string, at: Date) => void (run.last_typed_at = at)),
    },
    aiAccountExhaustions: {
      mark: vi.fn(async (id: string, until: Date) => void exhausted.set(id, until)),
      activeIds: vi.fn(async (now: Date) => new Set([...exhausted].filter(([, until]) => until > now).map(([id]) => id))),
    },
    tabs: { findById: vi.fn(async () => ({ ...tab })) },
    tabQuestions: { hasOpenQuestion: vi.fn(async () => false), latestQuestionForTab: vi.fn(async () => undefined) },
    taskPullRequests: { listByTasks: vi.fn(async () => []) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    projectSetup: { get: vi.fn(async () => ({ data: { automation: { enabled, resume_max: 3, allowed_tools: null, daily_budget_usd: o.dailyBudget ?? null, card_budget_usd: null } } })) },
    automationPauses: { state: vi.fn(async () => ({ user: paused ? NOW : null, project: null })) },
    users: { findById: vi.fn(async () => ({ id: 'u1' })) },
    tabUsage: { ownerTimeZone: vi.fn(async () => null), costOfDay: vi.fn(async () => o.daySpent ?? 0) },
    aiAccounts: { findById: vi.fn(async () => ({ id: 'a1', label: 'pessoal' })) },
    chat: { findLatestActiveForProject: vi.fn(async () => ({ id: 'c1' })), addMessage: vi.fn(async (m: { text: string }) => (messages.push(m.text), { id: 'm', ...m })) },
    tasks: { findById: vi.fn(async () => task) },
    automationEvents: { insertOnce: vi.fn(async (e: AutomationEventInput) => (events.some((x) => x.kind === e.kind && x.payload?.day === e.payload?.day) ? null : (events.push(e), { ...e, id: `e${events.length}`, created_at: '' }))), insert: vi.fn(async (e: AutomationEventInput) => (events.push(e), { ...e, id: `e${events.length}`, created_at: '' })) },
  } as unknown as Repositories;
  const type = vi.fn(async (_ctx: ControlContext, _tabId: string, _text: string) => {});
  const accountUsage = vi.fn(async () => (o.usage === undefined ? usage([{ utilization: 100, resets_at: at(2 * 3600_000).toISOString() }]) : o.usage));
  let now = NOW;
  const deps: FollowerDeps = { repos, instance: ME, lifecycle: { draining: false }, type, accountUsage, settleMs: 0, now: () => now };
  deps.onRateLimited = (r, t) => onRateLimit(deps, r, t);
  return {
    run, tab, task, events, messages, repos, deps, type, exhausted, accountUsage,
    setNow: (d: Date) => (now = d),
    setPaused: (p: boolean) => (paused = p),
    setEnabled: (e: boolean) => (enabled = e),
    kinds: () => events.map((e) => e.kind),
  };
}

describe('a run on a usage limit (spec D16)', () => {
  it('marks the account until the reset, parks the run on quota and types nothing', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    expect(w.exhausted.get('a1')).toEqual(at(2 * 3600_000));
    expect(w.repos.aiAccountExhaustions.mark).toHaveBeenCalledWith('a1', at(2 * 3600_000), 'rate_limit');
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'quota', account_id: 'a1' });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'quota_hit', run_id: w.run.id, payload: { account_id: 'a1', tab_id: 'tab1', until: at(2 * 3600_000).toISOString() } })]);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.messages).toEqual([expect.stringMatching(/^Conta pessoal no limite até \d{2}:\d{2}$/)]);
  });

  it('stops looping: repeated sweeps before the reset mark nothing, record nothing and type nothing', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    for (let i = 1; i <= 5; i++) {
      w.setNow(at(i * 20 * 60_000)); // every 20 min, still before the 2 h reset
      await sweepRuns(w.deps);
      await resumeAfterReset(w.deps);
    }
    expect(w.repos.aiAccountExhaustions.mark).toHaveBeenCalledTimes(1);
    expect(w.kinds()).toEqual(['quota_hit']);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('waiting');
  });

  it('is idempotent when called again on the same limit (the follower calls it on every look)', async () => {
    const w = world();
    await onRateLimit(w.deps, { ...w.run }, w.tab);
    await onRateLimit(w.deps, { ...w.run, status: 'running' }, w.tab);
    expect(w.repos.aiAccountExhaustions.mark).toHaveBeenCalledTimes(1);
    expect(w.kinds()).toEqual(['quota_hit']);
  });

  it('an account another run already marked keeps its deadline', async () => {
    const w = world({ exhausted: new Map([['a1', at(30 * 60_000)]]) });
    await followRun(w.deps, w.run.id);
    expect(w.repos.aiAccountExhaustions.mark).not.toHaveBeenCalled();
    expect(w.exhausted.get('a1')).toEqual(at(30 * 60_000));
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'quota' });
    expect(w.kinds()).toEqual(['quota_hit']);
  });

  it('unknown usage waits one hour', async () => {
    const w = world({ usage: null });
    await followRun(w.deps, w.run.id);
    expect(w.exhausted.get('a1')).toEqual(at(QUOTA_FALLBACK_MS));
  });

  it('after the reset it is resumed once, with the marked message, and the follower does not park it again on the old screen', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    w.setNow(at(2 * 3600_000 + 1000));
    await resumeAfterReset(w.deps);
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.type.mock.calls[0]![1]).toBe('tab1');
    expect(w.type.mock.calls[0]![2]).toBe(serverMessage(QUOTA_RESUME_TEXT));
    expect(w.run).toMatchObject({ status: 'running', waiting_reason: null });
    expect(w.kinds()).toEqual(['quota_hit', 'quota_reset']);
    // the limit screen is still there until the agent reacts: neither a new limit nor a second resume
    await sweepRuns(w.deps);
    await resumeAfterReset(w.deps);
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.kinds()).toEqual(['quota_hit', 'quota_reset']);
    expect(w.run.status).toBe('running');
  });

  it('a day at its budget holds the resume after the reset; the run keeps waiting on quota (TER-892)', async () => {
    const w = world({ dailyBudget: 5, daySpent: 5 });
    await followRun(w.deps, w.run.id);
    w.setNow(at(2 * 3600_000 + 1000));
    await resumeAfterReset(w.deps);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'quota' });
  });

  it('a resume that could not be typed goes back to waiting on quota, marks nothing and is tried again', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    w.setNow(at(2 * 3600_000 + 1000));
    w.type.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'MACHINE_OFFLINE' }));
    await resumeAfterReset(w.deps);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'quota' });
    expect(w.kinds()).toEqual(['quota_hit']);
    // the follower 10 min later does not read the old screen as a new limit
    w.setNow(at(2 * 3600_000 + 11 * 60_000));
    await sweepRuns(w.deps);
    expect(w.repos.aiAccountExhaustions.mark).toHaveBeenCalledTimes(1);
    await resumeAfterReset(w.deps);
    expect(w.type).toHaveBeenCalledTimes(2);
    expect(w.run).toMatchObject({ status: 'running', waiting_reason: null });
    expect(w.kinds()).toEqual(['quota_hit', 'quota_reset']);
  });

  it('a new limit after the resume parks it again (never a resume into the limit)', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    w.setNow(at(2 * 3600_000 + 1000));
    await resumeAfterReset(w.deps);
    Object.assign(w.tab, { state_at: at(2 * 3600_000 + 60_000).toISOString(), rate_limited_at: at(2 * 3600_000 + 60_000).toISOString() });
    w.accountUsage.mockResolvedValue(usage([{ utilization: 100, resets_at: at(7 * 3600_000).toISOString() }]));
    w.setNow(at(2 * 3600_000 + 120_000));
    await sweepRuns(w.deps);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'quota' });
    expect(w.exhausted.get('a1')).toEqual(at(7 * 3600_000));
    expect(w.type).toHaveBeenCalledTimes(1);
  });

  it('is not resumed before the reset (the account is still exhausted)', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    w.setNow(at(3600_000));
    await resumeAfterReset(w.deps);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('waiting');
  });

  it('paused at the reset: nothing is typed until the pause is lifted', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    w.setNow(at(2 * 3600_000 + 1000));
    w.setPaused(true);
    await resumeAfterReset(w.deps);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('waiting');
    w.setPaused(false);
    await resumeAfterReset(w.deps);
    expect(w.type).toHaveBeenCalledTimes(1);
  });

  it('a project whose automation was turned off meanwhile is never typed into (D3)', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    w.setEnabled(false);
    w.setNow(at(2 * 3600_000 + 1000));
    await resumeAfterReset(w.deps);
    await sweepRuns(w.deps);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run.status).toBe('waiting');
  });

  it('a card untagged meanwhile is not resumed: its run ends', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    w.task.auto = false;
    w.setNow(at(2 * 3600_000 + 1000));
    await resumeAfterReset(w.deps);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'cancelled', waiting_reason: 'untagged' });
  });

  it('a tab that already moved on after the reset is not typed into; the run just follows again', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    Object.assign(w.tab, { state: 'working', state_text: null, rate_limited_at: null });
    w.setNow(at(2 * 3600_000 + 1000));
    await resumeAfterReset(w.deps);
    expect(w.type).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'running', waiting_reason: null });
    expect(w.events.at(-1)).toMatchObject({ kind: 'quota_reset', payload: { account_id: 'a1', tab_id: 'tab1', typed: false } });
  });
});

describe('a run whose tab the automatic swap moved to another account (preflight F-12)', () => {
  it('parked before the swap finished: the run takes the new account and runs again, nothing typed', async () => {
    const w = world();
    await followRun(w.deps, w.run.id);
    // autoSwapOnLimit: new account, limit cleared, its own resume line already typed
    Object.assign(w.tab, { ai_account_id: 'a2', rate_limited_at: null, state_text: 'Conta trocada automaticamente: A → B.', state_at: at(20_000).toISOString() });
    w.setNow(at(30_000)); // long before a1's reset
    await resumeAfterReset(w.deps);
    expect(w.run).toMatchObject({ status: 'running', waiting_reason: null, account_id: 'a2' });
    expect(w.type).not.toHaveBeenCalled();
    expect(w.kinds()).toEqual(['quota_hit']);
  });

  it('seen while the swap is writing the tab: the run takes the new account and is not parked', async () => {
    const w = world();
    // the swap wrote the account and cleared the limit; the limit text is still the tab's state
    Object.assign(w.tab, { ai_account_id: 'a2', rate_limited_at: null });
    await followRun(w.deps, w.run.id);
    expect(w.run).toMatchObject({ status: 'running', account_id: 'a2' });
    expect(w.repos.aiAccountExhaustions.mark).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
    expect(w.type).not.toHaveBeenCalled();
  });

  it('a limit on the new account: the run takes it and waits for its reset', async () => {
    const w = world();
    Object.assign(w.tab, { ai_account_id: 'a2' });
    await followRun(w.deps, w.run.id);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: 'quota', account_id: 'a2' });
    expect(w.exhausted.has('a2')).toBe(true);
    expect(w.exhausted.has('a1')).toBe(false);
  });
});
