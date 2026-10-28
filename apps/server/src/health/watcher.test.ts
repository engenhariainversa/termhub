import { describe, expect, it, vi } from 'vitest';
import type { HealthAlert, SeenAlert } from '../db/repositories/health-alerts.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Project, User } from '../db/repositories/types.js';
import { healthSchema, setupSchema } from '../setup/schema.js';
import type { HealthSnapshot } from './signals.js';
import { createHealthWatcher, reconcile } from './watcher.js';

vi.mock('../memory/current-rules.js', () => ({ currentRulesBlock: async () => null }));

/** The repository's semantics in memory: one row per (project, signal, subject), claims won once. */
function memoryStore() {
  const rows: HealthAlert[] = [];
  const iso = (d: Date) => d.toISOString();
  return {
    rows,
    async listUnresolved(projectId: string) {
      return rows.filter((r) => r.project_id === projectId && !r.resolved_at).map((r) => ({ ...r }));
    },
    async listOpen(projectId: string) {
      return rows.filter((r) => r.project_id === projectId && !r.resolved_at && r.opened_at).map((r) => ({ ...r }));
    },
    async seen(projectId: string, a: SeenAlert, now: Date) {
      let r = rows.find((x) => x.project_id === projectId && x.signal === a.signal && x.subject === a.subject);
      if (!r) {
        r = { id: `h${rows.length + 1}`, project_id: projectId, signal: a.signal, subject: a.subject, level: a.level, detail: a.detail, since_at: iso(a.since ?? now), first_seen_at: iso(now), last_seen_at: iso(now), opened_at: null, woken_at: null, noticed_at: null, resolved_at: null };
        rows.push(r);
      } else if (r.resolved_at) Object.assign(r, { level: a.level, detail: a.detail, since_at: iso(a.since ?? now), first_seen_at: iso(now), last_seen_at: iso(now), opened_at: null, woken_at: null, noticed_at: null, resolved_at: null });
      else Object.assign(r, { level: a.level, detail: a.detail, last_seen_at: iso(now), ...(a.since ? { since_at: iso(a.since) } : {}) });
      return { ...r };
    },
    async note(id: string, detail: HealthAlert['detail']) {
      const r = rows.find((x) => x.id === id && !x.resolved_at);
      if (r) r.detail = detail;
    },
    async open(id: string, now: Date) {
      const r = rows.find((x) => x.id === id && !x.opened_at && !x.resolved_at);
      if (r) r.opened_at = iso(now);
      return !!r;
    },
    async resolve(ids: string[], now: Date) {
      let n = 0;
      for (const r of rows) if (ids.includes(r.id) && !r.resolved_at) (r.resolved_at = iso(now)), n++;
      return n;
    },
    async claimWake(ids: string[], now: Date) {
      return rows.filter((r) => ids.includes(r.id) && !r.woken_at && !r.resolved_at).map((r) => ((r.woken_at = iso(now)), r.id));
    },
    async releaseWake(ids: string[]) {
      for (const r of rows) if (ids.includes(r.id)) r.woken_at = null;
    },
    async claimNotice(ids: string[], now: Date) {
      return rows.filter((r) => ids.includes(r.id) && !r.noticed_at && !r.resolved_at).map((r) => ((r.noticed_at = iso(now)), r.id));
    },
  };
}

const t0 = new Date('2026-10-27T12:00:00.000Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const empty = (now: Date, patch: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  now, automation: true, autonomy: 'release', base_branch: 'main', prs: [], base: null, queued: [], active_runs: 0, last_run_at: null,
  tabs: [], doing: [], runs: [], machines: [], min_agent_version: '0.27.0', ...patch,
});
const readyPr = { url: 'https://github.com/o/r/pull/526', repo: 'o/r', number: 526, title: 'Fix', task_ref: 'TER-1', state: 'open' as const, draft: false, ci_state: 'passed', base_ref: 'main', merged_at: null, deploy_state: 'none', deploy_url: null, release_runs: [], wait: 'merge_base_red' };

