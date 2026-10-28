import { describe, expect, it } from 'vitest';
import type { ChatWatch } from '../../db/repositories/chat-watches.js';
import type { TaskPullRequest } from '../../db/repositories/task-pull-requests.js';
import { WATCH_LIMITS } from './kinds.js';
import { evaluateWatch, expiredEvaluation, initialBaseline, OFFLINE_GRACE_MS, type ProbeMachine, type ProbeTab, type ProbeTask, type WatchProbe } from './evaluate.js';

type Ev = { id: string; kind: ProbeTab['state'] & string; created_at: string };

function probe(over: Partial<{ tab: ProbeTab | null; events: Ev[]; task: ProbeTask | null; prs: TaskPullRequest[]; machine: ProbeMachine | null; latest: string | null }> = {}): WatchProbe {
  return {
    tab: async () => (over.tab === undefined ? { id: 't1', name: 'api', project_id: 'p1', machine_id: 'm1', state: 'working' } : over.tab),
    tabEventsAfter: async (_id, after, kinds) => (over.events ?? []).filter((e) => Date.parse(e.created_at) > after.getTime() && kinds.includes(e.kind)),
    task: async () => (over.task === undefined ? { id: 'k1', ref: 'TER-12', title: 'Login', project_id: 'p1', column_id: 'c-todo', status: 'todo' } : over.task),
    pullRequests: async () => over.prs ?? [],
    machine: async () => (over.machine === undefined ? { id: 'm1', name: 'hulk', online: true, offline_for_ms: null } : over.machine),
    latestAgentVersion: async () => over.latest ?? null,
  };
}

function watch(over: Partial<ChatWatch>): ChatWatch {
  return {
    id: 'w1', user_id: 'u1', project_id: 'p1', conversation_id: 'c1', kind: 'tab', target_id: 't1', params: { events: ['finished'] }, baseline: {},
    label: 'api', note: 'avisar', recurring: false, status: 'open', created_at: '2026-10-21T12:00:00.000Z', expires_at: '2026-10-22T12:00:00.000Z',
    closed_at: null, last_fired_at: null, fire_count: 0, ...over,
  };
}

const pr = (over: Partial<TaskPullRequest> = {}): TaskPullRequest => ({
  id: 'r1', project_id: 'p1', task_id: 'k1', repo: 'o/r', number: 511, url: 'https://github.com/o/r/pull/511', title: 'Fix', head_ref: 'TER-12-fix', head_sha: 'aaa', base_ref: 'main',
  state: 'open', draft: false, merged_at: null, merge_commit_sha: null, ci_state: 'running', ci_summary: { total: 1, passed: 0, failed: 0, running: 1, failing: [] },
  deploy_state: 'none', deploy_url: null, release_runs: [], changed_level: null, synced_at: '2026-10-21T12:00:00.000Z', ...over,
});

