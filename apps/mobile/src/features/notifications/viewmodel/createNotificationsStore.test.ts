// The notifications store (design spec §7): history + unread, and the live `confirmation` tap
// into the chat store's socket (ruling). Driven over the real `HttpMobileApi` + `MockTransport`
// with an enrolled session, same as the chat store's own tests; the events tap is a small fake so
// a test can fire one event without the timing of a real socket connection.
import type { TChatEvent } from '@/services/api/contract';
import { mmkv } from '@/services/storage';
import { appForegrounded, sessionEnded } from '@/features/shared/signals';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { localRowId } from '../model/synthetic-row';
import { createNotificationsStore } from './createNotificationsStore';

type Confirmation = Extract<TChatEvent, { type: 'confirmation' }>;

function confirmation(actionId: string, projectId: string | null, conversationId = 'c-termhub'): Confirmation {
  return {
    type: 'confirmation',
    user_id: 'u1',
    conversation_id: conversationId,
    action_id: actionId,
    tool: 'send_input',
    args: {},
    class: 'write',
    machine_id: projectId ? 'm-jarvis' : null,
    project_id: projectId,
    tab_id: projectId ? 't-api' : null,
    summary: 'digitar comando',
    created_at: new Date().toISOString(),
  };
}

function fakeEvents() {
  const listeners = new Set<(e: TChatEvent) => void>();
  return {
    subscribe: (fn: (e: TChatEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (e: TChatEvent) => listeners.forEach((fn) => fn(e)),
  };
}

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  const events = fakeEvents();
  const store = createNotificationsStore({ api: ctx.api, session: () => ctx.store.getState(), events });
  return { ...ctx, events, store };
}

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('load() lists newest first and sets unread from the server', async () => {
  const { store } = await setup();
  await store.getState().load();
  expect(store.getState().items).toHaveLength(1);
  expect(store.getState().items[0]).toMatchObject({ kind: 'confirmation', data: { action_id: 'a-termhub-1' } });
  expect(store.getState().unread).toBe(1);
});

it('a confirmation event prepends an unread synthetic row, deduped by action_id', async () => {
  const { store, events } = await setup();
  await store.getState().load();
  expect(store.getState().unread).toBe(1);

  events.emit(confirmation('a-new', 'p-termhub'));
  expect(store.getState().items[0]).toMatchObject({ id: localRowId('a-new'), kind: 'confirmation', read_at: null });
  expect(store.getState().unread).toBe(2);

  // The same action fires again (e.g. a reconnect replaying it): no duplicate, no extra unread.
  events.emit(confirmation('a-new', 'p-termhub'));
  expect(store.getState().items.filter((r) => r.data.action_id === 'a-new')).toHaveLength(1);
  expect(store.getState().unread).toBe(2);
});

it("load() replaces a synthetic row with the server's once it is there", async () => {
  const { store, events, api } = await setup();
  await store.getState().load();
  events.emit(confirmation('a-new', 'p-termhub'));
  expect(store.getState().items.some((r) => r.id === localRowId('a-new'))).toBe(true);

  // The mock recorded the same confirmation as a real row (handlers/chat.ts would have, in the
  // full flow); simulate that by pushing one with the matching action_id directly into state via
  // a second `load()` after the API is made to return it.
  const real = { ...store.getState().items[0]!, id: 'srv-1', data: { ...store.getState().items[0]!.data, action_id: 'a-new' } };
  jest.spyOn(api, 'notifications').mockResolvedValueOnce({ notifications: [real], unread: 1, next_before: null });

  await store.getState().load();
  expect(store.getState().items.map((r) => r.id)).toEqual(['srv-1']);
});

it('markRead marks the row read, calls the API and decrements unread, never below 0', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const markRead = jest.spyOn(api, 'markRead');
  const id = store.getState().items[0]!.id;

  await store.getState().markRead(id);
  expect(markRead).toHaveBeenCalledWith(expect.anything(), id);
  expect(store.getState().items[0]!.read_at).not.toBeNull();
  expect(store.getState().unread).toBe(0);

  // Already read: marking it again must not push unread negative.
  await store.getState().markRead(id);
  expect(store.getState().unread).toBe(0);
});

