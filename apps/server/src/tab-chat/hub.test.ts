import { EventEmitter } from 'node:events';
import type { TTabChatFrame } from '@termhub/mobile-api';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import type { TabStateChange } from '../monitor/bus.js';
import { TabChatHub, type HubRepos } from './hub.js';
import type { Cursor, Forward } from './reader.js';
import type { TabChatItem } from './transcript.js';

const SID = '11111111-2222-4333-8444-555555555555';
const NEW_SID = '99999999-2222-4333-8444-555555555555';
const machine = { id: 'm1', name: 'box', type: 'agent' } as Machine;
const project = { id: 'p1', key: 'TH', name: 'termhub' } as Project;

/** A transcript that grows by 10 bytes per item; `read` behaves like the real one over it. */
function fakeFile() {
  const files = new Map<string, { end: number; item: TabChatItem }[]>();
  const entries = (session: string) => files.get(session) ?? files.set(session, []).get(session)!;
  const size = (session: string) => entries(session).at(-1)?.end ?? 0;
  return {
    append(session: string, text: string) {
      const end = size(session) + 10;
      entries(session).push({ end, item: { kind: 'assistant', id: `${session.slice(0, 2)}-${end}`, at: '', text } });
    },
    read: vi.fn(async (_m: Machine, tab: Tab, after: Cursor): Promise<Forward> => {
      const s = tab.agent_session_id!;
      const from = Math.min(after.offset, size(s));
      const items = entries(s)
        .filter((e) => e.end > from)
        .map((e) => e.item);
      return { items, live: `${s}.${size(s)}`, mode: null, missing: false, more: false, known: items.length, unknown: 0 };
    }),
  };
}

