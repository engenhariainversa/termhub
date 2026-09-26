// The session store (design spec §5) driven over the real `HttpMobileApi` and the in-memory
// `MockTransport`, with the SecureStore / MMKV fakes of the `logic` project underneath.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as SecureStore from 'expo-secure-store';
import { decisionProofMessage } from '@termhub/mobile-api';
import { createChatStore } from '@/features/chat/viewmodel/createChatStore';
import { sessionEnded } from '@/features/shared/signals';
import { socketWake } from '@/services/api/wake';
import { ApiError } from '@/services/api/errors';
import { b64url, fromB64url, utf8 } from '@/services/crypto/encoding';
import { decisionProof } from '@/services/crypto/pin';
import { mmkv } from '@/services/storage';
import { vault } from '@/services/vault';
import { enrol, PIN, setupSession as setup } from '../../../../test/helpers/enrolled-session';
import { RELOCK_AFTER_MS } from './createSessionStore';

// Captured before any test installs fake timers: drains every pending microtask (a `void`-started wipe).
const realSetImmediate = setImmediate;
const flush = () => new Promise<void>((resolve) => realSetImmediate(() => resolve()));
const secureItems = (SecureStore as unknown as { __items: Map<string, string> }).__items;

function mmkvValues(): string[] {
  return mmkv.getAllKeys().map((k) => mmkv.getString(k) ?? '');
}

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
  secureItems.clear();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('requests a device and waits', async () => {
  const ctx = setup();
  const poll = jest.spyOn(ctx.api, 'pollRequest');
  await ctx.store.getState().requestDevice('pedro@x.com');

  const s = ctx.store.getState();
  expect(s.phase).toBe('waiting');
  expect(s.request?.code).toHaveLength(6);
  expect(s.email).toBe('pedro@x.com');
  expect(s.deviceName).toBe('iPhone de teste');
  expect(poll).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(2000);
  expect(poll).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(2000);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(ctx.store.getState().phase).toBe('waiting');

  ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
  await jest.advanceTimersByTimeAsync(2000);
  expect(poll).toHaveBeenCalledTimes(3);
  expect(ctx.store.getState().phase).toBe('pin_setup');

  // approval stops the polling
  await jest.advanceTimersByTimeAsync(10_000);
  expect(poll).toHaveBeenCalledTimes(3);
});

it('cancelRequest stops the polling and goes back to new', async () => {
  const ctx = setup();
  const poll = jest.spyOn(ctx.api, 'pollRequest');
  await ctx.store.getState().requestDevice('pedro@x.com');
  ctx.store.getState().cancelRequest();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(poll).not.toHaveBeenCalled();
  expect(ctx.store.getState()).toMatchObject({ phase: 'new', request: null });
});

it('a denied request goes back to new with a notice', async () => {
  const ctx = setup();
  const poll = jest.spyOn(ctx.api, 'pollRequest');
  await ctx.store.getState().requestDevice('pedro@x.com');
  ctx.controls.deny(ctx.controls.pendingRequestIds()[0]!);
  await jest.advanceTimersByTimeAsync(2000);

  expect(ctx.store.getState()).toMatchObject({
    phase: 'new',
    request: null,
    notice: 'O pedido expirou ou foi recusado. Tente de novo.',
  });
  await jest.advanceTimersByTimeAsync(10_000);
  expect(poll).toHaveBeenCalledTimes(1);
});

it('createPin refuses a mismatch and a non-6-digit PIN without calling the API', async () => {
  const ctx = setup();
  await ctx.store.getState().requestDevice('pedro@x.com');
  ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
  await jest.advanceTimersByTimeAsync(2000);
  const activate = jest.spyOn(ctx.api, 'activate');

  await ctx.store.getState().createPin('123456', '654321');
  expect(ctx.store.getState().error).toBe('Os dois PINs não são iguais.');
  await ctx.store.getState().createPin('12345', '12345');
  expect(ctx.store.getState().error).toBe('O PIN tem 6 dígitos.');
  await ctx.store.getState().createPin('12a456', '12a456');
  expect(ctx.store.getState().error).toBe('O PIN tem 6 dígitos.');

  expect(activate).not.toHaveBeenCalled();
  expect(ctx.store.getState().phase).toBe('pin_setup');
});