it('markPushRead reads a row the list does not hold yet on the server, then reloads page 1', async () => {
  const { store, api } = await setup();
  const markRead = jest.spyOn(api, 'markRead').mockResolvedValue(undefined);
  const notifications = jest.spyOn(api, 'notifications');
  expect(store.getState().items).toHaveLength(0);

  await store.getState().markPushRead('n-from-push');
  expect(markRead).toHaveBeenCalledWith(expect.anything(), 'n-from-push');
  expect(notifications).toHaveBeenCalledTimes(1);
  expect(store.getState().items).toHaveLength(1);
});

it('markPushRead on a row already listed is a plain markRead, with no reload', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const id = store.getState().items[0]!.id;
  const notifications = jest.spyOn(api, 'notifications');

  await store.getState().markPushRead(id);
  expect(store.getState().items[0]!.read_at).not.toBeNull();
  expect(store.getState().unread).toBe(0);
  expect(notifications).not.toHaveBeenCalled();
});

it('markRead on a synthetic local: row only marks it read here, with no API call', async () => {
  const { store, events, api } = await setup();
  await store.getState().load();
  events.emit(confirmation('a-new', 'p-termhub'));
  expect(store.getState().unread).toBe(2);
  const markRead = jest.spyOn(api, 'markRead');

  await store.getState().markRead(localRowId('a-new'));
  expect(markRead).not.toHaveBeenCalled();
  expect(store.getState().items.find((r) => r.id === localRowId('a-new'))!.read_at).not.toBeNull();
  expect(store.getState()).toMatchObject({ unread: 1, error: null });
});

it('loadMore fetches the next page with next_before and appends it', async () => {
  const { store, api } = await setup();
  const first = { id: 'n1', kind: 'reply' as const, title: 't1', body: 'b1', data: {}, created_at: new Date().toISOString(), read_at: null };
  const second = { id: 'n2', kind: 'reply' as const, title: 't2', body: 'b2', data: {}, created_at: new Date().toISOString(), read_at: null };
  jest.spyOn(api, 'notifications').mockImplementation(async (_auth, before) => {
    if (before === undefined) return { notifications: [first], unread: 2, next_before: 'n1' };
    expect(before).toBe('n1');
    return { notifications: [second], unread: 2, next_before: null };
  });

  await store.getState().load();
  expect(store.getState().items).toEqual([first]);
  await store.getState().loadMore();
  expect(store.getState().items).toEqual([first, second]);
  expect(store.getState().nextBefore).toBeNull();

  // No more pages: a further loadMore is a no-op.
  const spy = jest.spyOn(api, 'notifications');
  const before = spy.mock.calls.length;
  await store.getState().loadMore();
  expect(spy.mock.calls.length).toBe(before);
});

it('resets on sessionEnded', async () => {
  const { store } = await setup();
  await store.getState().load();
  expect(store.getState().items.length).toBeGreaterThan(0);

  sessionEnded.emit();

  expect(store.getState()).toMatchObject({ items: [], unread: 0 });
});

describe('icon badge and notification center (TER-923)', () => {
  async function setupOs() {
    const ctx = setupSession();
    await enrol(ctx);
    const os = { setBadge: jest.fn(async () => undefined), dismissDelivered: jest.fn(async () => undefined) };
    const store = createNotificationsStore({ api: ctx.api, session: () => ctx.store.getState(), events: fakeEvents(), os, refreshOnForeground: true });
    return { ...ctx, os, store };
  }

  it('the badge follows unread, and a read row\'s delivered push is dismissed', async () => {
    const { store, os } = await setupOs();
    await store.getState().load();
    expect(os.setBadge).toHaveBeenLastCalledWith(1);
    const id = store.getState().items[0]!.id;
    expect(os.dismissDelivered).toHaveBeenLastCalledWith(new Set());
    await store.getState().markRead(id);
    expect(os.setBadge).toHaveBeenLastCalledWith(0);
    expect(os.dismissDelivered).toHaveBeenLastCalledWith(new Set([id]));
  });

  it('coming back to the app reloads the history', async () => {
    const { store, api } = await setupOs();
    const list = jest.spyOn(api, 'notifications');
    appForegrounded.emit();
    await jest.runOnlyPendingTimersAsync();
    expect(list).toHaveBeenCalled();
    expect(store.getState().unread).toBe(1);
  });

  it('the end of the session clears the center and the badge', async () => {
    const { store, os } = await setupOs();
    await store.getState().load();
    sessionEnded.emit();
    await jest.runOnlyPendingTimersAsync();
    expect(os.dismissDelivered).toHaveBeenCalledWith('all');
    expect(os.setBadge).toHaveBeenLastCalledWith(0);
  });
});
