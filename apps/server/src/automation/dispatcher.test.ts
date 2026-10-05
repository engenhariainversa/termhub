import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
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
  automationRuns: { cancelOrphaned: async () => [], heartbeat: async () => {}, takeOver: async () => [] },
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

  it('with no project on automation, a tick only runs the sweep and lists the enabled projects', async () => {
    const { repos, calls } = recordingRepos(idle());
    const startAgent = vi.fn();
    const d = startDispatcher(deps(repos, { startAgent: startAgent as unknown as DispatcherDeps['startAgent'] }), { schedule: false });
    await d.tick('t');
    await d.stop();
    expect(calls).toEqual(['automationRuns.cancelOrphaned', 'projectSetup.listWithAutomation']);
    expect(startAgent).not.toHaveBeenCalled();
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

  it('the instance id is unique per process start, not a colour name', () => {
    const a = dispatcherInstanceId();
    const b = dispatcherInstanceId();
    expect(a).not.toBe(b);
    expect(a).toContain(`-${process.pid}-`);
  });
});
