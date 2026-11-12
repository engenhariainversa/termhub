import { describe, expect, it, vi } from 'vitest';
import type { ControlContext } from './context.js';

const runTabGc = vi.fn(async (..._a: unknown[]) => ({
  mode: 'plan',
  items: [
    { tab_id: 't1', tab: 'a', project_id: 'p1', machine_id: 'm1', machine: 'hulk', state: 'finished', tool: 'claude', task_id: null, step: 'warn', reason: 'idle', rest_hours: 30, closes_at: 'x' },
    { tab_id: 't2', tab: 'b', project_id: 'p1', machine_id: 'm1', machine: 'hulk', state: 'working', tool: 'claude', task_id: null, step: 'keep', reason: 'busy', rest_hours: null, closes_at: null },
  ],
  warned: 0,
  kept: 1,
  collected: 0,
  removed: 0,
}));
vi.mock('../monitor/tab-gc/sweep.js', () => ({ runTabGc: (...a: unknown[]) => runTabGc(...a) }));
const flags = new Map<string, boolean>();
vi.mock('../features/flags.js', () => ({ isEnabled: vi.fn(async (flag: string) => flags.get(flag) ?? false) }));

const { listGcCandidates, runGc } = await import('./tab-gc.js');

const ctx = () =>
  ({
    repos: {},
    scope: { user: { id: 'u1' }, ownerId: 'u1' },
    scoped: { project: vi.fn(async () => ({ project: { id: 'p1' } })), machine: vi.fn(async () => ({ id: 'm1' })) },
  }) as unknown as ControlContext;

describe('tab GC tools (TER-1171)', () => {
  it('both refuse while tab_gc is off for the person', async () => {
    flags.clear();
    await expect(listGcCandidates(ctx(), {})).rejects.toMatchObject({ code: 'TAB_GC_OFF' });
    await expect(runGc(ctx(), {})).rejects.toMatchObject({ code: 'TAB_GC_OFF' });
  });

  it('list_gc_candidates plans over the scope (project checked through scoped) and hides kept tabs unless all', async () => {
    flags.set('tab_gc', true);
    const c = ctx();
    const r = await listGcCandidates(c, { project_id: 'p1' });
    expect(c.scoped.project).toHaveBeenCalledWith('p1');
    expect(runTabGc.mock.calls.at(-1)![2]).toEqual({ mode: 'plan', scope: { ownerId: 'u1', projectId: 'p1', machineId: undefined } });
    expect(r).toMatchObject({ live: false, kept: 1 });
    expect(r.candidates.map((i) => i.tab_id)).toEqual(['t1']);
    expect((await listGcCandidates(ctx(), { all: true })).candidates).toHaveLength(2);
  });

  it('run_gc is a plan by default; a real pass needs tab_gc_live', async () => {
    flags.set('tab_gc', true);
    flags.delete('tab_gc_live');
    expect(await runGc(ctx(), {})).toMatchObject({ dry_run: true });
    expect((runTabGc.mock.calls.at(-1)![2] as { mode: string }).mode).toBe('plan');
    await expect(runGc(ctx(), { dry_run: false })).rejects.toMatchObject({ code: 'TAB_GC_NOT_LIVE' });
    flags.set('tab_gc_live', true);
    await runGc(ctx(), { dry_run: false });
    expect((runTabGc.mock.calls.at(-1)![2] as { mode: string }).mode).toBe('live');
  });
});
