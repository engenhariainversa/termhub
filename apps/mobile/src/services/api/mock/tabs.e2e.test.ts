// The mock's sessions (spec 2026-10-01 tab chat) through the real client: what the store and the
// screens run against in every test and in mock mode.
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { PAGE_ITEMS } from './handlers/tabs';

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  return { ...ctx, auth: () => ctx.store.getState().auth() };
}

it('lists the tabs and pages back through a conversation', async () => {
  const { api, auth } = await setup();
  const { tabs } = await api.tabs(auth());
  expect(tabs.map((t) => t.id)).toEqual(['t-api', 't-web', 't-deploy']);
  const first = await api.tabChat(auth(), 't-api');
  expect(first.items).toHaveLength(PAGE_ITEMS);
  expect(first.before).not.toBeNull();
  const earlier = await api.tabChat(auth(), 't-api', first.before!);
  expect(earlier.items.length).toBeGreaterThan(0);
  expect(earlier.items.some((i) => first.items.some((j) => j.id === i.id))).toBe(false);
  await expect(api.tabChat(auth(), 't-nope')).rejects.toMatchObject({ status: 404 });
});

it('a tab waiting on a permission refuses a message with 409 WAITING_PERMISSION', async () => {
  const { api, auth } = await setup();
  await expect(api.sendTabMessage(auth(), 't-deploy', 'oi')).rejects.toMatchObject({ status: 409, code: 'WAITING_PERMISSION' });
});

it('the socket says hello, catches up from its cursor and relays a sent message', async () => {
  const { api, auth } = await setup();
  const page = await api.tabChat(auth(), 't-api');
  const frames: string[] = [];
  const close = api.tabEvents(auth, 't-api', { after: () => page.live, onFrame: (f) => frames.push(f.type), onClose: jest.fn() });
  await jest.advanceTimersByTimeAsync(0);
  expect(frames).toEqual(['hello']);
  await api.sendTabMessage(auth(), 't-api', 'mais um');
  expect(frames).toEqual(['hello', 'items']);
  close();
});

it('a socket for a tab that is not there closes with 4404', async () => {
  const { api, auth } = await setup();
  const onClose = jest.fn();
  const close = api.tabEvents(auth, 't-nope', { after: () => null, onFrame: jest.fn(), onClose });
  await jest.advanceTimersByTimeAsync(0);
  expect(onClose).toHaveBeenCalledWith(4404, true);
  close();
});
