// A session store driven over the real `HttpMobileApi` and the in-memory `MockTransport`, and the
// enrolment that leaves it `unlocked` — shared by the session store's own tests and by every
// feature store (chat, notifications) that needs a live, unlocked session over the same mock.
import { createSessionStore } from '@/features/session/viewmodel/createSessionStore';
import { createHttpMobileApi } from '@/services/api/client';
import { createMockTransport } from '@/services/api/mock';
import { SoftwareDeviceKey } from '@/services/key/software';
import { vault } from '@/services/vault';

export const START = Date.parse('2026-09-24T12:00:00Z');
export const PIN = '123456';

export type SessionStore = ReturnType<typeof createSessionStore>;

/** `mode` is the api's own mode: `mock` (the default here, like the app's default build) sends
 * the fake Expo push token; `http` never does. */
export function setupSession(start = START, mode: 'mock' | 'http' = 'mock') {
  const clock = { value: start };
  const now = () => clock.value;
  const transport = createMockTransport({ latency: [0, 0], now });
  const key = new SoftwareDeviceKey();
  let store: SessionStore | null = null;
  const api = createHttpMobileApi({
    transport,
    baseUrl: 'https://termhub.dev',
    app: 'ios/0.1.0+1',
    key,
    onTokenExpired: () => store!.getState().renewToken(),
    now,
    mode,
    tokenStale: () => store!.getState().tokenStale(),
  });
  const localAuth = { available: jest.fn(async () => true), authenticate: jest.fn(async () => true) };
  const make = () => createSessionStore({ api, key, vault, now, mockControls: transport.controls, localAuth });
  store = make();
  return { clock, transport, controls: transport.controls, api, key, localAuth, store, make };
}

export type SessionContext = ReturnType<typeof setupSession>;

/** requestDevice → approve → one poll → createPin: leaves the store `unlocked`, and returns the
 * `pin_secret` the mock handed out (captured from `activate`) so a test can check where it went.
 * The poll runs on a timer: call it with Jest fake timers installed. */
export async function enrol(ctx: SessionContext, pin = PIN): Promise<string> {
  let pinSecret = '';
  const activate = ctx.api.activate.bind(ctx.api);
  const spy = jest.spyOn(ctx.api, 'activate').mockImplementation(async (body) => {
    const res = await activate(body);
    pinSecret = res.pin_secret;
    return res;
  });
  await ctx.store.getState().requestDevice('pedro@x.com');
  const [id] = ctx.controls.pendingRequestIds();
  ctx.controls.approve(id!);
  await jest.advanceTimersByTimeAsync(2000);
  expect(ctx.store.getState().phase).toBe('pin_setup');
  await ctx.store.getState().createPin(pin, pin);
  expect(ctx.store.getState().phase).toBe('unlocked');
  spy.mockRestore();
  return pinSecret;
}