describe('reconcile (TER-1121)', () => {
  it('opens a sign once it outlasts its minutes, keeps one alert while it lasts, and resolves it when gone', async () => {
    const store = memoryStore();
    const config = healthSchema.parse({});
    expect(await reconcile(store, 'p', empty(at(0), { prs: [readyPr] }), config)).toEqual([]);
    expect(await reconcile(store, 'p', empty(at(119), { prs: [readyPr] }), config)).toEqual([]);
    const open = await reconcile(store, 'p', empty(at(120), { prs: [readyPr] }), config);
    expect(open.map((a) => [a.signal, a.opened_at])).toEqual([['pr_ready', at(120).toISOString()]]);
    await reconcile(store, 'p', empty(at(130), { prs: [readyPr] }), config);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].opened_at).toBe(at(120).toISOString());
    // merged: the sign is gone
    expect(await reconcile(store, 'p', empty(at(135)), config)).toEqual([]);
    expect(store.rows[0].resolved_at).toBe(at(135).toISOString());
  });

  it('TER-1136: a ready PR held by a person\'s card opens at once, with the cards, and is told elsewhere', async () => {
    const store = memoryStore();
    const config = healthSchema.parse({});
    const held = { ...readyPr, wait: 'merge_person_card', wait_detail: 'PST-3' };
    const open = await reconcile(store, 'p', empty(at(0), { prs: [held] }), config);
    expect(open.map((a) => [a.signal, a.opened_at])).toEqual([['pr_ready', at(0).toISOString()]]);
    expect(open[0]!.detail).toMatchObject({ reason: 'merge_person_card', cards: 'PST-3', told_elsewhere: 1 });
  });

  it('seeing it again after it was resolved is a new episode, measured from then', async () => {
    const store = memoryStore();
    const config = healthSchema.parse({});
    const tab = (stateAt: Date) => ({ tabs: [{ id: 'a', name: 'a', state: 'working', state_at: stateAt, machine_id: 'm', run: true }] });
    expect((await reconcile(store, 'p', empty(at(30), tab(at(0))), config)).length).toBe(1);
    store.rows[0].woken_at = at(30).toISOString();
    await reconcile(store, 'p', empty(at(35), { tabs: [] }), config);
    expect(await reconcile(store, 'p', empty(at(40), tab(at(38))), config)).toEqual([]);
    expect(store.rows[0]).toMatchObject({ resolved_at: null, opened_at: null, woken_at: null, since_at: at(38).toISOString() });
    expect((await reconcile(store, 'p', empty(at(68), tab(at(38))), config)).length).toBe(1);
  });
});