it('activation wraps the secret: vault has pin.wrapped, pin.salt, device.id; MMKV never contains the secret or token', async () => {
  const ctx = setup();
  const secret = await enrol(ctx);
  const s = ctx.store.getState();

  expect(s.deviceId).toEqual(expect.any(String));
  expect(await vault.get('device.id')).toBe(s.deviceId);
  expect(await vault.get('pin.wrapped')).toEqual(expect.any(String));
  expect(await vault.get('pin.wrapped')).not.toBe(secret);
  expect(fromB64url((await vault.get('pin.salt'))!)).toHaveLength(16);
  expect(await vault.get('pin.biometric')).toBeNull();

  const token = s.auth().accessToken;
  expect(token).toEqual(expect.any(String));
  const values = mmkvValues();
  expect(values.length).toBeGreaterThan(0);
  for (const v of values) {
    expect(v).not.toContain(secret);
    expect(v).not.toContain(token);
  }
  for (const v of secureItems.values()) expect(v).not.toContain(token);
  expect(JSON.parse(mmkv.getString('session')!).state).toEqual({
    phase: 'locked',
    deviceId: s.deviceId,
    deviceName: 'iPhone de teste',
    email: 'pedro@x.com',
    biometricsEnabled: false,
    lastBackgroundAt: null,
  });
});

it('waiting and pin_setup do not survive a restart', async () => {
  const ctx = setup();
  await ctx.store.getState().requestDevice('pedro@x.com');
  expect(ctx.make().getState()).toMatchObject({ phase: 'new', hydrated: true, request: null });

  ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
  await jest.advanceTimersByTimeAsync(2000);
  expect(ctx.store.getState().phase).toBe('pin_setup');
  expect(ctx.make().getState().phase).toBe('new');

  await ctx.store.getState().createPin(PIN, PIN);
  expect(ctx.store.getState().phase).toBe('unlocked');
  // a cold start is `unlocked` persisting as `locked`, with no token in memory
  const restarted = ctx.make();
  expect(restarted.getState()).toMatchObject({ phase: 'locked', deviceId: ctx.store.getState().deviceId, email: 'pedro@x.com' });
  expect(() => restarted.getState().auth()).toThrow('LOCKED');
});

it('unlock with a wrong PIN says PIN incorreto with attempts left; three make it locked with lockedUntil; the right PIN after the lock unlocks', async () => {
  const ctx = setup();
  await enrol(ctx);
  const store = ctx.make(); // cold start → locked
  expect(store.getState().phase).toBe('locked');

  for (const left of [2, 1, 0]) {
    await store.getState().unlock('000000');
    expect(store.getState()).toMatchObject({ phase: 'locked', error: 'PIN incorreto.', attemptsLeft: left, busy: false });
  }
  // The third failure sets the lock on the server; the next attempt — even the right PIN — sees 423.
  await store.getState().unlock(PIN);
  expect(store.getState()).toMatchObject({
    phase: 'locked',
    error: 'Aparelho bloqueado por tentativas de PIN.',
    lockedUntil: new Date(ctx.clock.value + 900_000).toISOString(),
  });
  expect(() => store.getState().auth()).toThrow('LOCKED');

  ctx.clock.value += 15 * 60_000 + 1;
  await store.getState().unlock(PIN);
  expect(store.getState()).toMatchObject({ phase: 'unlocked', error: null, lockedUntil: null, attemptsLeft: null });
  expect(store.getState().auth().accessToken).toEqual(expect.any(String));
});

it('unlock never calls the API for a PIN that is not six digits', async () => {
  const ctx = setup();
  await enrol(ctx);
  const store = ctx.make();
  const challenge = jest.spyOn(ctx.api, 'challenge');
  await store.getState().unlock('12');
  expect(challenge).not.toHaveBeenCalled();
  expect(store.getState()).toMatchObject({ phase: 'locked', error: 'O PIN tem 6 dígitos.' });
});

