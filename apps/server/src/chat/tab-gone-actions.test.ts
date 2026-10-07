import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { monitorBus } from '../monitor/bus.js';
import { chatBus, type ChatEvent } from './bus.js';
import { assertActionTabAlive, expireOrphanTabActions, startTabGoneActionExpiry } from './tab-gone-actions.js';

const action = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  conversation_id: 'c1',
  tool: 'send_input',
  args: { tab_id: 't1', text: 'oi' },
  class: 'write',
  status: 'pending',
  tab_id: 't1',
  project_id: 'p1',
  machine_id: null,
  ...over,
});

const log = () => ({ info: vi.fn(), warn: vi.fn() });

function fakeRepos(opts: { row?: ReturnType<typeof action>; tabs?: string[] } = {}) {
  return {
    chatActions: {
      findByIdForUser: vi.fn(async () => opts.row),
      failPendingTabGone: vi.fn(async (id: string) => ({ action: { ...action({ id }), status: 'failed', error_code: 'TAB_GONE' }, user_id: 'u1' })),
      failPendingForTab: vi.fn(async (tabId: string) => [{ action: { ...action({ tab_id: tabId }), status: 'failed', error_code: 'TAB_GONE' }, user_id: 'u1' }]),
      failOrphanPending: vi.fn(async () => [{ action: { ...action({ id: 'a2' }), status: 'failed', error_code: 'TAB_GONE' }, user_id: 'u2' }]),
    },
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[]) => (opts.tabs ?? []).filter((id) => ids.includes(id)).map((id) => ({ id, project_id: 'p1' }))) },
  };
}
const asRepos = (r: ReturnType<typeof fakeRepos>) => r as unknown as Repositories;

let events: ChatEvent[];
let off: () => void;
beforeEach(() => {
  events = [];
  off = chatBus.subscribe((e) => events.push(e));
});
afterEach(() => off());

describe('startTabGoneActionExpiry (TER-986)', () => {
  it('a removed tab retires its pending cards and tells every screen; an opened one does not', async () => {
    const repos = fakeRepos();
    const stop = startTabGoneActionExpiry(asRepos(repos), log());
    monitorBus.publishLifecycle({ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    stop();
    expect(repos.chatActions.failPendingForTab).toHaveBeenCalledTimes(1);
    expect(repos.chatActions.failPendingForTab).toHaveBeenCalledWith('t1');
    expect(events[0]).toEqual({ type: 'action_status', user_id: 'u1', conversation_id: 'c1', action_id: 'a1', status: 'failed', error_code: 'TAB_GONE' });
  });

  it('a failing write is logged by code, never thrown', async () => {
    const repos = fakeRepos();
    repos.chatActions.failPendingForTab.mockRejectedValueOnce(new Error('connection terminated'));
    const l = log();
    const stop = startTabGoneActionExpiry(asRepos(repos), l);
    monitorBus.publishLifecycle({ kind: 'removed', tab_id: 't1', project_id: 'p1', machine_id: 'm1', owner_id: 'u1' });
    await vi.waitFor(() => expect(l.warn).toHaveBeenCalledTimes(1));
    stop();
    expect(events).toEqual([]);
  });
});

describe('expireOrphanTabActions (TER-986)', () => {
  it('retires the cards whose tab vanished without an event, and publishes each to its owner', async () => {
    const repos = fakeRepos();
    expect(await expireOrphanTabActions(asRepos(repos), log())).toBe(1);
    expect(events).toEqual([{ type: 'action_status', user_id: 'u2', conversation_id: 'c1', action_id: 'a2', status: 'failed', error_code: 'TAB_GONE' }]);
  });

  it('never throws', async () => {
    const repos = fakeRepos();
    repos.chatActions.failOrphanPending.mockRejectedValueOnce(new Error('down'));
    expect(await expireOrphanTabActions(asRepos(repos), log())).toBe(0);
  });
});

describe('assertActionTabAlive (TER-986)', () => {
  it('a pending card whose tab is open passes, untouched', async () => {
    const repos = fakeRepos({ row: action(), tabs: ['t1'] });
    await expect(assertActionTabAlive(asRepos(repos), 'u1', 'a1')).resolves.toBeUndefined();
    expect(repos.chatActions.failPendingTabGone).not.toHaveBeenCalled();
  });

  it('a pending card whose tab is gone is retired as TAB_GONE and answers 409', async () => {
    const repos = fakeRepos({ row: action(), tabs: [] });
    await expect(assertActionTabAlive(asRepos(repos), 'u1', 'a1')).rejects.toMatchObject({ statusCode: 409, code: 'TAB_GONE' });
    expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledWith(['t1'], 'u1');
    expect(repos.chatActions.failPendingTabGone).toHaveBeenCalledWith('a1');
    expect(events).toEqual([expect.objectContaining({ type: 'action_status', action_id: 'a1', status: 'failed', error_code: 'TAB_GONE' })]);
  });

  it.each([
    ['no tab at all (a board card)', action({ tab_id: null })],
    ['a card already decided', action({ status: 'approved' })],
    ['an unknown card', undefined],
  ])('%s is left to the decision itself', async (_l, row) => {
    const repos = fakeRepos({ row, tabs: [] });
    await expect(assertActionTabAlive(asRepos(repos), 'u1', 'a1')).resolves.toBeUndefined();
    expect(repos.chatActions.failPendingTabGone).not.toHaveBeenCalled();
  });
});
