// The settings store (design spec §7): only `device` — biometrics, the host and the theme each
// live in their own store (session, chat, theme). Driven over the real `HttpMobileApi` +
// `MockTransport` with an enrolled session, same as the other feature stores' tests.
import { sessionEnded } from '@/features/shared/signals';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { ApiError } from '@/services/api/errors';
import { createSettingsStore } from './createSettingsStore';

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  const store = createSettingsStore({ api: ctx.api, session: () => ctx.store.getState() });
  return { ...ctx, store };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('carries the api mode, for the Versão section', async () => {
  const { store, api } = await setup();
  expect(store.getState().mode).toBe(api.mode);
  expect(store.getState().server).toBe('Servidor: mock');

  // http mode names the configured server's host (TERMHUB_URL by default, injected here)
  const http = setupSession(undefined, 'http');
  const httpStore = createSettingsStore({ api: http.api, session: () => http.store.getState(), baseUrl: 'https://staging.termhub.dev' });
  expect(httpStore.getState()).toMatchObject({ mode: 'http', server: 'Servidor: staging.termhub.dev' });
  expect(createSettingsStore({ api: http.api, session: () => http.store.getState() }).getState().server).toBe('Servidor: termhub.dev');
});

it('loadDevice() fills the device from the API', async () => {
  const { store } = await setup();
  expect(store.getState().device).toBeNull();

  await store.getState().loadDevice();

  expect(store.getState().device).toMatchObject({ platform: 'ios', model: expect.any(String) });
  expect(store.getState().loadingDevice).toBe(false);
});

it('resets on sessionEnded', async () => {
  const { store } = await setup();
  await store.getState().loadDevice();
  expect(store.getState().device).not.toBeNull();

  sessionEnded.emit();

  expect(store.getState().device).toBeNull();
});

describe('sendTestPush (TER-913)', () => {
  it('asks for a confirmation test push in 10 s and says so', async () => {
    const { store, api } = await setup();
    const spy = jest.spyOn(api, 'pushTest').mockResolvedValue({ scheduled_for: '2026-10-05T00:00:10.000Z', ticket: null });
    await store.getState().sendTestPush();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ accessToken: expect.any(String) }), { kind: 'confirmation', delay_seconds: 10 });
    expect(store.getState().pushTest).toEqual({ sending: false, note: 'Enviada. Ela chega em 10 s.', error: null });
  });

  it('shows the server\'s message on a refusal', async () => {
    const { store, api } = await setup();
    jest.spyOn(api, 'pushTest').mockRejectedValue(new ApiError(429, 'PUSH_TEST_RATE_LIMITED', 'Muitas notificações de teste. Espere um minuto e tente de novo.'));
    await store.getState().sendTestPush();
    expect(store.getState().pushTest).toEqual({ sending: false, note: null, error: 'Muitas notificações de teste. Espere um minuto e tente de novo.' });
  });

  it('round-trips through the mock server (the session start registered a mock token)', async () => {
    const { store } = await setup();
    await store.getState().sendTestPush();
    expect(store.getState().pushTest).toEqual({ sending: false, note: 'Enviada. Ela chega em 10 s.', error: null });
  });
});

describe('"aba terminou" setting (TER-925)', () => {
  it('loads off, turns on through the mock server, and resets on sessionEnded', async () => {
    const { store } = await setup();
    expect(store.getState().tabFinished).toBeNull();
    await store.getState().loadPushSettings();
    expect(store.getState().tabFinished).toBe(false);
    await store.getState().setTabFinished(true);
    expect(store.getState().tabFinished).toBe(true);
    await store.getState().loadPushSettings();
    expect(store.getState().tabFinished).toBe(true);
    sessionEnded.emit();
    expect(store.getState().tabFinished).toBeNull();
  });

  it('a failed change goes back and says why', async () => {
    const { store, api } = await setup();
    await store.getState().loadPushSettings();
    jest.spyOn(api, 'setPushSettings').mockRejectedValue(new ApiError(500, 'INTERNAL', 'Erro interno'));
    await store.getState().setTabFinished(true);
    expect(store.getState().tabFinished).toBe(false);
    expect(store.getState().pushSettingsError).toBe('Erro interno');
  });
});