it('background for 5 min then foreground relocks; 4 min does not', async () => {
  const ctx = setup();
  await enrol(ctx);
  const { store } = ctx;

  store.getState().background();
  expect(store.getState().lastBackgroundAt).toBe(ctx.clock.value);
  ctx.clock.value += 4 * 60_000;
  store.getState().foreground();
  expect(store.getState().phase).toBe('unlocked');
  expect(store.getState().auth().accessToken).toEqual(expect.any(String));

  store.getState().background();
  ctx.clock.value += 5 * 60_000;
  store.getState().foreground();
  expect(store.getState().phase).toBe('locked');
  expect(() => store.getState().auth()).toThrow('LOCKED');
  // the relock never touches the vault
  expect(await vault.get('pin.wrapped')).toEqual(expect.any(String));
  // and the in-memory secret is gone: renewal cannot happen silently
  expect(await store.getState().renewToken()).toBeNull();
});

it('renewToken is single-flighted and returns null when locked', async () => {
  const ctx = setup();
  await enrol(ctx);
  const { store } = ctx;
  const before = store.getState().auth().accessToken;
  const challenge = jest.spyOn(ctx.api, 'challenge');
  const token = jest.spyOn(ctx.api, 'token');

  const [a, b] = await Promise.all([store.getState().renewToken(), store.getState().renewToken()]);
  expect(a).toEqual(expect.any(String));
  expect(b).toBe(a);
  expect(a).not.toBe(before);
  expect(challenge).toHaveBeenCalledTimes(1);
  expect(token).toHaveBeenCalledTimes(1);
  expect(store.getState().auth().accessToken).toBe(a);
  expect(store.getState().phase).toBe('unlocked');

  // An expired token on any call is renewed silently through the client's renewer.
  ctx.clock.value += 16 * 60_000;
  const me = await ctx.api.me(store.getState().auth());
  expect(me.device.id).toBe(store.getState().deviceId);
  expect(challenge).toHaveBeenCalledTimes(2);

  // after a cold start the secret is not in memory: null and locked, no API call
  const cold = ctx.make();
  expect(await cold.getState().renewToken()).toBeNull();
  expect(cold.getState().phase).toBe('locked');
  expect(challenge).toHaveBeenCalledTimes(2);
});

it('renews the token on its own 60 s before it expires, while unlocked', async () => {
  const ctx = setup();
  await enrol(ctx);
  const token = jest.spyOn(ctx.api, 'token');
  ctx.clock.value += 839_000;
  await jest.advanceTimersByTimeAsync(839_000);
  expect(token).not.toHaveBeenCalled();
  expect(ctx.store.getState().tokenStale()).toBe(false);
  ctx.clock.value += 1_000;
  await jest.advanceTimersByTimeAsync(1_000);
  expect(token).toHaveBeenCalledTimes(1);
  expect(ctx.store.getState().tokenStale()).toBe(false);
});

it('a relock clears the renewal timer: nothing renews behind the lock screen', async () => {
  const ctx = setup();
  await enrol(ctx);
  const token = jest.spyOn(ctx.api, 'token');
  ctx.store.getState().background();
  ctx.clock.value += RELOCK_AFTER_MS;
  ctx.store.getState().foreground();
  expect(ctx.store.getState().phase).toBe('locked');
  ctx.clock.value += 900_000;
  await jest.advanceTimersByTimeAsync(900_000);
  expect(token).not.toHaveBeenCalled();
  expect(ctx.store.getState().tokenStale()).toBe(true);
});

it('tokenStale is true past expires_at - 60 s', async () => {
  const ctx = setup();
  await enrol(ctx);
  jest.spyOn(ctx.api, 'token').mockImplementation(() => new Promise(() => {})); // the renewal never lands
  ctx.clock.value += 840_000;
  expect(ctx.store.getState().tokenStale()).toBe(true);
});

it('a renewal with no secret in memory relocks with the "Sessão expirada" message', async () => {
  const ctx = setup();
  await enrol(ctx);
  // A second store over the same vault has no secret in memory; force it to unlocked.
  const cold = ctx.make();
  cold.setState({ phase: 'unlocked' });
  expect(await cold.getState().renewToken()).toBeNull();
  expect(cold.getState()).toMatchObject({ phase: 'locked', error: 'Sessão expirada. Desbloqueie para continuar.' });
});

