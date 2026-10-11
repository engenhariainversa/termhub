import { afterEach, describe, expect, it } from 'vitest';
import { controlContextFor } from '../control/context.js';
import type { AutomationEvent, AutomationEventInput, Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { normalizeSetup } from '../setup/schema.js';
import { automationBus, recordEvent, type AutomationEventPayload } from './events.js';
import { interruptRuns, isPaused, pauseAutomation, resumeAutomation } from './pause.js';

/** In-memory stand-ins for the repositories the pause switch and the event log touch. */
function fakeRepos(opts: { enabled?: Record<string, boolean>; runs?: Array<{ id: string; project_id: string; tab_id: string | null }>; tabState?: Record<string, string> } = {}) {
  const projects = [
    { id: 'p1', owner_id: 'u1', name: 'one' },
    { id: 'p2', owner_id: 'u1', name: 'two' },
    { id: 'p9', owner_id: 'u9', name: 'foreign' },
  ];
  const userPause = new Map<string, Date>();
  const projectPause = new Map<string, Date>();
  const events: AutomationEvent[] = [];
  const pause = (m: Map<string, Date>, id: string, at: Date) => {
    const fresh = !m.has(id);
    if (fresh) m.set(id, at);
    return { paused_at: m.get(id)!, fresh };
  };
  const repos = {
    projects: {
      findById: async (id: string) => projects.find((p) => p.id === id),
      list: async (f?: { owner?: string | null }) => projects.filter((p) => !f?.owner || p.owner_id === f.owner),
    },
    projectSetup: {
      get: async (id: string) => ({ project_id: id, version: 2, data: normalizeSetup({ automation: { enabled: opts.enabled?.[id] ?? false } }, 2), updated_at: null }),
    },
    automationPauses: {
      state: async (ownerId: string | null, projectId: string) => ({ user: (ownerId && userPause.get(ownerId)) || null, project: projectPause.get(projectId) ?? null }),
      userPausedAt: async (id: string) => userPause.get(id) ?? null,
      pauseUser: async (id: string, at: Date) => pause(userPause, id, at),
      resumeUser: async (id: string) => userPause.delete(id),
      pauseProject: async (id: string, at: Date) => pause(projectPause, id, at),
      resumeProject: async (id: string) => projectPause.delete(id),
    },
    automationRuns: {
      activeByProject: async (projectId: string) => (opts.runs ?? []).filter((r) => r.project_id === projectId),
    },
    tabs: {
      findById: async (id: string) => ({ id, state: opts.tabState?.[id] ?? 'working' }),
    },
    automationEvents: {
      insert: async (e: AutomationEventInput) => {
        const row: AutomationEvent = { id: `e${events.length}`, project_id: e.project_id, task_id: e.task_id ?? null, run_id: e.run_id ?? null, kind: e.kind, payload: e.payload ?? {}, created_at: new Date().toISOString() };
        events.push(row);
        return row;
      },
    },
  } as unknown as Repositories;
  const ctx = controlContextFor(repos, { id: 'u1' } as User);
  return { repos, ctx, events };
}

describe('isPaused', () => {
  it('is false when neither the user nor the project is paused', async () => {
    const { repos } = fakeRepos();
    expect(await isPaused(repos, 'u1', 'p1')).toBe(false);
  });

  it('is true for a user pause ("Pausar tudo") on every project of that user', async () => {
    const { repos, ctx } = fakeRepos();
    await pauseAutomation(ctx, { scope: 'all' });
    expect(await isPaused(repos, 'u1', 'p1')).toBe(true);
    expect(await isPaused(repos, 'u1', 'p2')).toBe(true);
    expect(await isPaused(repos, 'u9', 'p9')).toBe(false);
  });

  it('is true for a project pause on that project only', async () => {
    const { repos, ctx } = fakeRepos();
    await pauseAutomation(ctx, { scope: 'p1' });
    expect(await isPaused(repos, 'u1', 'p1')).toBe(true);
    expect(await isPaused(repos, 'u1', 'p2')).toBe(false);
  });

  it('an orphan project (no owner) only reads its own pause', async () => {
    const { repos, ctx } = fakeRepos();
    await pauseAutomation(ctx, { scope: 'all' });
    expect(await isPaused(repos, null, 'p1')).toBe(false);
  });
});

describe('pauseAutomation / resumeAutomation', () => {
  it('pause then resume of a project records paused then resumed', async () => {
    const { ctx, events } = fakeRepos();
    const { paused_at } = await pauseAutomation(ctx, { scope: 'p1' });
    expect(Number.isNaN(Date.parse(paused_at))).toBe(false);
    await resumeAutomation(ctx, { scope: 'p1' });
    expect(events.map((e) => [e.project_id, e.kind, e.payload])).toEqual([
      ['p1', 'paused', { scope: 'project', interrupt: false }],
      ['p1', 'resumed', { scope: 'project' }],
    ]);
  });

  it('pausing twice keeps the first timestamp and records one event', async () => {
    const { ctx, events } = fakeRepos();
    const first = await pauseAutomation(ctx, { scope: 'p1' });
    const second = await pauseAutomation(ctx, { scope: 'p1' });
    expect(second.paused_at).toBe(first.paused_at);
    expect(events).toHaveLength(1);
  });

  it('resuming what is not paused records nothing', async () => {
    const { ctx, events } = fakeRepos();
    await resumeAutomation(ctx, { scope: 'all' });
    await resumeAutomation(ctx, { scope: 'p1' });
    expect(events).toEqual([]);
  });

  const runs = [
    { id: 'r1', project_id: 'p1', tab_id: 'tab-1' },
    { id: 'r2', project_id: 'p1', tab_id: null }, // not started yet: no tab
    { id: 'r3', project_id: 'p2', tab_id: 'tab-3' },
    { id: 'r9', project_id: 'p9', tab_id: 'tab-9' },
  ];

  it('interrupt sends Escape to the tabs of the paused project\'s active runs, and records it', async () => {
    const { ctx, events } = fakeRepos({ runs });
    const pressed: string[] = [];
    await pauseAutomation(ctx, { scope: 'p1', interrupt: true }, { press: async (id) => void pressed.push(id) });
    expect(events[0]!.payload).toEqual({ scope: 'project', interrupt: true });
    expect(pressed).toEqual(['tab-1']);
  });

  it('a plain pause sends no key', async () => {
    const { ctx } = fakeRepos({ runs, enabled: { p1: true, p2: true } });
    const pressed: string[] = [];
    await pauseAutomation(ctx, { scope: 'p1' }, { press: async (id) => void pressed.push(id) });
    await pauseAutomation(ctx, { scope: 'all' }, { press: async (id) => void pressed.push(id) });
    expect(pressed).toEqual([]);
  });

  it('"Pausar e interromper" on all reaches every automated project of the person, never another person\'s', async () => {
    const { ctx } = fakeRepos({ runs, enabled: { p1: true, p2: true, p9: true } });
    const pressed: string[] = [];
    await pauseAutomation(ctx, { scope: 'all', interrupt: true }, { press: async (id) => void pressed.push(id) });
    expect(pressed.sort()).toEqual(['tab-1', 'tab-3']);
  });

  it('a tab that fails to take the key does not keep the others from stopping', async () => {
    const { ctx } = fakeRepos({ runs: [...runs, { id: 'r4', project_id: 'p1', tab_id: 'tab-4' }] });
    const pressed: string[] = [];
    await pauseAutomation(ctx, { scope: 'p1', interrupt: true }, {
      press: async (id) => {
        if (id === 'tab-1') throw new Error('offline');
        pressed.push(id);
      },
    });
    expect(pressed).toEqual(['tab-4']);
  });

  it('"Pausar tudo" records on the projects with automation on, and never on one with it off', async () => {
    const { ctx, events } = fakeRepos({ enabled: { p1: true, p2: false } });
    await pauseAutomation(ctx, { scope: 'all' });
    await resumeAutomation(ctx, { scope: 'all' });
    expect(events.map((e) => [e.project_id, e.kind])).toEqual([
      ['p1', 'paused'],
      ['p1', 'resumed'],
    ]);
  });

  it('a project outside the scope is not found', async () => {
    const { ctx, events } = fakeRepos();
    await expect(pauseAutomation(ctx, { scope: 'p9' })).rejects.toThrow();
    expect(events).toEqual([]);
  });
});

describe('interruptRuns', () => {
  it('onlyWorking leaves tabs that are not in a turn alone', async () => {
    const { repos } = fakeRepos({ runs: [{ id: 'r1', project_id: 'p1', tab_id: 'a' }, { id: 'r2', project_id: 'p1', tab_id: 'b' }], tabState: { a: 'working', b: 'waiting_input' } });
    const pressed: string[] = [];
    expect(await interruptRuns(repos, ['p1'], { onlyWorking: true, press: async (id) => void pressed.push(id) })).toBe(1);
    expect(pressed).toEqual(['a']);
  });
});

describe('recordEvent', () => {
  let off = () => {};
  afterEach(() => off());

  it('drops strings over 500 characters and publishes to the owner', async () => {
    const { repos, events } = fakeRepos();
    const seen: Array<AutomationEvent & { owner_id: string }> = [];
    off = automationBus.subscribe((e) => seen.push(e));
    await recordEvent(repos, { project_id: 'p1', task_id: 't1', kind: 'pr_opened', payload: { url: 'https://github.com/a/b/pull/1', long: 'x'.repeat(501), ok: 'y'.repeat(500), n: 3, f: false, z: null } });
    expect(events[0]!.payload).toEqual({ url: 'https://github.com/a/b/pull/1', ok: 'y'.repeat(500), n: 3, f: false, z: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ owner_id: 'u1', project_id: 'p1', task_id: 't1', kind: 'pr_opened' });
  });

  it('drops a nested value that slipped past the type', async () => {
    const { repos, events } = fakeRepos();
    await recordEvent(repos, { project_id: 'p1', kind: 'run_done', payload: { nested: { a: 1 } as unknown as string, n: 1 } });
    expect(events[0]!.payload).toEqual({ n: 1 });
  });

  it('the payload type refuses nested objects (compile time)', () => {
    // @ts-expect-error — a payload is flat: strings, numbers, booleans and nulls only
    const bad: AutomationEventPayload = { nested: { a: 1 } };
    expect(bad).toBeDefined();
  });
});