function setup(over: Partial<Tab> = {}) {
  let row = {
    id: 't1',
    name: 'api',
    project_id: 'p1',
    machine_id: 'm1',
    kind: 'terminal',
    state: 'waiting_input',
    state_at: null,
    state_seen_at: null,
    state_tool: 'claude',
    activity: null,
    activity_verb: null,
    agent_session_id: SID,
    agent_transcript_path: `/h/.claude/projects/-w/${SID}.jsonl`,
    ...over,
  } as Tab;
  const repos = {
    tabs: { findById: vi.fn(async (id: string) => (id === row.id ? row : undefined)) },
    machines: { findById: vi.fn(async () => machine) },
    projects: { findById: vi.fn(async () => project) },
  } satisfies HubRepos;
  const listeners = new Set<(c: TabStateChange) => void>();
  const bus = {
    subscribe: (l: (c: TabStateChange) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const agentEvents = new EventEmitter();
  const agent = { online: true, caps: ['transcript'] as string[] | null };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
  const file = fakeFile();
  const hub = new TabChatHub({
    repos,
    log,
    read: file.read,
    bus,
    agent: { isOnline: () => agent.online, capabilities: () => agent.caps },
    agentEvents,
    tickMs: 1000,
  });
  const subscriber = () => {
    const frames: TTabChatFrame[] = [];
    return { frames, sub: { send: (f: TTabChatFrame) => frames.push(f) } };
  };
  const ids = (frames: TTabChatFrame[]) => frames.flatMap((f) => (f.type === 'items' ? f.items.map((i) => i.id) : []));
  return {
    hub,
    repos,
    file,
    agent,
    agentEvents,
    log,
    subscriber,
    ids,
    setTab: (o: Partial<Tab>) => (row = { ...row, ...o }),
    emit: (tab: Partial<Tab> & { id: string }) => {
      for (const l of listeners) l({ tab: { ...row, ...tab } as Tab, project_id: 'p1', machine_id: 'm1', owner_id: null });
    },
    listeners,
  };
}

const settle = async (hub: TabChatHub, tabId = 't1') => {
  // a read may have been queued behind the one in flight: wait for both
  await hub.whenIdle(tabId);
  await hub.whenIdle(tabId);
};

describe('TabChatHub', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a subscriber without a cursor starts at the end of the file and gets nothing old', async () => {
    const t = setup();
    t.file.append(SID, 'old');
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    expect(t.file.read).toHaveBeenCalledTimes(1);
    expect(t.file.read.mock.calls[0]![2]).toEqual({ session: SID, offset: Number.MAX_SAFE_INTEGER });
    expect(a.frames).toEqual([]);
  });

  it('a poke reads once and sends the new items; an empty read sends nothing', async () => {
    const t = setup();
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    t.file.append(SID, 'novo');
    t.hub.poke('t1');
    await settle(t.hub);
    expect(a.frames).toEqual([{ type: 'items', items: [expect.objectContaining({ id: '11-10', text: 'novo' })], live: `${SID}.10`, mode: null }]);
    t.hub.poke('t1');
    await settle(t.hub);
    expect(a.frames).toHaveLength(1);
  });

  it('more: true reads again at once, until the end', async () => {
    const t = setup();
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    let n = 0;
    t.file.read.mockImplementation(async () => {
      n++;
      return { items: [{ kind: 'assistant', id: `x${n}`, at: '', text: '' }], live: `${SID}.${n * 10}`, mode: null, missing: false, more: n < 3, known: 1, unknown: 0 };
    });
    t.hub.poke('t1');
    await settle(t.hub);
    expect(n).toBe(3);
    expect(t.ids(a.frames)).toEqual(['x1', 'x2', 'x3']);
  });

  it('pokes during a read in flight cause exactly one more read after it', async () => {
    const t = setup();
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    const base = t.file.read.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.file.read.mockImplementationOnce(async (...args) => {
      await gate;
      return base(...args);
    });
    t.file.read.mockClear();
    t.hub.poke('t1');
    await vi.advanceTimersByTimeAsync(0);
    t.hub.poke('t1');
    t.hub.poke('t1');
    release();
    await settle(t.hub);
    expect(t.file.read).toHaveBeenCalledTimes(2);
  });

  it('reads every second while the tab works, and not while it waits', async () => {
    const t = setup({ state: 'working' });
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    t.file.read.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.file.read).toHaveBeenCalledTimes(3);
    t.setTab({ state: 'waiting_input' });
    await vi.advanceTimersByTimeAsync(1000);
    t.file.read.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.file.read).not.toHaveBeenCalled();
  });

  it('a state change to working starts the ticking', async () => {
    const t = setup();
    t.hub.subscribe('t1', null, t.subscriber().sub);
    await settle(t.hub);
    t.file.read.mockClear();
    t.setTab({ state: 'working' });
    t.emit({ id: 't1', state: 'working' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.file.read).toHaveBeenCalledTimes(2);
  });

  it('a late subscriber behind the others is caught up from its own cursor, with no item twice', async () => {
    const t = setup();
    t.file.append(SID, 'one'); // 10
    t.file.append(SID, 'two'); // 20
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    const b = t.subscriber();
    t.hub.subscribe('t1', `${SID}.10`, b.sub);
    await settle(t.hub);
    expect(t.ids(b.frames)).toEqual(['11-20']);
    expect(a.frames).toEqual([]);
    t.file.append(SID, 'three'); // 30
    t.hub.poke('t1');
    await settle(t.hub);
    expect(t.ids(a.frames)).toEqual(['11-30']);
    expect(t.ids(b.frames)).toEqual(['11-20', '11-30']);
  });

  it('a new session id resets every subscriber and follows the end of the new file', async () => {
    const t = setup();
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    t.file.append(NEW_SID, 'before the switch');
    t.setTab({ agent_session_id: NEW_SID, agent_transcript_path: `/h/.claude/projects/-w/${NEW_SID}.jsonl` });
    t.hub.poke('t1');
    await settle(t.hub);
    expect(a.frames).toEqual([{ type: 'reset', session_id: NEW_SID }]);
    t.file.append(NEW_SID, 'after');
    t.hub.poke('t1');
    await settle(t.hub);
    expect(t.ids(a.frames)).toEqual(['99-20']);
  });

  it('a subscriber whose cursor is of another session is reset on its own', async () => {
    const t = setup();
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    const b = t.subscriber();
    t.hub.subscribe('t1', `${NEW_SID}.10`, b.sub);
    await settle(t.hub);
    expect(b.frames).toEqual([{ type: 'reset', session_id: SID }]);
    expect(a.frames).toEqual([]);
  });

  it('a failed read says why; three in a row stop the ticking until a poke', async () => {
    const t = setup({ state: 'working' });
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    t.file.read.mockClear();
    t.file.read.mockRejectedValue(new HttpError(504, 'A máquina não respondeu', 'AGENT_TIMEOUT'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.file.read).toHaveBeenCalledTimes(3);
    expect(a.frames).toEqual([{ type: 'unavailable', availability: 'offline' }]);
    expect(t.log.warn).toHaveBeenCalled();
    t.file.read.mockReset();
    t.file.read.mockResolvedValue({ items: [], live: `${SID}.0`, mode: null, missing: false, more: false, known: 0, unknown: 0 });
    t.hub.poke('t1');
    await settle(t.hub);
    expect(t.file.read).toHaveBeenCalledTimes(1);
    // back: the tab's summary says it is ready again, and the ticking resumes
    expect(a.frames.at(-1)).toMatchObject({ type: 'state', tab: { id: 't1', availability: 'ready' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.file.read).toHaveBeenCalledTimes(2);
  });

  it('an agent that went offline sends unavailable without a read, and its return reads again', async () => {
    const t = setup();
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    t.file.read.mockClear();
    t.agent.online = false;
    t.hub.poke('t1');
    await settle(t.hub);
    expect(a.frames).toEqual([{ type: 'unavailable', availability: 'offline' }]);
    expect(t.file.read).not.toHaveBeenCalled();
    t.agent.online = true;
    t.file.append(SID, 'meanwhile');
    t.agentEvents.emit('online', 'm1');
    await settle(t.hub);
    expect(t.ids(a.frames)).toEqual(['11-10']);
  });

  it("forwards the tab's own state changes, not another tab's", async () => {
    const t = setup();
    const a = t.subscriber();
    t.hub.subscribe('t1', null, a.sub);
    await settle(t.hub);
    t.emit({ id: 't2', state: 'working' });
    t.emit({ id: 't1', state: 'waiting_permission', state_at: '2026-10-01T10:00:00.000Z' });
    await settle(t.hub);
    expect(a.frames).toEqual([{ type: 'state', tab: expect.objectContaining({ id: 't1', state: 'waiting_permission', needs_you: true, availability: 'ready' }) }]);
  });

  it('the last release drops the follower: no timer, no listener, a later poke does nothing', async () => {
    const t = setup({ state: 'working' });
    const r1 = t.hub.subscribe('t1', null, t.subscriber().sub);
    const r2 = t.hub.subscribe('t1', null, t.subscriber().sub);
    await settle(t.hub);
    r1();
    r1();
    expect(vi.getTimerCount()).toBe(1);
    r2();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.listeners.size).toBe(0);
    expect(t.agentEvents.listenerCount('online')).toBe(1); // the hub's own, shared by every follower
    t.repos.tabs.findById.mockClear();
    t.hub.poke('t1');
    expect(t.repos.tabs.findById).not.toHaveBeenCalled();
  });

  it('a poke of a tab nobody watches does not touch the database', () => {
    const t = setup();
    t.hub.poke('t1');
    expect(t.repos.tabs.findById).not.toHaveBeenCalled();
  });

  it('close drops every follower and stops listening to the agents', async () => {
    const t = setup({ state: 'working' });
    t.hub.subscribe('t1', null, t.subscriber().sub);
    await settle(t.hub);
    t.hub.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.agentEvents.listenerCount('online')).toBe(0);
  });

  it('never logs an item', async () => {
    const t = setup();
    t.hub.subscribe('t1', null, t.subscriber().sub);
    await settle(t.hub);
    t.file.append(SID, 'segredo');
    t.hub.poke('t1');
    await settle(t.hub);
    const logged = JSON.stringify([(t.log.debug as ReturnType<typeof vi.fn>).mock.calls, (t.log.info as ReturnType<typeof vi.fn>).mock.calls, (t.log.warn as ReturnType<typeof vi.fn>).mock.calls]);
    expect(logged).not.toContain('segredo');
  });
});
