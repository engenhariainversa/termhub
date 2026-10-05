import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { setupSchema } from '../setup/schema.js';
import { dispatcherInstanceId, startDispatcher, TICK_MS, TRIGGER_DEBOUNCE_MS, type DispatcherDeps } from './dispatcher.js';
import { automationBus, dispatchTriggers } from './events.js';

/** Repositories that record every call and answer only what `impl` defines (anything else throws). */
function recordingRepos(impl: Record<string, Record<string, (...args: never[]) => unknown>> = {}) {
  const calls: string[] = [];
  const repos = new Proxy(
    {},
    {
      get: (_t, repo: string) =>
        new Proxy(
          {},
          {
            get: (_u, method: string) =>
              (...args: never[]) => {
                calls.push(`${repo}.${method}`);
                const f = impl[repo]?.[method];
                if (!f) throw new Error(`unexpected call ${repo}.${method}`);
                return f(...args);
              },
          },
        ),
    },
  ) as Repositories;
  return { repos, calls };
}

function deps(repos: Repositories, over: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    repos,
    instance: 'test',
    lifecycle: { draining: false },
    now: () => new Date(),
    startAgent: vi.fn() as unknown as DispatcherDeps['startAgent'],
    ensureWorkspace: vi.fn() as unknown as DispatcherDeps['ensureWorkspace'],
    ensureEpicBranch: vi.fn() as unknown as DispatcherDeps['ensureEpicBranch'],
    gh: {} as GithubWriteClient,
    usage: vi.fn(async () => null),
    log: { info: () => {}, warn: (o, m) => console.warn(m, o) },
    ...over,
  };
}

/** No project has automation on: the sweep finds nothing and the list is empty. */
const idle = () => ({
  automationRuns: { cancelOrphaned: async () => [], heartbeat: async () => {}, takeOver: async () => [], dueCleanups: async () => [] },
  projectSetup: { listWithAutomation: async () => [] },
});