type Proof = { challenge: string; pin_proof: string };
const noop = async () => undefined;

it('requestPinProof performs the decision with the proof while the prompt stays open and busy, then closes; cancel rejects', async () => {
  const ctx = setup();
  const secret = fromB64url(await enrol(ctx));
  const { store } = ctx;
  const challenge = jest.spyOn(ctx.api, 'challenge');
  const seen: Proof[] = [];
  const perform = jest.fn(async (proof: Proof) => {
    // the sheet is still up (and busy) while the server checks the proof
    expect(store.getState()).toMatchObject({ pinPrompt: { actionId: 'act-1' }, busy: true });
    seen.push(proof);
  });

  const pending = store.getState().requestPinProof('act-1', perform);
  expect(store.getState().pinPrompt).toEqual({ actionId: 'act-1', decision: 'approve' });
  await store.getState().resolvePinPrompt(PIN);
  await pending;
  expect(challenge).toHaveBeenCalledWith({ device_id: store.getState().deviceId, purpose: 'decision', action_id: 'act-1' });
  expect(perform).toHaveBeenCalledTimes(1);
  expect(seen[0]!.pin_proof).toBe(decisionProof(secret, seen[0]!.challenge, 'act-1', 'approve'));
  expect(store.getState()).toMatchObject({ pinPrompt: null, busy: false, error: null });

  const other = jest.fn(noop);
  const cancelled = store.getState().requestPinProof('act-2', other);
  store.getState().cancelPinPrompt();
  await expect(cancelled).rejects.toThrow('CANCELLED');
  expect(other).not.toHaveBeenCalled();
  expect(store.getState().pinPrompt).toBeNull();
});

it("requestPinProof(id, perform, 'approve_tab') asks for approve_tab and signs that word, never approve", async () => {
  const ctx = setup();
  const secret = fromB64url(await enrol(ctx));
  const { store } = ctx;
  const seen: Proof[] = [];
  const perform = jest.fn(async (proof: Proof) => {
    seen.push(proof);
  });

  const pending = store.getState().requestPinProof('a1', perform, 'approve_tab');
  expect(store.getState().pinPrompt).toEqual({ actionId: 'a1', decision: 'approve_tab' });
  await store.getState().resolvePinPrompt(PIN);
  await pending;
  expect(perform).toHaveBeenCalledTimes(1);
  expect(seen[0]!.pin_proof).toBe(b64url(hmac(sha256, secret, utf8(decisionProofMessage(seen[0]!.challenge, 'a1', 'approve_tab')))));
  expect(seen[0]!.pin_proof).not.toBe(decisionProof(secret, seen[0]!.challenge, 'a1', 'approve'));
});

it('a PIN_INVALID from perform keeps the prompt open with the error and attempts left; the next PIN goes through', async () => {
  const ctx = setup();
  await enrol(ctx);
  const { store } = ctx;
  const perform = jest.fn(noop).mockRejectedValueOnce(new ApiError(401, 'PIN_INVALID', 'x', undefined, 2));
  let settled = false;
  const pending = store.getState().requestPinProof('act-1', perform);
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );

  await store.getState().resolvePinPrompt('000000');
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(store.getState()).toMatchObject({ phase: 'unlocked', pinPrompt: { actionId: 'act-1' }, busy: false, error: 'PIN incorreto.', attemptsLeft: 2 });

  await store.getState().resolvePinPrompt(PIN);
  await pending;
  expect(perform).toHaveBeenCalledTimes(2);
  expect(store.getState()).toMatchObject({ pinPrompt: null, busy: false, error: null, attemptsLeft: null });
});

it('a 423 from perform relocks and drops the prompt', async () => {
  const ctx = setup();
  await enrol(ctx);
  const { store } = ctx;
  const pending = store.getState().requestPinProof('act-1', async () => {
    throw new ApiError(423, 'DEVICE_LOCKED', 'x', 900);
  });
  await store.getState().resolvePinPrompt(PIN);
  await expect(pending).rejects.toThrow('CANCELLED');
  expect(store.getState()).toMatchObject({
    phase: 'locked',
    pinPrompt: null,
    busy: false,
    lockedUntil: new Date(ctx.clock.value + 900_000).toISOString(),
  });
});

