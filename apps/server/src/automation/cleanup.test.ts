import { describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import { setupSchema } from '../setup/schema.js';
import { CLEANUP_MAX_ATTEMPTS, cleanupRuns } from './cleanup.js';

const setup = setupSchema.parse({ automation: { enabled: true } });
const project = { id: 'p1', owner_id: 'u1' };

function world(runs: Array<Partial<AutomationRun>>, tabState: string | null = 'idle') {
  const rows = runs.map((r, i) => ({ id: `r${i}`, project_id: 'p1', task_id: 't1', status: 'done', tab_id: null, machine_id: 'm1', worktree_path: '/wt/a', cleanup_state: 'due', cleanup_attempts: 0, ...r })) as AutomationRun[];
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const repos = {
    users: { findById: vi.fn(async (id: string) => ({ id })) },
    tabs: { findById: vi.fn(async (id: string) => (tabState === null ? undefined : { id, state: tabState })) },
    machines: { findById: vi.fn(async (id: string) => ({ id })) },
    projectMachines: { find: vi.fn(async () => ({ cwd: '/repo' })) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    automationEvents: { insert: vi.fn(async (e: { kind: string }) => (events.push(e), { id: 'e', created_at: '', ...e })) },
    automationRuns: {
      settleCleanup: vi.fn(async (id: string, st: string) => {
        const r = rows.find((x) => x.id === id)!;
        if (r.cleanup_state !== 'due') return false;
        r.cleanup_state = st as never;
        return true;
      }),
      bumpCleanup: vi.fn(async (id: string) => ++rows.find((x) => x.id === id)!.cleanup_attempts),
    },
  } as unknown as Repositories;
  const removeWorkspace = vi.fn(async () => ({ removed: true, dirty: false }));
  const closeTab = vi.fn(async () => {});
  const deps = { repos, removeWorkspace, closeTab } as never;
  return { rows, events, removeWorkspace, closeTab, deps, repos };
}

describe('cleanupRuns', () => {
  it('a machine that was offline is retried on the next pass, then settles', async () => {
    const w = world([{}]);
    w.removeWorkspace.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'MACHINE_OFFLINE' }));
    expect(await cleanupRuns(w.deps, project, setup, w.rows)).toMatchObject({ removed: 0, pending: 1 });
    expect(w.rows[0]).toMatchObject({ cleanup_state: 'due', cleanup_attempts: 1 });
    expect(await cleanupRuns(w.deps, project, setup, w.rows)).toMatchObject({ removed: 1, pending: 0 });
    expect(w.rows[0]!.cleanup_state).toBe('done');
    expect(w.removeWorkspace).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded number of attempts, with an event', async () => {
    const w = world([{ cleanup_attempts: CLEANUP_MAX_ATTEMPTS - 1 }]);
    w.removeWorkspace.mockRejectedValue(new Error('offline'));
    const r = await cleanupRuns(w.deps, project, setup, w.rows);
    expect(r.pending).toBe(0);
    expect(w.rows[0]!.cleanup_state).toBe('gave_up');
    expect(w.events).toEqual([expect.objectContaining({ kind: 'worktree_cleanup', payload: expect.objectContaining({ outcome: 'gave_up' }) })]);
    // settled runs are not touched again
    await cleanupRuns(w.deps, project, setup, w.rows);
    expect(w.removeWorkspace).toHaveBeenCalledTimes(1);
  });

  it('nothing to remove (invalid or missing root) is a settled cleanup without an event', async () => {
    const w = world([{}]);
    w.removeWorkspace.mockResolvedValue({ removed: false, dirty: false });
    await cleanupRuns(w.deps, project, setup, w.rows);
    expect(w.rows[0]!.cleanup_state).toBe('done');
    expect(w.events).toEqual([]);
  });

  it('a tab that is still working waits (a busy tab is never closed), then closes when idle', async () => {
    const w = world([{ tab_id: 'tab1' }], 'working');
    await cleanupRuns(w.deps, project, setup, w.rows);
    expect(w.closeTab).not.toHaveBeenCalled();
    expect(w.removeWorkspace).not.toHaveBeenCalled(); // the agent may still be in that folder
    vi.mocked(w.repos.tabs.findById).mockResolvedValue({ id: 'tab1', state: 'idle' } as never);
    await cleanupRuns(w.deps, project, setup, w.rows);
    expect(w.closeTab).toHaveBeenCalledTimes(1);
    expect(w.removeWorkspace).toHaveBeenCalledTimes(1);
  });

  it('a tab that is already gone needs no close', async () => {
    const w = world([{ tab_id: 'tab1' }], null);
    await cleanupRuns(w.deps, project, setup, w.rows);
    expect(w.closeTab).not.toHaveBeenCalled();
    expect(w.rows[0]!.cleanup_state).toBe('done');
  });

  it('a cancelled run of a deleted card removes its worktree and leaves its tab alone', async () => {
    const w = world([{ status: 'cancelled', task_id: null, tab_id: 'tab1' }]);
    await cleanupRuns(w.deps, project, setup, w.rows);
    expect(w.closeTab).not.toHaveBeenCalled();
    expect(w.removeWorkspace).toHaveBeenCalledTimes(1);
  });
});
