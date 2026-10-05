import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../generated/prisma/client.js';
import { AGENT_EXITED_TEXT } from '../chat/agent-exited.js';
import { controlContextFor } from '../control/context.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { newId } from '../lib/ids.js';
import { normalizeSetup } from '../setup/schema.js';
import { createLifecycle, drain } from '../ws/drain.js';
import type { Dispatcher, DispatcherDeps } from './dispatcher.js';
import { PR_GRACE_MS, type FollowerDeps } from './follower.js';
import { pauseAutomation } from './pause.js';
import { resetWaiting } from './placement.js';
import { RESUME_TEXT, serverMessage } from './prompts.js';

// The agent registry, as the dispatcher, the queue and the placement read it: which machines are online
// with the worktree capability.
const reg = vi.hoisted(() => ({ online: new Set<string>() }));
vi.mock('../agent/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../agent/registry.js')>();
  return {
    ...real,
    agents: {
      isOnline: (id: string) => reg.online.has(id),
      capabilities: (id: string) => (reg.online.has(id) ? ['worktree'] : null),
    },
  };
});

const keyOf = (id: string) => 'C' + id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
const MIN = 60_000;

/** A start or a line typed into a tab, by which colour, in which order. */
interface Act {
  instance: string;
  id: string;
  text?: string;
  seq: number;
}