it('any other error from perform closes the prompt and rejects with that error, leaving the session state clean', async () => {
  const ctx = setup();
  await enrol(ctx);
  const { store } = ctx;
  const conflict = new ApiError(409, 'ACTION_DECIDED', 'x');
  const pending = store.getState().requestPinProof('act-1', async () => {
    throw conflict;
  });
  await store.getState().resolvePinPrompt(PIN);
  await expect(pending).rejects.toBe(conflict);
  expect(store.getState()).toMatchObject({ phase: 'unlocked', pinPrompt: null, busy: false, error: null });
});

it('a relock clears error and attemptsLeft, so nothing stale reaches Desbloquear', async () => {
  const ctx = setup();
  await enrol(ctx);
  const { store } = ctx;
  store.getState().handleApiError(new ApiError(401, 'PIN_INVALID', 'x', undefined, 1));
  expect(store.getState()).toMatchObject({ error: 'PIN incorreto.', attemptsLeft: 1 });
  store.getState().background();
  ctx.clock.value += 5 * 60_000;
  store.getState().foreground();
  expect(store.getState()).toMatchObject({ phase: 'locked', error: null, attemptsLeft: null });
});

it('lockExpired clears the lock, its error and the attempts; it is a no-op when not locked', async () => {
  const ctx = setup();
  await enrol(ctx);
  const { store } = ctx;
  store.getState().handleApiError(new ApiError(401, 'PIN_INVALID', 'x', undefined, 1));
  store.getState().lockExpired();
  expect(store.getState()).toMatchObject({ error: 'PIN incorreto.', attemptsLeft: 1 });

  store.getState().handleApiError(new ApiError(423, 'DEVICE_LOCKED', 'x', 900));
  expect(store.getState().lockedUntil).not.toBeNull();
  store.getState().lockExpired();
  expect(store.getState()).toMatchObject({ phase: 'locked', lockedUntil: null, error: null, attemptsLeft: null });
});

it('entering unlocked (activation, then every unlock) emits socketWake; a renewal does not', async () => {
  const wake = jest.fn();
  const unsubscribe = socketWake.subscribe(wake);
  try {
    const ctx = setup();
    await enrol(ctx);
    expect(wake).toHaveBeenCalledTimes(1);
    await ctx.store.getState().renewToken();
    expect(wake).toHaveBeenCalledTimes(1);
    const store = ctx.make();
    await store.getState().unlock(PIN);
    expect(store.getState().phase).toBe('unlocked');
    expect(wake).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
  }
});

it.each([
  ['a vault item is missing', () => vault.delete('pin.salt')],
  ['the vault belongs to another device', () => vault.set('device.id', 'd-other')],
])('unlock wipes with a reason when %s', async (_name, damage) => {
  const ctx = setup();
  await enrol(ctx);
  await damage();
  const store = ctx.make();
  await store.getState().unlock(PIN);
  expect(store.getState()).toMatchObject({ phase: 'new', deviceId: null, busy: false, notice: 'Os dados deste aparelho foram perdidos. Entre de novo.' });
  expect(secureItems.size).toBe(0);
});

it('leave revokes and wipes: vault empty, phase new; a DEVICE_REVOKED from any call wipes too', async () => {
  const ended = jest.fn();
  const unsubscribe = sessionEnded.subscribe(ended);
  try {
    const ctx = setup();
    await enrol(ctx);
    const revoke = jest.spyOn(ctx.api, 'revokeSelf');
    await ctx.store.getState().leave();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(secureItems.size).toBe(0);
    expect(ctx.store.getState()).toMatchObject({ phase: 'new', deviceId: null, email: null, notice: null });
    expect(() => ctx.store.getState().auth()).toThrow('LOCKED');
    expect(ended).toHaveBeenCalledTimes(1);

    const ctx2 = setup();
    await enrol(ctx2);
    ctx2.controls.revokeNow();
    // the token row stays (P§5.7): the call itself answers DEVICE_REVOKED, and the store that made
    // it routes the error through handleApiError, which wipes
    const err = await ctx2.api.me(ctx2.store.getState().auth()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'DEVICE_REVOKED' });
    expect(ctx2.store.getState().handleApiError(err)).toBe(true);
    await flush();
    expect(secureItems.size).toBe(0);
    expect(ctx2.store.getState()).toMatchObject({ phase: 'new', notice: 'Este aparelho foi removido da sua conta.' });
    expect(ended).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
  }
});

