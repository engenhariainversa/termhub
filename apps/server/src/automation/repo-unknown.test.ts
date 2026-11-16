import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItem } from './queue.js';
import { askForRepos, REPO_UNKNOWN_NAMED_MAX, REPO_UNKNOWN_RETRY_MS, resetRepoUnknownState, type RepoUnknownDeps } from './repo-unknown.js';

/** The events table as the once-only index sees it: one `repo_unknown` row per card, shared by both colours. */
function fakeDb(cards: { id: string; ref: string; title: string; created_at: string }[]) {
  const rows = new Map<string, { id: string; task_id: string }>();
  let n = 0;
  const repos = {
    tasks: { findById: vi.fn(async (id: string) => cards.find((c) => c.id === id)) },
    automationEvents: {
      findOnce: vi.fn(async (taskId: string) => [...rows.values()].find((r) => r.task_id === taskId) ?? null),
      insertOnce: vi.fn(async (e: { task_id: string }) => {
        if ([...rows.values()].some((r) => r.task_id === e.task_id)) return null;
        const row = { id: `ev-${++n}`, task_id: e.task_id };
        rows.set(row.id, row);
        return row;
      }),
      remove: vi.fn(async (id: string) => void rows.delete(id)),
    },
  } as unknown as RepoUnknownDeps['repos'];
  return { repos, rows };
}

const item = (id: string, reason: QueueItem['reason'] = 'repo_unknown'): QueueItem => ({ task_id: id, ref: `TER-${id}`, title: `t${id}`, eligible: false, reason, reason_text: null, repo_keys: [] });
const old = '2026-11-16T00:00:00.000Z';
const NOW = new Date('2026-11-16T01:00:00.000Z');
const project = { id: 'p1', owner_id: 'u1' };
const log = { info: () => {}, warn: () => {} };

describe('askForRepos (TER-1068, multi-repo R9 b)', () => {
  beforeEach(() => resetRepoUnknownState());

  it('wakes the chat once per card, even with two colours ticking on the same database', async () => {
    const { repos, rows } = fakeDb([{ id: '1', ref: 'TER-1', title: 'Login', created_at: old }]);
    const wake = vi.fn(async () => true);
    const deps: RepoUnknownDeps = { repos, now: () => NOW, graceMs: 0, wake, log };
    await askForRepos(deps, project, [item('1')]); // blue
    resetRepoUnknownState(); // green: another process, its own memory
    await askForRepos(deps, project, [item('1')]);
    await askForRepos(deps, project, [item('1')]); // blue's next tick
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith({ ownerId: 'u1', projectId: 'p1', cards: [{ id: '1', ref: 'TER-1', title: 'Login' }] });
    expect(rows.size).toBe(1);
  });

  it('names every new card of a pass in one wake, at most REPO_UNKNOWN_NAMED_MAX', async () => {
    const cards = Array.from({ length: REPO_UNKNOWN_NAMED_MAX + 2 }, (_, i) => ({ id: String(i), ref: `TER-${i}`, title: `t${i}`, created_at: old }));
    const { repos } = fakeDb(cards);
    const wake = vi.fn(async () => true);
    const deps: RepoUnknownDeps = { repos, now: () => NOW, graceMs: 0, wake, log };
    await askForRepos(deps, project, cards.map((c) => item(c.id)));
    expect(wake).toHaveBeenCalledTimes(1);
    expect((wake.mock.calls[0] as unknown as [{ cards: unknown[] }])[0].cards).toHaveLength(REPO_UNKNOWN_NAMED_MAX);
    await askForRepos(deps, project, cards.map((c) => item(c.id)));
    expect(wake).toHaveBeenCalledTimes(2);
    expect((wake.mock.calls[1] as unknown as [{ cards: unknown[] }])[0].cards).toHaveLength(2);
  });

  it('leaves alone other reasons and a card in its first minutes', async () => {
    const { repos } = fakeDb([
      { id: '1', ref: 'TER-1', title: 'a', created_at: old },
      { id: '2', ref: 'TER-2', title: 'b', created_at: new Date(NOW.getTime() - 30_000).toISOString() },
    ]);
    const wake = vi.fn(async () => true);
    await askForRepos({ repos, now: () => NOW, graceMs: 2 * 60_000, wake, log }, project, [item('1', 'repo_disabled'), item('2')]);
    expect(wake).not.toHaveBeenCalled();
  });

  it('gives the claim back when the wake does not start (hourly budget), and tries again later', async () => {
    const { repos, rows } = fakeDb([{ id: '1', ref: 'TER-1', title: 'a', created_at: old }]);
    let now = NOW;
    const wake = vi.fn(async () => false);
    const deps: RepoUnknownDeps = { repos, now: () => now, graceMs: 0, wake, log };
    await askForRepos(deps, project, [item('1')]);
    expect(rows.size).toBe(0);
    await askForRepos(deps, project, [item('1')]);
    expect(wake).toHaveBeenCalledTimes(1); // waits REPO_UNKNOWN_RETRY_MS
    now = new Date(NOW.getTime() + REPO_UNKNOWN_RETRY_MS + 1);
    wake.mockResolvedValue(true);
    await askForRepos(deps, project, [item('1')]);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(1);
  });

  it('does nothing without a waker', async () => {
    const { repos, rows } = fakeDb([{ id: '1', ref: 'TER-1', title: 'a', created_at: old }]);
    await askForRepos({ repos, now: () => NOW, graceMs: 0, log }, project, [item('1')]);
    expect(rows.size).toBe(0);
  });
});
