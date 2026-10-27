import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import type { TabStateChange } from '../monitor/bus.js';

vi.mock('./watches/view.js', () => ({ publishWatches: vi.fn(async () => {}) }));

const { TRUST_WAKE_NOTE, wakeOnTrustPrompt } = await import('./trust-wake.js');

const AT = '2026-10-24T18:00:00.000Z';
const change = (over: Partial<Tab> = {}, owner: string | null = 'u1'): TabStateChange => ({
  tab: { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'api', state: 'trust_prompt', state_at: AT, ...over } as Tab,
  project_id: 'p1',
  machine_id: 'm1',
  owner_id: owner,
});
const log = () => ({ info: vi.fn(), warn: vi.fn() });

function setup(opts: { run?: boolean; watched?: string[][]; open?: number; conversation?: boolean } = {}) {
  const create = vi.fn(async (w: Record<string, unknown>) => ({ id: 'w1', ...w }));
  const repos = {
    automationRuns: { activeByTab: vi.fn(async () => (opts.run ? { id: 'r1' } : undefined)) },
    chatWatches: {
      listAllOpen: vi.fn(async () => (opts.watched ?? []).map((events, i) => ({ id: `w${i}`, params: { events } }))),
      countOpen: vi.fn(async () => opts.open ?? 0),
      create,
    },
    chat: {
      findLatestActiveForProject: vi.fn(async () => (opts.conversation === false ? undefined : { id: 'c1' })),
      getOrCreateForProject: vi.fn(async () => ({ id: 'c-new' })),
    },
  } as unknown as Repositories;
  return { repos, create, nudge: vi.fn() };
}

describe('wakeOnTrustPrompt — the folder trust dialog wakes the chat (TER-1117)', () => {
  it("registers a watch already behind the event in the project's chat, and nudges the engine", async () => {
    const { repos, create, nudge } = setup();
    expect(await wakeOnTrustPrompt(repos, log() as never, change(), nudge)).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'u1',
        project_id: 'p1',
        conversation_id: 'c1',
        kind: 'tab',
        target_id: 't1',
        params: { events: ['trust_prompt'] },
        baseline: { cursor: new Date(Date.parse(AT) - 1000).toISOString() },
        label: 'api',
        note: TRUST_WAKE_NOTE,
        recurring: false,
      }),
      expect.any(Date),
    );
    expect(nudge).toHaveBeenCalledWith('t1');
  });

  it('a project nobody chats in gets its chat', async () => {
    const { repos, create } = setup({ conversation: false });
    await wakeOnTrustPrompt(repos, log() as never, change(), vi.fn());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: 'c-new' }), expect.any(Date));
  });

  it("leaves it to start_agent's watch, to an automatic run's follower, and to a full chat", async () => {
    for (const opts of [{ watched: [['finished', 'trust_prompt']] }, { run: true }, { open: 30 }]) {
      const { repos, create, nudge } = setup(opts);
      expect(await wakeOnTrustPrompt(repos, log() as never, change(), nudge)).toBe(false);
      expect(create).not.toHaveBeenCalled();
      expect(nudge).not.toHaveBeenCalled();
    }
  });

  it('another state, or a machine with no owner, does nothing', async () => {
    const { repos, create } = setup();
    expect(await wakeOnTrustPrompt(repos, log() as never, change({ state: 'working' }), vi.fn())).toBe(false);
    expect(await wakeOnTrustPrompt(repos, log() as never, change({}, null), vi.fn())).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('a watch on the tab for other stops only still wakes', async () => {
    const { repos, create } = setup({ watched: [['finished']] });
    expect(await wakeOnTrustPrompt(repos, log() as never, change(), vi.fn())).toBe(true);
    expect(create).toHaveBeenCalled();
  });
});
