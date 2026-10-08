// The feature-flags store (TER-1040), driven over the real `HttpMobileApi` + `MockTransport` with an
// enrolled session, same as the other feature stores' tests.
import { sessionEnded, sessionStarted } from '@/features/shared/signals';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createFeatureFlagsStore } from './createFeatureFlagsStore';

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  const flags = createFeatureFlagsStore({ api: ctx.api, session: () => ctx.store.getState() });
  return { ...ctx, flags };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('starts with every flag off, and keeps subscriptions off when the server has it off', async () => {
  const ctx = await setup();
  expect(ctx.flags.getState().flags).toEqual({ subscriptions: false });
  await ctx.flags.getState().refresh();
  expect(ctx.flags.getState().flags).toEqual({ subscriptions: false });
});

it('turns subscriptions on for a tester the server has it on for', async () => {
  const ctx = await setup();
  const me = ctx.api.me.bind(ctx.api);
  jest.spyOn(ctx.api, 'me').mockImplementation(async (auth) => ({ ...(await me(auth)), features: { subscriptions: true } }));
  await ctx.flags.getState().refresh();
  expect(ctx.flags.getState().flags.subscriptions).toBe(true);
});

it('reads the flags when a session starts, and forgets them when it ends', async () => {
  const ctx = await setup();
  const me = ctx.api.me.bind(ctx.api);
  const spy = jest.spyOn(ctx.api, 'me').mockImplementation(async (auth) => ({ ...(await me(auth)), features: { subscriptions: true } }));
  sessionStarted.emit();
  await jest.advanceTimersByTimeAsync(0);
  expect(spy).toHaveBeenCalled();
  expect(ctx.flags.getState().flags.subscriptions).toBe(true);
  sessionEnded.emit();
  expect(ctx.flags.getState().flags.subscriptions).toBe(false);
});

it('keeps every flag off when the server cannot be reached', async () => {
  const ctx = await setup();
  jest.spyOn(ctx.api, 'me').mockRejectedValue(new Error('offline'));
  await ctx.flags.getState().refresh();
  expect(ctx.flags.getState().flags).toEqual({ subscriptions: false });
});