describe('tab watches', () => {
  const events: Ev[] = [
    { id: 'e0', kind: 'finished', created_at: '2026-10-21T11:59:00.000Z' },
    { id: 'e1', kind: 'finished', created_at: '2026-10-21T12:05:00.000Z' },
    { id: 'e2', kind: 'finished', created_at: '2026-10-21T12:09:00.000Z' },
  ];

  it('fires on the first stop after the watch began, even when the tab already moved on, and closes once', async () => {
    const ev = await evaluateWatch(probe({ events }), watch({ baseline: { cursor: '2026-10-21T12:00:00.000Z' } }));
    expect(ev?.events).toEqual([expect.objectContaining({ key: 'tab:e1', event: 'finished', payload: expect.objectContaining({ tab_id: 't1', tab_name: 'api', state_now: 'working' }) })]);
    expect(ev?.close).toBe('done');
    expect(ev?.baseline).toEqual({ cursor: '2026-10-21T12:05:00.000Z' });
  });

  it('a recurring watch reports the newest stop and stays open', async () => {
    const ev = await evaluateWatch(probe({ events }), watch({ recurring: true, baseline: { cursor: '2026-10-21T12:00:00.000Z' } }));
    expect(ev?.events[0].key).toBe('tab:e2');
    expect(ev?.close).toBeNull();
  });

  // TER-1144: an agent that keeps stopping and starting again (a polling loop, background work it waits on)
  // writes a `finished` every few minutes; a recurring watch told the person each one (24 times).
  it('a recurring watch never tells the same stop twice in a row, but moves past it silently', async () => {
    const w = watch({ recurring: true, params: { events: ['finished', 'waiting_input'] }, baseline: { cursor: '2026-10-21T12:00:00.000Z' } });
    const first = await evaluateWatch(probe({ events }), w);
    expect(first?.events[0]).toMatchObject({ key: 'tab:e2', event: 'finished' });
    expect(first?.baseline).toEqual({ cursor: '2026-10-21T12:09:00.000Z', notified: 'finished' });
    const again = [...events, { id: 'e4', kind: 'finished' as const, created_at: '2026-10-21T12:30:00.000Z' }];
    const second = await evaluateWatch(probe({ events: again }), { ...w, baseline: first!.baseline, fire_count: 1, last_event: 'finished' });
    expect(second).toEqual({ events: [], baseline: { cursor: '2026-10-21T12:30:00.000Z', notified: 'finished' }, close: null });
  });

  it('a recurring watch re-arms once the tab stopped in another watched way, and tells the newest stop', async () => {
    const w = watch({ recurring: true, params: { events: ['finished', 'waiting_input'] }, baseline: { cursor: '2026-10-21T12:10:00.000Z', notified: 'finished' }, fire_count: 1, last_event: 'finished' });
    const asked = { id: 'e5', kind: 'waiting_input' as const, created_at: '2026-10-21T12:20:00.000Z' };
    const ev = await evaluateWatch(probe({ events: [asked] }), w);
    expect(ev?.events[0]).toMatchObject({ key: 'tab:e5', event: 'waiting_input' });
    // Changed and came back within one pass (the cooldown held the question): the stop is told again.
    const back = await evaluateWatch(probe({ events: [asked, { id: 'e6', kind: 'finished', created_at: '2026-10-21T12:25:00.000Z' }] }), w);
    expect(back?.events[0]).toMatchObject({ key: 'tab:e6', event: 'finished' });
    expect(back?.baseline).toEqual({ cursor: '2026-10-21T12:25:00.000Z', notified: 'finished' });
  });

  it('a recurring watch from before the dedupe takes its last event as the one told', async () => {
    const w = watch({ recurring: true, baseline: { cursor: '2026-10-21T12:00:00.000Z' }, fire_count: 24, last_event: 'finished' });
    expect(await evaluateWatch(probe({ events }), w)).toEqual({ events: [], baseline: { cursor: '2026-10-21T12:09:00.000Z', notified: 'finished' }, close: null });
  });

  it('ignores stops the watch did not ask for and those before it', async () => {
    expect(await evaluateWatch(probe({ events: [{ id: 'e3', kind: 'error', created_at: '2026-10-21T12:05:00.000Z' }] }), watch({ baseline: { cursor: '2026-10-21T12:00:00.000Z' } }))).toBeNull();
    expect(await evaluateWatch(probe({ events: [events[0]] }), watch({ baseline: { cursor: '2026-10-21T12:00:00.000Z' } }))).toBeNull();
  });

  it('a closed tab is always told, and ends the watch', async () => {
    const ev = await evaluateWatch(probe({ tab: null }), watch({ baseline: { cursor: '2026-10-21T12:00:00.000Z' } }));
    expect(ev).toMatchObject({ events: [{ key: 'gone', event: 'gone' }], close: 'gone' });
  });

  it('starts from now', async () => {
    const now = new Date('2026-10-21T12:00:00.000Z');
    expect(await initialBaseline(probe(), { user_id: 'u1', kind: 'tab', target_id: 't1', params: { events: ['finished'] } }, now)).toEqual({ cursor: now.toISOString() });
  });
});

describe('recurring cap (TER-1144)', () => {
  it('the last fire a recurring watch may send closes it and says so', async () => {
    const w = watch({ recurring: true, baseline: { cursor: '2026-10-21T12:00:00.000Z' }, fire_count: WATCH_LIMITS.maxFires - 1 });
    const ev = await evaluateWatch(probe({ events: [{ id: 'e1', kind: 'finished', created_at: '2026-10-21T12:05:00.000Z' }] }), w);
    expect(ev?.close).toBe('done');
    expect(ev?.events[0].payload).toMatchObject({ last: true, max_fires: WATCH_LIMITS.maxFires });
  });

  it('below the cap it stays open', async () => {
    const w = watch({ recurring: true, baseline: { cursor: '2026-10-21T12:00:00.000Z' }, fire_count: WATCH_LIMITS.maxFires - 2 });
    const ev = await evaluateWatch(probe({ events: [{ id: 'e1', kind: 'finished', created_at: '2026-10-21T12:05:00.000Z' }] }), w);
    expect(ev?.close).toBeNull();
    expect(ev?.events[0].payload.last).toBeUndefined();
  });
});