describe('the watcher (TER-1121)', () => {
  const project = { id: 'p', owner_id: 'u', name: 'termhub' } as Project;
  const owner = { id: 'u', locale: 'pt-BR' } as User;

  function setup(snapshots: (now: Date) => HealthSnapshot, wake = vi.fn(async () => ({ done: Promise.resolve() }))) {
    const store = memoryStore();
    const notices: { level: string; headline: string }[] = [];
    let clock = t0;
    const repos = {
      healthAlerts: store,
      users: { findById: async () => owner },
      projects: { list: async () => [project] },
      projectSetup: { get: async () => ({ data: setupSchema.parse({ automation: { enabled: true, autonomy: 'release' } }) }) },
      chat: { findLatestActiveForProject: async () => ({ id: 'c1' }), getOrCreateForProject: async () => ({ id: 'c1' }) },
      conciergeNotices: { create: async (n: { level: string; headline: string }) => void notices.push(n) },
    } as unknown as Repositories;
    const log = { info: vi.fn(), warn: vi.fn() };
    const watcher = createHealthWatcher({ repos, chat: { wake } as never, log, now: () => clock, snapshot: async (_p, _o, _s, now) => snapshots(now) });
    return { watcher, store, notices, wake, tick: (min: number) => (clock = at(min)) };
  }

  it('the case of PRs #526–#531: a push and one wake within two hours, then quiet while the sign lasts', async () => {
    const { watcher, notices, wake, tick } = setup((now) => empty(now, { prs: [readyPr, { ...readyPr, url: 'https://github.com/o/r/pull/531', number: 531 }] }));
    for (const min of [0, 60, 115]) {
      tick(min);
      await watcher.sweep();
    }
    expect(notices).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    tick(120);
    await watcher.sweep();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: 'needs_you' });
    expect(notices[0].headline).toContain('2 sinais de trabalho parado');
    expect(wake).toHaveBeenCalledTimes(1);
    const text = (wake.mock.calls[0] as unknown[])[2] as string;
    expect(text).toMatch(/^Automático: o vigia de saúde do projeto encontrou trabalho parado \(2 sinais\)/);
    expect(text).toContain('Branch base vermelha');
    expect(text).toContain('A pessoa já recebeu push sobre isto.');
    for (const min of [125, 200, 600]) {
      tick(min);
      await watcher.sweep();
    }
    expect(notices).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a concierge sign wakes the chat without a push; a failed wake is retried later', async () => {
    const wake = vi.fn().mockRejectedValueOnce(new Error('host away')).mockResolvedValue({ done: Promise.resolve() });
    const tabs = [{ id: 'a', name: 'a', state: 'working', state_at: t0, machine_id: 'm', run: true }];
    const { watcher, store, notices, tick } = setup((now) => empty(now, { tabs }), wake);
    tick(30);
    await watcher.sweep();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.rows[0].woken_at).toBeNull();
    tick(32);
    await watcher.sweep();
    expect(wake).toHaveBeenCalledTimes(1);
    tick(36);
    await watcher.sweep();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(store.rows[0].woken_at).toBe(at(36).toISOString());
    expect(notices).toEqual([]);
  });

  it('without automatic work a light sign reaches the panel and, when it needs the person, the push — no concierge turn', async () => {
    const machines = [{ id: 'm', name: 'hulk', agent: true, online: false, last_seen_at: t0, agent_version: '0.30.0', active_run: true }];
    const { watcher, notices, wake, tick } = setup((now) => empty(now, { automation: false, machines }));
    tick(15);
    await watcher.sweep();
    expect(notices.map((n) => n.headline)).toEqual(['Máquina hulk offline com trabalho do projeto há 15 min']);
    expect(wake).not.toHaveBeenCalled();
  });

  describe('a machine that drops and comes back (TER-1135)', () => {
    const hulk = (lastSeen: Date) => ({ id: 'm', name: 'hulk', agent: true, online: false, last_seen_at: lastSeen, agent_version: '0.30.0', active_run: true });
    /** The machine offline from each `[from, to)` window, its last sighting the window's start; online otherwise. */
    const flicker = (drops: [number, number][]) => (now: Date) => {
      const drop = drops.find(([from, to]) => now >= at(from) && now < at(to));
      return empty(now, { automation: false, machines: drop ? [hulk(at(drop[0]))] : [] });
    };

    it('oscillating: one alert, one push, counted, timed from the first drop', async () => {
      const { watcher, store, notices, tick } = setup(flicker([[0, 20], [25, 45], [50, 80]]));
      for (const min of [0, 15, 20, 25, 30, 40, 45, 50, 55, 60, 70]) {
        tick(min);
        await watcher.sweep();
      }
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({ resolved_at: null, opened_at: at(15).toISOString(), since_at: t0.toISOString() });
      expect(store.rows[0].detail).toEqual({ label: 'hulk', flaps: 2 });
      expect(notices).toHaveLength(1);
    });

    it('back for good: the alert waits out the grace, then resolves; a later drop is a new episode', async () => {
      const { watcher, store, notices, tick } = setup(flicker([[0, 20], [200, 300]]));
      for (const min of [0, 15, 20, 30]) {
        tick(min);
        await watcher.sweep();
      }
      expect(store.rows[0]).toMatchObject({ resolved_at: null, detail: { label: 'hulk', back_at: at(20).toISOString() } });
      tick(79);
      await watcher.sweep();
      expect(store.rows[0].resolved_at).toBeNull();
      tick(80);
      await watcher.sweep();
      expect(store.rows[0].resolved_at).toBe(at(80).toISOString());
      for (const min of [200, 215]) {
        tick(min);
        await watcher.sweep();
      }
      expect(store.rows[0]).toMatchObject({ resolved_at: null, opened_at: at(215).toISOString(), detail: { label: 'hulk' } });
      expect(notices).toHaveLength(2);
    });

    it('holding only tabs stuck for days: no machine alert', async () => {
      const tabs = [{ id: 'TER-742', name: 'TER-742', state: 'working', state_at: at(-3 * 24 * 60), machine_id: 'm', run: false }];
      const { watcher, store, notices, tick } = setup((now) => empty(now, { automation: false, tabs, machines: [{ ...hulk(t0), active_run: false }] }));
      for (const min of [0, 30]) {
        tick(min);
        await watcher.sweep();
      }
      expect(store.rows.map((r) => r.signal)).toEqual(['tab_stuck']);
      expect(notices).toEqual([]);
    });
  });

  it('a red base is on the panel only (the merge executor tells it, TER-1120); a base that never finishes is told', async () => {
    // the base has no start time of its own: it is timed from the first sweep that sees it
    const red = setup((now) => empty(now, { base: { state: 'red', sha: 'abc1234', failing: ['CI'] } }));
    await red.watcher.sweep();
    red.tick(30);
    await red.watcher.sweep();
    expect(red.store.rows[0]).toMatchObject({ signal: 'base_red', opened_at: at(30).toISOString(), noticed_at: null, woken_at: null });
    expect(red.notices).toEqual([]);
    expect(red.wake).not.toHaveBeenCalled();

    const stuck = setup((now) => empty(now, { base: { state: 'pending', sha: 'abc1234', failing: ['TestFlight'] } }));
    await stuck.watcher.sweep();
    stuck.tick(30);
    await stuck.watcher.sweep();
    expect(stuck.notices.map((n) => n.headline)).toEqual(['Branch base main com a CI sem terminar há 30 min: sem terminar: TestFlight']);
    expect(stuck.wake).toHaveBeenCalledTimes(1);
  });
});