it('after a revocation, a feature call with the still-valid token answers DEVICE_REVOKED and the session wipes on its own', async () => {
  const ctx = setup();
  await enrol(ctx);
  // The chat store stands in for any feature store: it calls through auth() and hands every error
  // to handleApiError — the automatic path, nothing routed by hand.
  const chat = createChatStore({ api: ctx.api, session: () => ctx.store.getState() });
  const me = jest.spyOn(ctx.api, 'chatProjects');
  ctx.controls.revokeNow();

  await chat.getState().loadProjects();
  await expect(me.mock.results[0]!.value).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  await flush();
  expect(secureItems.size).toBe(0);
  expect(ctx.store.getState()).toMatchObject({ phase: 'new', notice: 'Este aparelho foi removido da sua conta.' });
});

it('after a revocation, a call past the token lifetime renews, the renewal meets DEVICE_REVOKED and the session wipes', async () => {
  const ctx = setup();
  await enrol(ctx);
  ctx.controls.revokeNow();
  ctx.clock.value += 15 * 60_000 + 1; // the access token has expired: the client renews first
  const token = jest.spyOn(ctx.api, 'token');

  await expect(ctx.api.me(ctx.store.getState().auth())).rejects.toBeInstanceOf(ApiError);
  await expect(token.mock.results[0]!.value).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  await flush();
  expect(secureItems.size).toBe(0);
  expect(ctx.store.getState()).toMatchObject({ phase: 'new', notice: 'Este aparelho foi removido da sua conta.' });
});

it('a DEVICE_REVOKED during unlock wipes', async () => {
  const ctx = setup();
  await enrol(ctx);
  ctx.controls.revokeNow();
  const store = ctx.make();
  await store.getState().unlock(PIN);
  expect(store.getState()).toMatchObject({ phase: 'new', deviceId: null, notice: 'Este aparelho foi removido da sua conta.' });
  expect(secureItems.size).toBe(0);
});

it('enableBiometrics stores the plain secret behind biometrics and unlockWithBiometrics uses it', async () => {
  const ctx = setup();
  const secret = await enrol(ctx);
  const set = jest.spyOn(vault, 'set');

  expect(await ctx.store.getState().enableBiometrics()).toBe(true);
  expect(ctx.localAuth.available).toHaveBeenCalled();
  expect(ctx.localAuth.authenticate).toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('pin.biometric', secret, { biometric: true });
  expect(ctx.store.getState().biometricsEnabled).toBe(true);

  const store = ctx.make(); // cold start keeps the flag, drops the secret
  expect(store.getState()).toMatchObject({ phase: 'locked', biometricsEnabled: true });
  const get = jest.spyOn(vault, 'get');
  await store.getState().unlockWithBiometrics();
  expect(get).toHaveBeenCalledWith('pin.biometric', true);
  expect(store.getState().phase).toBe('unlocked');

  // any failure falls back to the PIN
  await store.getState().disableBiometrics();
  expect(await vault.get('pin.biometric')).toBeNull();
  expect(store.getState().biometricsEnabled).toBe(false);
  const again = ctx.make();
  await again.getState().unlockWithBiometrics();
  expect(again.getState()).toMatchObject({ phase: 'locked', error: 'Use o PIN.' });

  // a refused OS prompt does not enable anything
  ctx.localAuth.authenticate.mockResolvedValueOnce(false);
  expect(await store.getState().enableBiometrics()).toBe(false);
  expect(store.getState().biometricsEnabled).toBe(false);
  expect(await vault.get('pin.biometric')).toBeNull();
});

it('outside mock mode, no fake Expo token is ever sent', async () => {
  const ctx = setup(undefined, 'http');
  const push = jest.spyOn(ctx.api, 'setPushToken');
  await enrol(ctx);
  await ctx.make().getState().unlock(PIN);
  expect(push).not.toHaveBeenCalled();
});

