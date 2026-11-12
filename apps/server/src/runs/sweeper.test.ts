import { describe, expect, it, vi } from 'vitest';
import type { ApiRun } from '../db/repositories/api-runs.js';
import type { Machine } from '../db/repositories/types.js';
import { EVENT_RETENTION_MS, sweepRuns, WORKTREE_RETENTION_MS, type RunSweeperDeps } from './sweeper.js';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const run = (over: Partial<ApiRun>): ApiRun => ({
  id: 'r', user_id: 'u1', token_id: 't', project_id: 'p1', machine_id: 'm1', machine_name: 'm1', account_id: 'a1', account_label: 'L', provider: 'claude', model: null,
  capabilities: ['edit'], status: 'succeeded', workspace: { kind: 'worktree', path: '/w/p1/run-r', branch: 'termhub/run-r' }, result: null, usage: null, error_code: null,
  error_message: null, idempotency_key: null, timeout_ms: 600_000, created_at: ago(2 * 86_400_000), started_at: ago(2 * 86_400_000), ended_at: ago(25 * 3_600_000), ...over,
});

function deps(opts: { active?: ApiRun[]; worktrees?: ApiRun[]; holds?: string[]; remove?: RunSweeperDeps['remove']; machine?: boolean } = {}) {
  const apiRuns = {
    deleteEventsBefore: vi.fn(async () => 7),
    listActive: vi.fn(async () => opts.active ?? []),
    listWorktreesEndedBefore: vi.fn(async () => opts.worktrees ?? []),
    finishActive: vi.fn(async () => true),
    appendEvents: vi.fn(async () => []),
    setStatus: vi.fn(async () => undefined),
  };
  const remove = opts.remove ?? vi.fn(async () => ({ removed: true, dirty: false }));
  const d: RunSweeperDeps = {
    repos: {
      apiRuns,
      machines: { findById: async (id: string) => (opts.machine === false ? undefined : ({ id, type: 'agent' } as Machine)) },
      projectMachines: { find: async () => ({ cwd: '/home/u/proj' }) },
      projectSetup: { get: async () => ({ data: { automation: { worktrees_dir: '~/.termhub/worktrees' } } }) },
      users: { findById: async () => ({ locale: 'en' }) },
    } as unknown as RunSweeperDeps['repos'],
    log: { info: () => {}, warn: () => {} },
    holds: (id) => (opts.holds ?? []).includes(id),
    remove,
    now: () => NOW,
  };
  return { d, apiRuns, remove };
}

describe('sweepRuns', () => {
  it('deletes events older than 7 days', async () => {
    const { d, apiRuns } = deps();
    expect((await sweepRuns(d)).events).toBe(7);
    expect(apiRuns.deleteEventsBefore).toHaveBeenCalledWith(new Date(NOW.getTime() - EVENT_RETENTION_MS));
  });

  it('removes the worktrees of runs ended more than 24 h ago and marks them removed', async () => {
    const { d, apiRuns, remove } = deps({ worktrees: [run({})] });
    expect((await sweepRuns(d)).worktrees).toBe(1);
    expect(apiRuns.listWorktreesEndedBefore).toHaveBeenCalledWith(new Date(NOW.getTime() - WORKTREE_RETENTION_MS));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), { repoDir: '/home/u/proj', root: '~/.termhub/worktrees', path: '/w/p1/run-r' });
    expect(apiRuns.setStatus).toHaveBeenCalledWith('r', { workspace: { kind: 'worktree', path: '/w/p1/run-r', branch: 'termhub/run-r', removed_at: NOW.toISOString() } });
  });

  it('keeps a dirty worktree for the next sweep, and an offline machine too', async () => {
    const dirty = deps({ worktrees: [run({})], remove: vi.fn(async () => ({ removed: false, dirty: true })) });
    expect((await sweepRuns(dirty.d)).worktrees).toBe(0);
    expect(dirty.apiRuns.setStatus).not.toHaveBeenCalled();
    const offline = deps({ worktrees: [run({})], remove: vi.fn(async () => Promise.reject(new Error('agent offline'))) });
    expect((await sweepRuns(offline.d)).worktrees).toBe(0);
    expect(offline.apiRuns.setStatus).not.toHaveBeenCalled();
  });

  it('a machine that is gone has nothing left to remove: the run is marked and never tried again', async () => {
    const { d, apiRuns, remove } = deps({ worktrees: [run({})], machine: false });
    await sweepRuns(d);
    expect(remove).not.toHaveBeenCalled();
    expect(apiRuns.setStatus).toHaveBeenCalled();
  });

  it('ends an orphan past its timeout; leaves the ones held here or still in time', async () => {
    const orphan = run({ id: 'o', status: 'running', started_at: ago(600_000 + 6 * 60_000), ended_at: null });
    const held = run({ id: 'h', status: 'running', started_at: ago(86_400_000), ended_at: null });
    const fresh = run({ id: 'f', status: 'running', started_at: ago(60_000), ended_at: null });
    const { d, apiRuns } = deps({ active: [orphan, held, fresh], holds: ['h'] });
    expect((await sweepRuns(d)).orphans).toBe(1);
    expect(apiRuns.finishActive).toHaveBeenCalledTimes(1);
    expect(apiRuns.finishActive).toHaveBeenCalledWith('o', expect.objectContaining({ status: 'failed', error_code: 'cli_failed', error_message: 'The server restarted' }));
    expect(apiRuns.appendEvents).toHaveBeenCalledWith('o', [expect.objectContaining({ type: 'error' }), expect.objectContaining({ type: 'done' })]);
  });
});