describe('card watches', () => {
  it('fires when the card leaves its column', async () => {
    const ev = await evaluateWatch(probe({ task: { id: 'k1', ref: 'TER-12', title: 'Login', project_id: 'p1', column_id: 'c-doing', status: 'doing' } }), watch({ kind: 'card', target_id: 'k1', params: { events: ['moved'] }, baseline: { column_id: 'c-todo', status: 'todo' } }));
    expect(ev?.events[0]).toMatchObject({ event: 'moved', payload: { ref: 'TER-12', from_status: 'todo', to_status: 'doing' } });
  });

  it('with `to`, a move elsewhere only moves the baseline', async () => {
    const w = watch({ kind: 'card', target_id: 'k1', params: { events: ['moved'], to: 'done' }, baseline: { column_id: 'c-todo', status: 'todo' } });
    const ev = await evaluateWatch(probe({ task: { id: 'k1', ref: 'TER-12', title: 'Login', project_id: 'p1', column_id: 'c-doing', status: 'doing' } }), w);
    expect(ev).toEqual({ events: [], baseline: { column_id: 'c-doing', status: 'doing' }, close: null });
    const done = await evaluateWatch(probe({ task: { id: 'k1', ref: 'TER-12', title: 'Login', project_id: 'p1', column_id: 'c-done', status: 'done' } }), { ...w, baseline: ev!.baseline });
    expect(done?.events[0].event).toBe('moved');
  });

  it('nothing while it stays put; gone when deleted', async () => {
    expect(await evaluateWatch(probe(), watch({ kind: 'card', target_id: 'k1', params: { events: ['moved'] }, baseline: { column_id: 'c-todo', status: 'todo' } }))).toBeNull();
    expect((await evaluateWatch(probe({ task: null }), watch({ kind: 'card', target_id: 'k1', params: { events: ['moved'] } })))?.close).toBe('gone');
  });
});

describe('PR watches', () => {
  const prWatch = (events: string[], baselinePr: TaskPullRequest | null, over: Partial<ChatWatch> = {}) =>
    watch({ kind: 'pr', target_id: 'k1', params: { events }, baseline: { prs: baselinePr ? { [baselinePr.url]: { state: baselinePr.state, ci_state: baselinePr.ci_state, head_sha: baselinePr.head_sha, deploy_state: baselinePr.deploy_state, merge_sha: baselinePr.merge_commit_sha, releases: Object.fromEntries(baselinePr.release_runs.map((r) => [r.workflow, r.state])) } } : {} }, ...over });

  it('TER-1136: a head termhub will not merge by itself is `merge_blocked`, once per head and reason', async () => {
    const green = pr({ ci_state: 'passed' });
    const held = { ...green, merge_blocked: 'merge_person_card' };
    const ev = await evaluateWatch(probe({ prs: [held] }), prWatch(['merge_blocked'], green));
    expect(ev?.events).toEqual([expect.objectContaining({ event: 'merge_blocked', key: `${green.url}:merge_blocked:merge_person_card@aaa`, payload: expect.objectContaining({ number: 511, reason: 'merge_person_card', head_sha: 'aaa' }) })]);
    // the same block again: nothing new
    const again = await evaluateWatch(probe({ prs: [held] }), watch({ kind: 'pr', target_id: 'k1', params: { events: ['merge_blocked'] }, baseline: ev!.baseline }));
    expect(again).toBeNull();
    // not asked for: only the baseline moves
    expect((await evaluateWatch(probe({ prs: [held] }), prWatch(['merged'], green)))?.events).toEqual([]);
  });

  it('a new PR of the card is `opened`', async () => {
    const ev = await evaluateWatch(probe({ prs: [pr()] }), prWatch(['opened'], null));
    expect(ev?.events).toEqual([expect.objectContaining({ event: 'opened', payload: expect.objectContaining({ number: 511, pr_url: pr().url }) })]);
  });

  it('merged, then a deploy and a release with its version', async () => {
    const merged = pr({ state: 'merged', merge_commit_sha: 'mmm', ci_state: 'passed' });
    const ev = await evaluateWatch(probe({ prs: [merged] }), prWatch(['merged'], pr()));
    expect(ev?.events.map((e) => e.event)).toEqual(['merged']);
    const delivered = pr({ ...merged, deploy_state: 'passed', deploy_url: 'https://ci/run/1', release_runs: [{ workflow: 'publish-agent.yml', state: 'passed', url: 'https://ci/run/2', version: '0.41.0' }] });
    const after = await evaluateWatch(probe({ prs: [delivered] }), prWatch(['deploy_ok', 'release_ok'], merged));
    expect(after?.events).toEqual([
      expect.objectContaining({ event: 'deploy_ok', key: `${pr().url}:deploy_ok:mmm`, payload: expect.objectContaining({ deploy_url: 'https://ci/run/1' }) }),
      expect.objectContaining({ event: 'release_ok', payload: expect.objectContaining({ workflow: 'publish-agent.yml', version: '0.41.0' }) }),
    ]);
  });

  it('a red CI fires once per commit', async () => {
    const red = pr({ ci_state: 'failed', ci_summary: { total: 1, passed: 0, failed: 1, running: 0, failing: ['check'] } });
    const ev = await evaluateWatch(probe({ prs: [red] }), prWatch(['ci_failed'], pr(), { recurring: true }));
    expect(ev?.events[0]).toMatchObject({ key: `${pr().url}:ci_failed:aaa`, payload: { failing: ['check'] } });
    expect(await evaluateWatch(probe({ prs: [red] }), prWatch(['ci_failed'], red, { recurring: true }))).toBeNull();
    const redAgain = pr({ ...red, head_sha: 'bbb' });
    expect((await evaluateWatch(probe({ prs: [redAgain] }), prWatch(['ci_failed'], red, { recurring: true })))?.events[0].key).toBe(`${pr().url}:ci_failed:bbb`);
  });

  it('a change nobody asked about only moves the baseline', async () => {
    const ev = await evaluateWatch(probe({ prs: [pr({ ci_state: 'passed' })] }), prWatch(['merged'], pr()));
    expect(ev?.events).toEqual([]);
    expect(ev?.baseline).toMatchObject({ prs: { [pr().url]: { ci_state: 'passed' } } });
  });

  it('only the named workflow counts', async () => {
    const merged = pr({ state: 'merged', merge_commit_sha: 'mmm', release_runs: [{ workflow: 'ota.yml', state: 'passed', url: null, version: null }] });
    expect((await evaluateWatch(probe({ prs: [merged] }), prWatch(['release_ok'], pr({ state: 'merged' }), { params: { events: ['release_ok'], workflow: 'publish-agent.yml' } })))?.events ?? []).toEqual([]);
  });
});