it('in mock mode, after activation and after every unlock, setPushToken is called once with a fake Expo token', async () => {
  const ctx = setup();
  const push = jest.spyOn(ctx.api, 'setPushToken');
  await enrol(ctx);
  const deviceId = ctx.store.getState().deviceId;
  await Promise.resolve();
  expect(push).toHaveBeenCalledTimes(1);
  expect(push).toHaveBeenLastCalledWith({ accessToken: expect.any(String) }, `ExponentPushToken[mock-${deviceId}]`);

  // a silent renewal is not a session start
  await ctx.store.getState().renewToken();
  expect(push).toHaveBeenCalledTimes(1);

  const store = ctx.make();
  await store.getState().unlock(PIN);
  expect(push).toHaveBeenCalledTimes(2);
  expect(push).toHaveBeenLastCalledWith({ accessToken: store.getState().auth().accessToken }, `ExponentPushToken[mock-${deviceId}]`);

  // a failing push registration never blocks the flow
  push.mockRejectedValueOnce(new Error('offline'));
  const third = ctx.make();
  await third.getState().unlock(PIN);
  expect(third.getState().phase).toBe('unlocked');
  expect(push).toHaveBeenCalledTimes(3);
});

describe('guards', () => {
  it('a relock during an in-flight renewal does not bring the token back', async () => {
    const ctx = setup();
    await enrol(ctx);
    const { store } = ctx;
    const challenge = ctx.api.challenge.bind(ctx.api);
    jest.spyOn(ctx.api, 'challenge').mockImplementation(async (body) => {
      // the app comes back after 5 min while the renewal is waiting on the server
      store.getState().background();
      ctx.clock.value += 5 * 60_000;
      store.getState().foreground();
      return challenge(body);
    });
    expect(await store.getState().renewToken()).toBeNull();
    expect(store.getState().phase).toBe('locked');
    expect(() => store.getState().auth()).toThrow('LOCKED');
  });

  it('a wipe during unlock does not unlock a wiped session', async () => {
    const ctx = setup();
    await enrol(ctx);
    const store = ctx.make();
    const token = ctx.api.token.bind(ctx.api);
    jest.spyOn(ctx.api, 'token').mockImplementation(async (body) => {
      // the server accepted the PIN, but the session was wiped before the answer landed
      const res = await token(body);
      await store.getState().wipe();
      return res;
    });
    await store.getState().unlock(PIN);
    expect(store.getState()).toMatchObject({ phase: 'new', deviceId: null, busy: false });
    expect(() => store.getState().auth()).toThrow('LOCKED');
  });

  it("a newer requestPinProof is not performed with the previous prompt's answer", async () => {
    const ctx = setup();
    const secret = fromB64url(await enrol(ctx));
    const { store } = ctx;
    const performA = jest.fn(noop);
    const performB = jest.fn(async (_proof: Proof) => undefined);
    const a = store.getState().requestPinProof('act-A', performA);
    let b: Promise<void> | null = null;
    const challenge = ctx.api.challenge.bind(ctx.api);
    jest.spyOn(ctx.api, 'challenge').mockImplementationOnce(async (body) => {
      b = store.getState().requestPinProof('act-B', performB);
      return challenge(body);
    });
    await store.getState().resolvePinPrompt(PIN);
    await expect(a).rejects.toThrow('CANCELLED');
    expect(performA).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ pinPrompt: { actionId: 'act-B' }, busy: false });

    await store.getState().resolvePinPrompt(PIN);
    await b!;
    const proof = performB.mock.calls[0]![0];
    expect(proof.pin_proof).toBe(decisionProof(secret, proof.challenge, 'act-B', 'approve'));
    expect(store.getState().pinPrompt).toBeNull();
  });

  it('a 423 during resolvePinPrompt rejects the pending promise and clears pinPrompt', async () => {
    const ctx = setup();
    await enrol(ctx);
    const { store } = ctx;
    const pending = store.getState().requestPinProof('act-1', noop);
    jest.spyOn(ctx.api, 'challenge').mockRejectedValueOnce(new ApiError(423, 'DEVICE_LOCKED', 'x', 900));
    await store.getState().resolvePinPrompt(PIN);
    await expect(pending).rejects.toThrow('CANCELLED');
    expect(store.getState()).toMatchObject({
      pinPrompt: null,
      phase: 'locked',
      busy: false,
      error: 'Aparelho bloqueado por tentativas de PIN.',
      lockedUntil: new Date(ctx.clock.value + 900_000).toISOString(),
    });
  });

  it('a double tap on unlock spends one attempt', async () => {
    const ctx = setup();
    await enrol(ctx);
    const store = ctx.make();
    const token = jest.spyOn(ctx.api, 'token');
    await Promise.all([store.getState().unlock('000000'), store.getState().unlock('000000')]);
    expect(token).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ error: 'PIN incorreto.', attemptsLeft: 2, busy: false });
  });

  it('a double tap on createPin activates once and stays enrolled', async () => {
    const ctx = setup();
    await ctx.store.getState().requestDevice('pedro@x.com');
    ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
    await jest.advanceTimersByTimeAsync(2000);
    const activate = jest.spyOn(ctx.api, 'activate');
    await Promise.all([ctx.store.getState().createPin(PIN, PIN), ctx.store.getState().createPin(PIN, PIN)]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ phase: 'unlocked', notice: null });
  });

  it('a local failure after activation revokes the new device and wipes', async () => {
    const ctx = setup();
    await ctx.store.getState().requestDevice('pedro@x.com');
    ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
    await jest.advanceTimersByTimeAsync(2000);
    const revoke = jest.spyOn(ctx.api, 'revokeSelf');
    jest.spyOn(vault, 'set').mockRejectedValueOnce(new Error('keychain'));
    await ctx.store.getState().createPin(PIN, PIN);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({
      phase: 'new',
      deviceId: null,
      busy: false,
      notice: 'Não foi possível guardar o PIN neste aparelho. Tente de novo.',
    });
    expect(secureItems.size).toBe(0);
  });

  it('handleApiError consumes DEVICE_REVOKED, DEVICE_LOCKED and PIN_INVALID, and nothing else', async () => {
    const ctx = setup();
    await enrol(ctx);
    const { store } = ctx;
    const pending = store.getState().requestPinProof('act-1', noop);

    expect(store.getState().handleApiError(new ApiError(401, 'PIN_INVALID', 'x', undefined, 1))).toBe(true);
    expect(store.getState()).toMatchObject({ phase: 'unlocked', error: 'PIN incorreto.', attemptsLeft: 1 });

    expect(store.getState().handleApiError(new ApiError(423, 'DEVICE_LOCKED', 'x', 60))).toBe(true);
    expect(store.getState()).toMatchObject({
      phase: 'locked',
      pinPrompt: null,
      error: 'Aparelho bloqueado por tentativas de PIN.',
      lockedUntil: new Date(ctx.clock.value + 60_000).toISOString(),
    });
    expect(() => store.getState().auth()).toThrow('LOCKED');
    await expect(pending).rejects.toThrow('CANCELLED');

    expect(store.getState().handleApiError(new ApiError(500, 'HTTP_500', 'x'))).toBe(false);
    expect(store.getState().handleApiError(new Error('offline'))).toBe(false);
    expect(store.getState().phase).toBe('locked');

    expect(store.getState().handleApiError(new ApiError(401, 'DEVICE_REVOKED', 'x'))).toBe(true);
    await flush();
    expect(store.getState()).toMatchObject({ phase: 'new', deviceId: null, notice: 'Este aparelho foi removido da sua conta.' });
    expect(secureItems.size).toBe(0);
  });

  it('relock and wipe make the client forget its renewed token', async () => {
    const ctx = setup();
    await enrol(ctx);
    const forget = jest.spyOn(ctx.api, 'forgetTokens');
    ctx.store.getState().background();
    ctx.clock.value += 5 * 60_000;
    ctx.store.getState().foreground();
    expect(forget).toHaveBeenCalledTimes(1);
    await ctx.store.getState().wipe();
    expect(forget).toHaveBeenCalledTimes(2);
  });
});