/**
 * Two server colours side by side during a deploy (spec D11, §8 step 7; plan Review Focus 1). Each colour
 * is its own copy of the dispatcher and follower modules (as two processes would be: nothing in memory is
 * shared), over one real database, with fakes for the agent start, the typing and GitHub.
 */
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('automation across colours (Postgres)', () => {
  let db: PrismaClient;
  let repos: Repositories;
  let ownerId: string;
  let projectId: string;
  let machineId: string;
  let accountId: string;
  let todoId: string;
  let seq = 0;
  let starts: Act[] = [];
  let typed: Act[] = [];
  const stopped: Array<() => Promise<void>> = [];

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    repos = createRepositories(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function setSetup(automation: Record<string, unknown> = {}) {
    const { data } = await repos.projectSetup.get(projectId);
    const next = normalizeSetup(
      { ...data, repo: { integration_id: 'int-1', full_name: 'acme/app' }, ai: { accounts: [accountId], models: {} }, automation: { ...data.automation, enabled: true, ...automation } },
      2,
    );
    await repos.projectSetup.save(projectId, next);
  }

  beforeEach(async () => {
    ownerId = newId();
    projectId = newId();
    machineId = newId();
    starts = [];
    typed = [];
    seq = 0;
    reg.online.clear();
    resetWaiting();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@test.local`, name: 'owner' } });
    await db.project.create({ data: { id: projectId, ownerId, key: keyOf(projectId), name: 'p' } });
    await db.machine.create({ data: { id: machineId, name: 'm', type: 'agent', ownerId, capabilities: ['claude'], agentVersion: '0.18.0' } });
    await repos.projectMachines.link({ project_id: projectId, machine_id: machineId, cwd: '/home/u/app' });
    accountId = (await repos.aiAccounts.create({ provider: 'claude', label: 'main', machine_id: machineId })).id;
    reg.online.add(machineId);
    const seed = await repos.tasks.create(projectId, { title: 'seed' }); // creates the default columns
    todoId = (await db.taskColumn.findFirst({ where: { projectId, category: 'todo' }, orderBy: { position: 'asc' } }))!.id;
    await repos.tasks.delete(seed.id);
    await setSetup();
    return async () => {
      for (const stop of stopped.splice(0)) await stop();
      await db.project.delete({ where: { id: projectId } });
      await db.machine.deleteMany({ where: { id: machineId } });
      await db.user.delete({ where: { id: ownerId } });
    };
  });

  const cards = async (n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push((await repos.tasks.create(projectId, { title: `Card ${i}`, column_id: todoId, auto: true, description: 'faça isto' })).id);
    return out;
  };
  const runsOf = () => db.automationRun.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  const ctx = () => controlContextFor(repos, { id: ownerId } as User);
  /** A short random wait, so two colours interleave their database round trips. */
  const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 4));

  /** The fake `startAgent`: opens a real tab row (the follower reads it) and records who started what. */
  function fakeStartAgent(instance: string) {
    return vi.fn(async (_ctx: unknown, input: { project_id: string; machine_id: string; task_id?: string }) => {
      await jitter();
      const tabId = newId();
      await db.tab.create({ data: { id: tabId, projectId: input.project_id, machineId: input.machine_id, name: 'auto' } });
      starts.push({ instance, id: input.task_id!, seq: ++seq });
      return { tab_id: tabId } as never;
    });
  }

  type Colour = {
    instance: string;
    lifecycle: { draining: boolean };
    dispatcher: Dispatcher;
    follower: typeof import('./follower.js');
    followerDeps: FollowerDeps;
    /** The follower's clock (the dispatcher keeps the real one: takeovers are measured on the database's). */
    setNow(d: Date): void;
  };

  /**
   * One colour: its own module copies (a fresh `import`, so the follower's in-memory maps are its own, as in
   * a separate process), its own instance id and lifecycle, wired as app.ts wires them.
   */
  async function colour(instance: string, over: Partial<DispatcherDeps> = {}): Promise<Colour> {
    vi.resetModules();
    const D = await import('./dispatcher.js');
    const F = await import('./follower.js');
    const lifecycle = { draining: false };
    let now: Date | null = null;
    const followerDeps: FollowerDeps = {
      repos,
      instance,
      lifecycle,
      settleMs: 0,
      now: () => now ?? new Date(),
      type: async (_ctx, tabId, text) => void typed.push({ instance, id: tabId, text, seq: ++seq }),
      restartLine: async () => 'claude --resume s1',
    };
    const dispatcher = D.startDispatcher(
      {
        repos,
        instance,
        lifecycle,
        now: () => new Date(),
        startAgent: fakeStartAgent(instance) as unknown as DispatcherDeps['startAgent'],
        ensureWorkspace: (async (_m: unknown, i: { projectId: string; ref: string }) => ({ path: `/w/${i.projectId}/${i.ref}`, created: true })) as unknown as DispatcherDeps['ensureWorkspace'],
        ensureEpicBranch: (async () => {}) as unknown as DispatcherDeps['ensureEpicBranch'],
        removeWorkspace: (async () => ({ removed: true, dirty: false })) as unknown as DispatcherDeps['removeWorkspace'],
        closeTab: async () => {},
        gh: {} as GithubWriteClient,
        usage: async () => 10,
        onTakeOver: (run) => void F.followRun(followerDeps, run.id),
        ...over,
      },
      { schedule: false },
    );
    stopped.push(() => dispatcher.stop());
    return { instance, lifecycle, dispatcher, follower: F, followerDeps, setNow: (d) => (now = d) };
  }

  const tick = async (c: Colour) => {
    await c.dispatcher.tick('test');
    await c.dispatcher.settle();
  };
  /** Both colours tick `rounds` times, at the same time. */
  const tickBoth = async (a: Colour, b: Colour, rounds = 3) => {
    for (let i = 0; i < rounds; i++) await Promise.all([tick(a), tick(b)]);
  };
  /** The colour went silent this long ago: its heartbeats stopped (the database's clock). */
  const silence = (c: Colour, ms: number) => db.automationRun.updateMany({ where: { claimedBy: c.instance }, data: { heartbeatAt: new Date(Date.now() - ms) } });
  /** The tab stopped (`waiting_input`) or the agent exited (`idle` + AGENT_EXITED_TEXT), `agoMs` ago. */
  const tabState = (tabId: string, kind: 'stop' | 'exit', agoMs = 10 * MIN) =>
    db.tab.update({
      where: { id: tabId },
      data: kind === 'stop' ? { state: 'waiting_input', stateText: 'Pronto.', stateTool: 'claude', stateAt: new Date(Date.now() - agoMs) } : { state: 'idle', stateText: AGENT_EXITED_TEXT, stateTool: 'claude', stateAt: new Date(Date.now() - agoMs) },
    });
  const sweep = (c: Colour) => c.follower.sweepRuns(c.followerDeps);
  const startsPerCard = () => {
    const m = new Map<string, number>();
    for (const s of starts) m.set(s.id, (m.get(s.id) ?? 0) + 1);
    return m;
  };

  it('two colours ticking at once over 10 cards start exactly 10 runs, each card once', async () => {
    const ids = await cards(10);
    const [blue, green] = [await colour('blue'), await colour('green')];
    await tickBoth(blue, green);

    expect(starts).toHaveLength(10);
    expect([...startsPerCard().keys()].sort()).toEqual([...ids].sort());
    expect([...startsPerCard().values()].every((n) => n === 1)).toBe(true);
    const runs = await runsOf();
    expect(runs).toHaveLength(10);
    expect(runs.every((r) => r.status === 'running' && r.tabId)).toBe(true);
    // each run is driven by the colour that started its agent
    for (const r of runs) expect(r.claimedBy).toBe(starts.find((s) => s.id === r.taskId)!.instance);
  });

  it('20 eligible cards with no ceiling start 20 runs (M1)', async () => {
    await setSetup({ max_parallel: null });
    await cards(20);
    const [blue, green] = [await colour('blue'), await colour('green')];
    await tickBoth(blue, green, 2);
    expect(starts).toHaveLength(20);
    expect(startsPerCard().size).toBe(20);
    expect((await runsOf()).filter((r) => r.status === 'running')).toHaveLength(20);
  });

  it('a stopped colour\'s runs are taken over by the other after 3 min of silence, with no second start, and followed there', async () => {
    await cards(10);
    const [blue, green] = [await colour('blue'), await colour('green')];
    await tickBoth(blue, green);
    const blueRuns = (await runsOf()).filter((r) => r.claimedBy === 'blue');
    expect(blueRuns.length).toBeGreaterThan(0);

    // blue stops (its heartbeat with it) while one of its tabs stops; three minutes pass
    await blue.dispatcher.stop();
    await tabState(blueRuns[0]!.tabId!, 'stop');
    await silence(blue, 3 * MIN);
    await green.dispatcher.heartbeat();
    await tick(green);
    // the takeover's own look at the tab (onTakeOver) runs in the background
    await vi.waitFor(() => expect(typed).toHaveLength(1));

    const runs = await runsOf();
    expect(runs.filter((r) => r.claimedBy === 'green')).toHaveLength(10);
    expect(runs.every((r) => r.status === 'running')).toBe(true);
    expect(starts).toHaveLength(10); // no second startAgent
    expect((await repos.automationRuns.followedBy('green')).map((r) => r.id).sort()).toEqual(runs.map((r) => r.id).sort());
    // the stop that happened while nobody followed it is resumed by the new colour, once
    expect(typed).toEqual([expect.objectContaining({ instance: 'green', id: blueRuns[0]!.tabId, text: serverMessage(RESUME_TEXT) })]);
    await sweep(green);
    expect(typed).toHaveLength(1);
  });

  it('a draining colour claims nothing and types nothing, keeps its own runs alive and takes none; the other colour carries on', async () => {
    const ids = await cards(4);
    const [blue, green] = [await colour('blue'), await colour('green')];
    await tick(blue);
    expect(starts).toHaveLength(4);
    await cards(3);
    // a third, silent instance left a run behind
    const orphanCard = (await cards(1))[0]!;
    const orphan = (await repos.automationRuns.claim({ project_id: projectId, task_id: orphanCard, role: 'implementer', instance: 'gone' }))!;
    await repos.automationRuns.update(orphan.id, 'gone', { status: 'running', tab_id: 'tab-gone' });

    blue.lifecycle.draining = true; // SIGTERM on blue
    for (const r of (await runsOf()).filter((x) => ids.slice(0, 2).includes(x.taskId!))) await tabState(r.tabId!, 'stop');
    await silence(blue, 30_000);
    await db.automationRun.update({ where: { id: orphan.id }, data: { heartbeatAt: new Date(Date.now() - 5 * MIN) } });
    await tick(blue);
    await sweep(blue);
    await blue.dispatcher.heartbeat();

    expect(starts).toHaveLength(4);
    expect(typed).toEqual([]);
    const afterBlue = await runsOf();
    expect(afterBlue.find((r) => r.id === orphan.id)!.claimedBy).toBe('gone');
    for (const r of afterBlue.filter((x) => x.claimedBy === 'blue')) expect(Date.now() - r.heartbeatAt.getTime()).toBeLessThan(10_000);

    await green.dispatcher.heartbeat();
    await tick(green);
    expect(starts).toHaveLength(7);
    expect(starts.slice(4).every((s) => s.instance === 'green')).toBe(true);
    expect((await runsOf()).find((r) => r.id === orphan.id)!.claimedBy).toBe('green');
  });

  it('a colour that boots on runs already running starts nothing for them, fresh or taken over', async () => {
    const ids = await cards(5);
    const old = await colour('old');
    await tick(old);
    expect(starts).toHaveLength(5);
    await old.dispatcher.stop();

    // boot while the old colour still beats: nothing to start
    const fresh = await colour('fresh');
    await fresh.dispatcher.heartbeat();
    await tick(fresh);
    expect(starts).toHaveLength(5);
    expect((await runsOf()).every((r) => r.claimedBy === 'old')).toBe(true);

    // the old colour went silent: the runs move over, still no start
    await silence(old, 3 * MIN);
    await fresh.dispatcher.heartbeat();
    await tick(fresh);
    expect(starts).toHaveLength(5);
    const runs = await runsOf();
    expect(runs.map((r) => [r.taskId, r.status, r.claimedBy]).sort()).toEqual(ids.map((id) => [id, 'running', 'fresh']).sort());
  });

  describe('a line typed by one colour is not typed again by the one that takes over', () => {
    async function handover(kind: 'stop' | 'exit') {
      await cards(1);
      const blue = await colour('blue');
      await tick(blue);
      const [run] = await runsOf();
      await tabState(run!.tabId!, kind);
      await sweep(blue);
      expect(typed).toEqual([expect.objectContaining({ instance: 'blue', id: run!.tabId })]);

      // blue dies right after typing; green takes the run over and looks at the same, unchanged tab
      await blue.dispatcher.stop();
      await silence(blue, 3 * MIN);
      const green = await colour('green');
      green.setNow(new Date(Date.now() + 5_000));
      await green.dispatcher.heartbeat();
      await sweep(green); // after the takeover's own look (onTakeOver): one follow at a time per run
      return { run: run!, green };
    }

    it('a resume', async () => {
      const { run, green } = await handover('stop');
      expect(typed).toHaveLength(1);
      expect((await repos.automationRuns.findById(run.id))).toMatchObject({ status: 'running', resume_count: 1, claimed_by: 'green' });

      // the tab moves on (the agent took the resume and stopped again): the new colour acts on the new stop
      await tabState(run.tabId!, 'stop', 0);
      green.setNow(new Date(Date.now() + PR_GRACE_MS + MIN));
      await sweep(green);
      expect(typed.map((t) => t.instance)).toEqual(['blue', 'green']);
    });

    it('a restart (never read as a second exit, which would block the run)', async () => {
      const { run } = await handover('exit');
      expect(typed).toHaveLength(1);
      expect(await repos.automationRuns.findById(run.id)).toMatchObject({ status: 'running', restart_count: 1, claimed_by: 'green' });
    });

    it('past the retype delay a line that got lost is typed again', async () => {
      const { run, green } = await handover('stop');
      green.setNow(new Date(Date.now() + 11 * MIN));
      await sweep(green);
      expect(typed.map((t) => [t.instance, t.id])).toEqual([
        ['blue', run.tabId],
        ['green', run.tabId],
      ]);
    });
  });

  it('a pause during a burst: nothing is claimed, started or typed once it is in, within one tick (D24)', async () => {
    await setSetup({ max_parallel: null });
    await cards(20);
    let pausedAt = -1;
    let unstartedAtPause = -1;
    let gate = 0;
    const blue = await colour('blue', {
      startAgent: (async (c: unknown, input: { project_id: string; machine_id: string; task_id?: string }) => {
        const r = await fakeStartAgent('blue')(c, input);
        if (++gate === 3) {
          await pauseAutomation(ctx(), { scope: projectId });
          pausedAt = seq;
          // runs claimed but not started yet: only these may still pass a check made before the pause landed
          unstartedAtPause = await db.automationRun.count({ where: { projectId, status: { in: ['queued', 'starting'] } } });
        }
        return r;
      }) as unknown as DispatcherDeps['startAgent'],
    });
    const green = await colour('green');
    await Promise.all([tick(blue), tick(green)]);

    expect(pausedAt).toBeGreaterThan(0);
    const late = starts.filter((s) => s.seq > pausedAt);
    expect(late.length).toBeLessThanOrEqual(unstartedAtPause);
    expect(starts.length).toBeLessThan(20);

    // the next tick of either colour, and their followers, do nothing more
    const before = starts.length;
    const tabs = (await runsOf()).filter((r) => r.tabId).map((r) => r.tabId!);
    for (const t of tabs) await tabState(t, 'stop');
    await Promise.all([tick(blue), tick(green), sweep(blue), sweep(green)]);
    expect(starts).toHaveLength(before);
    expect(typed).toEqual([]);
    expect(await db.automationRun.count({ where: { projectId, status: { in: ['queued', 'starting'] } } })).toBe(0);
  });

  it('app wiring: the drain on SIGTERM flips the lifecycle the dispatcher and the follower read', async () => {
    const { startAutomation } = await import('./start.js');
    await cards(1);
    const lifecycle = createLifecycle();
    const automation = startAutomation({
      repos,
      lifecycle,
      instance: 'wired',
      schedule: false,
      dispatcher: {
        startAgent: fakeStartAgent('wired') as unknown as DispatcherDeps['startAgent'],
        ensureWorkspace: (async () => ({ path: '/w/x', created: true })) as unknown as DispatcherDeps['ensureWorkspace'],
        ensureEpicBranch: (async () => {}) as unknown as DispatcherDeps['ensureEpicBranch'],
        gh: {} as GithubWriteClient,
        usage: async () => 10,
      },
      follower: { type: async (_c, tabId, text) => void typed.push({ instance: 'wired', id: tabId, text, seq: ++seq }), settleMs: 0 },
    });
    stopped.push(() => automation.stop());
    await automation.dispatcher.tick('test');
    await automation.dispatcher.settle();
    expect(starts).toHaveLength(1);

    await drain({ lifecycle, suspend: async () => {}, closeAgents: () => 0, servers: [], log: { info: () => {}, warn: () => {} } });
    await cards(1);
    const [run] = await runsOf();
    await tabState(run!.tabId!, 'stop');
    await automation.dispatcher.tick('test');
    await automation.dispatcher.settle();
    const { sweepRuns } = await import('./follower.js');
    await sweepRuns(automation.followerDeps);
    expect(automation.followerDeps.lifecycle).toBe(lifecycle);
    expect(starts).toHaveLength(1);
    expect(typed).toEqual([]);
  });
});