describe('machine watches', () => {
  const mw = (events: string[], online: boolean) => watch({ kind: 'machine', target_id: 'm1', params: { events }, baseline: { online } });

  it('fires when it comes back', async () => {
    expect((await evaluateWatch(probe(), mw(['online'], false)))?.events[0]).toMatchObject({ event: 'online', payload: { machine_name: 'hulk' } });
  });

  it('offline only after the grace (a deploy moves agents between colours)', async () => {
    expect(await evaluateWatch(probe({ machine: { id: 'm1', name: 'hulk', online: false, offline_for_ms: 30_000 } }), mw(['offline'], true))).toBeNull();
    expect((await evaluateWatch(probe({ machine: { id: 'm1', name: 'hulk', online: false, offline_for_ms: OFFLINE_GRACE_MS } }), mw(['offline'], true)))?.events[0].event).toBe('offline');
  });

  it('an `online` watch on a machine that was online learns it went away first', async () => {
    const ev = await evaluateWatch(probe({ machine: { id: 'm1', name: 'hulk', online: false, offline_for_ms: OFFLINE_GRACE_MS } }), mw(['online'], true));
    expect(ev).toEqual({ events: [], baseline: { online: false }, close: null });
  });
});

describe('agent release watches', () => {
  const aw = (over: Partial<ChatWatch> = {}) => watch({ kind: 'agent_release', target_id: null, params: { events: ['published'], version: '0.41.0' }, baseline: { seen: '0.40.2' }, ...over });

  it('fires once a version at or above the minimum is on npm', async () => {
    expect(await evaluateWatch(probe({ latest: '0.40.2' }), aw())).toBeNull();
    expect((await evaluateWatch(probe({ latest: '0.41.0' }), aw()))?.events[0]).toMatchObject({ key: 'agent:0.41.0', payload: { version: '0.41.0' } });
  });

  it('a recurring one fires for each newer version', async () => {
    expect(await evaluateWatch(probe({ latest: '0.41.0' }), aw({ recurring: true, baseline: { seen: '0.41.0' } }))).toBeNull();
    expect((await evaluateWatch(probe({ latest: '0.41.1' }), aw({ recurring: true, baseline: { seen: '0.41.0' } })))?.events[0].key).toBe('agent:0.41.1');
  });
});

it('an expired watch is told once and closes', () => {
  expect(expiredEvaluation(watch({}))).toMatchObject({ events: [{ key: 'expired', event: 'expired' }], close: 'expired' });
});