describe('startDispatcher (fakes)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a draining instance reads and writes nothing on a tick, and takes over no run', async () => {
    const { repos, calls } = recordingRepos(idle());
    const d = startDispatcher(deps(repos, { lifecycle: { draining: true } }), { schedule: false });
    await d.tick('t');
    await d.heartbeat();
    await d.stop();
    expect(calls).toEqual(['automationRuns.heartbeat']); // its own runs stay alive until it exits
  });

  it('tells the follower of each running run it took over, and releases the unstarted ones', async () => {
    const running = { id: 'r1', status: 'running', task_id: 't1', tab_id: 'tab1' };
    const queued = { id: 'r2', status: 'queued', task_id: 't2', tab_id: null };
    const { repos } = recordingRepos({ ...idle(), automationRuns: { ...idle().automationRuns, takeOver: async () => [running, queued], release: async () => true } });
    const onTakeOver = vi.fn();
    const d = startDispatcher(deps(repos, { onTakeOver }), { schedule: false });
    await d.heartbeat();
    await d.stop();
    expect(onTakeOver).toHaveBeenCalledTimes(1);
    expect(onTakeOver).toHaveBeenCalledWith(running);
  });

  it('with no project on automation, a tick only runs the sweep and lists the enabled projects', async () => {
    const { repos, calls } = recordingRepos(idle());
    const startAgent = vi.fn();
    const room = vi.fn(async () => true);
    const d = startDispatcher(deps(repos, { startAgent: startAgent as unknown as DispatcherDeps['startAgent'], room }), { schedule: false });
    await d.tick('t');
    await d.stop();
    expect(calls).toEqual(['automationRuns.cancelOrphaned', 'projectSetup.listWithAutomation']);
    expect(startAgent).not.toHaveBeenCalled();
    expect(room).not.toHaveBeenCalled(); // R6: automation off, no hardware reading
  });

  it('a project with automation on retries its due cleanups on a tick, paused or not; a draining instance does not', async () => {
    const run = { id: 'r1', project_id: 'p1', task_id: 't1', status: 'done', tab_id: null, machine_id: 'm1', worktree_path: '/wt/a', cleanup_state: 'due', cleanup_attempts: 1 };
    const data = setupSchema.parse({ automation: { enabled: true } });
    const mk = () =>
      recordingRepos({
        ...idle(),
        projectSetup: { listWithAutomation: async () => [{ project_id: 'p1', data }] },
        automationRuns: { ...idle().automationRuns, dueCleanups: async () => [run], settleCleanup: async () => true },
        projects: { findById: async () => ({ id: 'p1', owner_id: 'u1' }) },
        users: { findById: async () => ({ id: 'u1' }) },
        machines: { findById: async () => ({ id: 'm1' }) },
        projectMachines: { find: async () => ({ cwd: '/repo' }) },
        automationEvents: { insert: async (e: object) => ({ id: 'e', created_at: '', ...e }) },
        // a paused project: the rest of the pass stops here, the cleanup still ran
        automationPauses: { state: async () => ({ user: null, project: new Date() }) },
      });
    const removeWorkspace = vi.fn(async () => ({ removed: true, dirty: false }));
    const log = { info: () => {}, warn: () => {} };
    const { repos } = mk();
    const d = startDispatcher(deps(repos, { removeWorkspace, log }), { schedule: false });
    await d.tick('t');
    await d.stop();
    expect(removeWorkspace).toHaveBeenCalledTimes(1);

    const draining = mk();
    const d2 = startDispatcher(deps(draining.repos, { removeWorkspace, log, lifecycle: { draining: true } }), { schedule: false });
    await d2.tick('t');
    await d2.stop();
    expect(removeWorkspace).toHaveBeenCalledTimes(1);
  });

  it('ticks that overlap share one pass, plus one more for what arrived meanwhile', async () => {
    let lists = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { repos } = recordingRepos({
      ...idle(),
      projectSetup: {
        listWithAutomation: async () => {
          lists++;
          if (lists === 1) await gate;
          return [];
        },
      },
    });
    const d = startDispatcher(deps(repos), { schedule: false });
    const first = d.tick('a');
    const second = d.tick('b');
    const third = d.tick('c');
    release();
    await Promise.all([first, second, third]);
    expect(lists).toBe(2);
    await d.stop();
  });

  it('events and triggers tick once after the debounce; the timer ticks every 15 s; stop ends both', async () => {
    vi.useFakeTimers();
    let lists = 0;
    const { repos } = recordingRepos({ ...idle(), projectSetup: { listWithAutomation: async () => (lists++, []) } });
    const d = startDispatcher(deps(repos));
    await vi.advanceTimersByTimeAsync(TRIGGER_DEBOUNCE_MS); // the boot tick
    expect(lists).toBe(1);

    dispatchTriggers.poke('tag_set');
    dispatchTriggers.poke('setup_saved');
    automationBus.publish({ kind: 'resumed', owner_id: 'u1' } as never);
    automationBus.publish({ kind: 'question_answered', owner_id: 'u1' } as never); // not a trigger on its own
    await vi.advanceTimersByTimeAsync(TRIGGER_DEBOUNCE_MS);
    expect(lists).toBe(2);

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(lists).toBe(3);

    await d.stop();
    dispatchTriggers.poke('tag_set');
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(lists).toBe(3);
  });

  it('a failing pass is logged and the next tick runs again', async () => {
    let lists = 0;
    const warn = vi.fn();
    const { repos } = recordingRepos({
      ...idle(),
      projectSetup: {
        listWithAutomation: async () => {
          lists++;
          if (lists === 1) throw Object.assign(new Error('db down'), { code: 'P1001' });
          return [];
        },
      },
    });
    const d = startDispatcher(deps(repos, { log: { info: () => {}, warn } }), { schedule: false });
    await d.tick('a');
    await d.tick('b');
    expect(lists).toBe(2);
    expect(warn).toHaveBeenCalledWith({ code: 'P1001' }, 'automation: tick failed');
    await d.stop();
  });

  it('with a project on automation, a tick clears the expired exhaustions and resumes the runs waiting on them (D16)', async () => {
    const order: string[] = [];
    const { repos } = recordingRepos({
      ...idle(),
      projectSetup: { listWithAutomation: async () => [{ project_id: 'p1', data: {} }] },
      projects: { findById: async () => undefined },
      aiAccountExhaustions: { clearExpired: async () => (order.push('clearExpired'), ['a1']) },
    });
    const resumeQuota = vi.fn(async () => void order.push('resumeQuota'));
    const d = startDispatcher(deps(repos, { resumeQuota }), { schedule: false });
    await d.tick('t');
    await d.stop();
    expect(order).toEqual(['clearExpired', 'resumeQuota']);
  });

  // Spec §10.2 (Task 26): the tick also looks at the project's automatic epics that are not done yet.
  it('a tick hands each automatic, unfinished epic to the integration (and skips the rest)', async () => {
    const setup = setupSchema.parse({ repo: { integration_id: 'i1', full_name: 'acme/app', base_branch: 'main' }, automation: { enabled: true } });
    const board = [
      { id: 'e1', project_id: 'p1', ref: 'TER-1', title: 'A', type: 'epic', status: 'doing', auto: true, parent_id: null, epic_id: null },
      { id: 'e2', project_id: 'p1', ref: 'TER-2', title: 'B', type: 'epic', status: 'doing', auto: false, parent_id: null, epic_id: null },
      { id: 'e3', project_id: 'p1', ref: 'TER-3', title: 'C', type: 'epic', status: 'done', auto: true, parent_id: null, epic_id: null },
      { id: 'c1', project_id: 'p1', ref: 'TER-4', title: 'D', type: 'story', status: 'doing', auto: true, parent_id: null, epic_id: 'e1' },
    ];
    const triggeredStatuses = vi.fn(async () => [] as string[]);
    const { repos } = recordingRepos({
      ...idle(),
      automationRuns: { ...idle().automationRuns, triggeredStatuses },
      projectSetup: { listWithAutomation: async () => [{ project_id: 'p1', data: setup }] },
      projects: { findById: async () => ({ id: 'p1', owner_id: 'u1' }) },
      automationPauses: { state: async () => ({ user: null, project: null }) },
      users: { findById: async () => undefined }, // the queue pass stops here
      aiAccountExhaustions: { clearExpired: async () => [] },
      tasks: { listByProject: async () => board },
      taskPullRequests: { listByTasks: async () => [] },
    });
    const d = startDispatcher(deps(repos), { schedule: false });
    await d.tick('t');
    await d.stop();
    expect(triggeredStatuses).toHaveBeenCalledTimes(1);
    expect(triggeredStatuses).toHaveBeenCalledWith('e1', 'integrator');
  });

  it('a paused project gets no integration pass', async () => {
    const { repos, calls } = recordingRepos({
      ...idle(),
      projectSetup: { listWithAutomation: async () => [{ project_id: 'p1', data: {} }] },
      automationRuns: { ...idle().automationRuns, countActive: async () => 0 },
      projects: { findById: async () => ({ id: 'p1', owner_id: 'u1' }) },
      automationPauses: { state: async () => ({ user: null, project: new Date() }) },
      aiAccountExhaustions: { clearExpired: async () => [] },
    });
    const d = startDispatcher(deps(repos), { schedule: false });
    await d.tick('t');
    await d.stop();
    expect(calls).not.toContain('tasks.listByProject');
  });

  it('with no project on automation, the quota pass does not run', async () => {
    const { repos, calls } = recordingRepos(idle());
    const resumeQuota = vi.fn(async () => {});
    const d = startDispatcher(deps(repos, { resumeQuota }), { schedule: false });
    await d.tick('t');
    await d.stop();
    expect(calls).not.toContain('aiAccountExhaustions.clearExpired');
    expect(resumeQuota).not.toHaveBeenCalled();
  });

  describe('daily budget (TER-892)', () => {
    const at = new Date('2026-10-05T12:00:00Z');
    const budgetRepos = (limit: number | null, spent: number) => {
      const setup = setupSchema.parse({ automation: { enabled: true, daily_budget_usd: limit } });
      return recordingRepos({
        ...idle(),
        projectSetup: { listWithAutomation: async () => [{ project_id: 'p1', data: setup }] },
        automationRuns: { ...idle().automationRuns, countActive: async () => 0, claim: async () => null },
        projects: { findById: async () => ({ id: 'p1', owner_id: 'u1' }) },
        automationPauses: { state: async () => ({ user: null, project: null }) },
        users: { findById: async () => ({ id: 'u1' }) },
        aiAccountExhaustions: { clearExpired: async () => [] },
        tasks: { listByProject: async () => [] },
        tabUsage: { ownerTimeZone: async () => null, costOfDay: async () => spent },
        automationEvents: { insertOnce: async () => null },
      });
    };

    it('a project at its budget gets no new start (the queue is not even read), and its fixer and integrator wait', async () => {
      const { repos, calls } = budgetRepos(10, 10);
      const warn = vi.fn();
      const d = startDispatcher(deps(repos, { now: () => at, log: { info: () => {}, warn } }), { schedule: false });
      await d.tick('t');
      expect(calls).toContain('tabUsage.costOfDay');
      expect(calls).not.toContain('automationRuns.claim');
      expect(warn).not.toHaveBeenCalled();
      const fixer = { projectId: 'p1', taskId: 'c1', role: 'fixer' as const, triggerSha: 'h1', branch: 'b', base: 'main', prompt: 'p' };
      const more = recordingRepos({
        projects: { findById: async () => ({ id: 'p1', owner_id: 'u1' }) },
        automationPauses: { state: async () => ({ user: null, project: null }) },
        users: { findById: async () => ({ id: 'u1' }) },
        projectSetup: { get: async () => ({ data: setupSchema.parse({ automation: { enabled: true, daily_budget_usd: 10 } }) }) },
        tasks: { findById: async () => ({ id: 'c1', project_id: 'p1' }) },
        tabUsage: { ownerTimeZone: async () => null, costOfDay: async () => 11 },
        automationEvents: { insertOnce: async () => null },
      });
      expect(await startDispatcher(deps(more.repos, { now: () => at }), { schedule: false }).startTriggered(fixer)).toBe('waiting');
      expect(more.calls).not.toContain('automationRuns.claim');
      await d.stop();
    });

    it('under the budget, or with none, the queue is read as usual', async () => {
      for (const [limit, spent] of [[10, 3], [null, 0]] as const) {
        const { repos, calls } = budgetRepos(limit, spent);
        // the queue needs more than these fakes give: reaching it is what counts
        const d = startDispatcher(deps(repos, { now: () => at, log: { info: () => {}, warn: () => {} } }), { schedule: false });
        await d.tick('t');
        await d.stop();
        expect(calls.some((c) => c.startsWith('tasks.') || c.startsWith('taskColumns.') || c.startsWith('projectMachines.') || c.startsWith('projectSetup.get'))).toBe(true);
        if (limit === null) expect(calls).not.toContain('tabUsage.costOfDay');
      }
    });
  });

  it('the instance id is unique per process start, not a colour name', () => {
    const a = dispatcherInstanceId();
    const b = dispatcherInstanceId();
    expect(a).not.toBe(b);
    expect(a).toContain(`-${process.pid}-`);
  });

  // Spike R2 (TER-965): the merge executor's conflict fixer goes through the same claim as the queue.
  describe('startTriggered', () => {
    const fixer = { projectId: 'p1', taskId: 'c1', role: 'fixer' as const, triggerSha: 'h1', branch: 'TER-5-x', base: 'main', prompt: 'p' };
    const base = (over: { paused?: boolean; enabled?: boolean; claim?: unknown } = {}) => ({
      projects: { findById: async () => ({ id: 'p1', owner_id: 'u1' }) },
      automationPauses: { state: async () => ({ user: null, project: over.paused ? new Date() : null }) },
      users: { findById: async () => ({ id: 'u1' }) },
      projectSetup: { get: async () => ({ data: { automation: { enabled: over.enabled ?? true, max_parallel: null } } }) },
      tasks: { findById: async () => ({ id: 'c1', project_id: 'p1' }) },
      automationRuns: { claim: async () => over.claim ?? null, release: async () => true },
      projectMachines: { listByProject: async () => [] },
    });

    it('draining, paused or automation off: halted, nothing claimed', async () => {
      const draining = recordingRepos(base());
      expect(await startDispatcher(deps(draining.repos, { lifecycle: { draining: true } }), { schedule: false }).startTriggered(fixer)).toBe('halted');
      expect(draining.calls).toEqual([]);
      for (const over of [{ paused: true }, { enabled: false }]) {
        const { repos, calls } = recordingRepos(base(over));
        expect(await startDispatcher(deps(repos), { schedule: false }).startTriggered(fixer)).toBe('halted');
        expect(calls).not.toContain('automationRuns.claim');
      }
    });

    it('claims with the PR head as the trigger; a trigger already used (or an active run) is taken', async () => {
      const claim = vi.fn(async () => null);
      const { repos } = recordingRepos({ ...base(), automationRuns: { claim, release: async () => true } });
      expect(await startDispatcher(deps(repos), { schedule: false }).startTriggered(fixer)).toBe('taken');
      expect(claim).toHaveBeenCalledWith({ project_id: 'p1', task_id: 'c1', role: 'fixer', instance: 'test', trigger_sha: 'h1' });
    });

    it('no machine for it now: the claim is let go (the trigger stays free) and it waits', async () => {
      const release = vi.fn(async () => true);
      const { repos } = recordingRepos({ ...base(), automationRuns: { claim: async () => ({ id: 'r1', task_id: 'c1' }), release } });
      expect(await startDispatcher(deps(repos), { schedule: false }).startTriggered(fixer)).toBe('waiting');
      expect(release).toHaveBeenCalledWith('r1', 'test');
    });
  });
});

