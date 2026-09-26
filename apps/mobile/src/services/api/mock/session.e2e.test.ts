// End-to-end: `HttpMobileApi` (Task 6) over `MockTransport` (this task), exercising enrolment
// (P§4), session renewal and PIN counting (P§5) exactly as the design spec's §4.2 describes them.
import { fromB64url } from '../../crypto/encoding';
import { pinProof } from '../../crypto/pin';
import { SoftwareDeviceKey } from '../../key/software';
import type { P256Jwk } from '../../key/types';
import type { VaultKey } from '../../vault';
import { createHttpMobileApi } from '../client';
import { createMockTransport } from './transport';

const START = Date.parse('2026-09-24T12:00:00Z');
const APP = 'ios/0.1.0+1';
const APP_VERSION = '0.1.0+1';
const DEVICE = { platform: 'ios' as const, model: 'iPhone15,2', os_version: '18.1', name: 'iPhone de teste' };

/** One `MockTransport` + one `HttpMobileApi` over it, both reading the same mutable `clock`
 * (milliseconds since epoch) so the test can advance time by writing to it. */
function makeApi(clock: { value: number }) {
  const transport = createMockTransport({ latency: [0, 0], now: () => clock.value });
  const key = new SoftwareDeviceKey();
  const api = createHttpMobileApi({
    transport,
    baseUrl: 'https://termhub.dev',
    app: APP,
    key,
    onTokenExpired: async () => null,
    now: () => clock.value,
  });
  return { transport, api, key };
}

/** Requests a device, approves it through the mock's controls, and activates it — the common
 * setup every test past enrolment needs. */
async function enrolAndActivate(api: ReturnType<typeof createHttpMobileApi>, transport: ReturnType<typeof createMockTransport>, jwk: P256Jwk, email: string) {
  const req = await api.requestDevice({ email, public_key: jwk, device: DEVICE, app_version: APP_VERSION });
  transport.controls.approve(req.request_id);
  return api.activate({ request_id: req.request_id, request_secret: req.request_secret });
}

it('enrols, activates, unlocks and counts wrong PINs like the server', async () => {
  const clock = { value: START };
  const { transport, api, key } = makeApi(clock);
  const jwk = await key.create();

  const req = await api.requestDevice({ email: 'Pedro@X.com', public_key: jwk, device: DEVICE, app_version: APP_VERSION });
  expect(req.verification_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  expect(await api.pollRequest(req.request_id, req.request_secret)).toEqual({ status: 'pending' });
  transport.controls.approve(req.request_id);
  expect(await api.pollRequest(req.request_id, req.request_secret)).toEqual({ status: 'approved' });
  const act = await api.activate({ request_id: req.request_id, request_secret: req.request_secret });
  const secret = fromB64url(act.pin_secret);
  expect(secret).toHaveLength(32);
  expect((await api.me({ accessToken: act.access_token })).device.id).toBe(act.device_id);

  // three wrong proofs lock for 15 minutes; a bad signature never counts (covered separately below)
  for (let i = 0; i < 3; i++) {
    const c = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
    await expect(api.token({ device_id: act.device_id, challenge: c.challenge, pin_proof: 'wrong' })).rejects.toMatchObject({
      status: 401,
      code: 'PIN_INVALID',
      attemptsLeft: 2 - i,
    });
  }
  const c = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
  await expect(
    api.token({ device_id: act.device_id, challenge: c.challenge, pin_proof: pinProof(secret, c.challenge) }),
  ).rejects.toMatchObject({ status: 423, code: 'DEVICE_LOCKED', retryAfter: 900 });

  clock.value += 15 * 60_000 + 1;
  const c2 = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
  const tok = await api.token({ device_id: act.device_id, challenge: c2.challenge, pin_proof: pinProof(secret, c2.challenge) });
  expect(tok.expires_in).toBe(900);
});

it('a replayed jti is 401 PROOF_REPLAYED and not a token renewal', async () => {
  const clock = { value: START };
  const transport = createMockTransport({ latency: [0, 0], now: () => clock.value });
  const captured: Parameters<typeof transport.fetch>[0][] = [];
  const spyTransport = {
    fetch: async (req: Parameters<typeof transport.fetch>[0]) => {
      captured.push(req);
      return transport.fetch(req);
    },
    connect: transport.connect.bind(transport),
    upload: transport.upload.bind(transport),
  };
  const key = new SoftwareDeviceKey();
  const api = createHttpMobileApi({
    transport: spyTransport,
    baseUrl: 'https://termhub.dev',
    app: APP,
    key,
    onTokenExpired: async () => null,
    now: () => clock.value,
  });
  const jwk = await key.create();
  const act = await enrolAndActivate(api, transport, jwk, 'replay@x.com');

  await api.me({ accessToken: act.access_token });
  const lastCall = captured[captured.length - 1]!;

  // The exact same request (same DPoP proof, same jti) sent again straight through the
  // transport — bypassing the client, so this can never be mistaken for its own renewal dance.
  const replayed = await transport.fetch(lastCall);
  expect(replayed.status).toBe(401);
  expect(JSON.parse(replayed.text)).toMatchObject({ code: 'PROOF_REPLAYED' });
});

it('a proof outside the ±60 s window is PROOF_INVALID, not a PIN failure', async () => {
  const clock = { value: START };
  const { transport, api, key } = makeApi(clock);
  const jwk = await key.create();
  const act = await enrolAndActivate(api, transport, jwk, 'skew@x.com');
  const secret = fromB64url(act.pin_secret);

  // A second client instance, same device key, whose clock is 3 minutes ahead of the mock's —
  // only the client drifts, `clock` (the mock's `now`) is untouched. The challenge is requested
  // through the ordinary (synced) `api`: a call through `skewedApi` would teach it a corrective
  // skew from the response's `Date` header (design spec §4.1) and quietly cancel the drift this
  // test means to exercise, so `skewedApi` must make its very first call be the signed one.
  const skewedApi = createHttpMobileApi({
    transport,
    baseUrl: 'https://termhub.dev',
    app: APP,
    key,
    onTokenExpired: async () => null,
    now: () => clock.value + 3 * 60_000,
  });

  const c = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
  await expect(
    skewedApi.token({ device_id: act.device_id, challenge: c.challenge, pin_proof: pinProof(secret, c.challenge) }),
  ).rejects.toMatchObject({ status: 401, code: 'PROOF_INVALID' });

  // Not counted as a PIN failure: the usual three wrong (in-window) attempts still take exactly
  // three to lock, rather than starting from an already-incremented count.
  for (let i = 0; i < 3; i++) {
    const c2 = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
    await expect(api.token({ device_id: act.device_id, challenge: c2.challenge, pin_proof: 'wrong' })).rejects.toMatchObject({
      status: 401,
      code: 'PIN_INVALID',
      attemptsLeft: 2 - i,
    });
  }
});

it('deny and expiry answer closed; an unknown id answers closed too', async () => {
  const clock = { value: START };
  const { transport, api, key } = makeApi(clock);
  const jwk = await key.create();

  const denied = await api.requestDevice({ email: 'deny@x.com', public_key: jwk, device: DEVICE, app_version: APP_VERSION });
  transport.controls.deny(denied.request_id);
  expect(await api.pollRequest(denied.request_id, denied.request_secret)).toEqual({ status: 'closed' });

  const expired = await api.requestDevice({ email: 'expire@x.com', public_key: jwk, device: DEVICE, app_version: APP_VERSION });
  transport.controls.expireNow();
  expect(await api.pollRequest(expired.request_id, expired.request_secret)).toEqual({ status: 'closed' });

  expect(await api.pollRequest('never-existed', 'whatever-secret')).toEqual({ status: 'closed' });
});

it('six failures revoke: every call is DEVICE_REVOKED and the socket closes 4401', async () => {
  // Socket closing is Task 9's; here only the API calls after revocation are asserted.
  const clock = { value: START };
  const { transport, api, key } = makeApi(clock);
  const jwk = await key.create();
  const act = await enrolAndActivate(api, transport, jwk, 'revoke@x.com');
  const secret = fromB64url(act.pin_secret);

  for (let i = 0; i < 3; i++) {
    const c = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
    await expect(api.token({ device_id: act.device_id, challenge: c.challenge, pin_proof: 'wrong' })).rejects.toMatchObject({
      status: 401,
      code: 'PIN_INVALID',
    });
  }
  clock.value += 15 * 60_000 + 1; // the lock from failure 3 must clear before failures 4-6 can happen
  for (let i = 0; i < 3; i++) {
    const c = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
    await expect(api.token({ device_id: act.device_id, challenge: c.challenge, pin_proof: 'wrong' })).rejects.toMatchObject({
      status: 401,
      code: 'PIN_INVALID',
    });
  }

  // Revoked now: every call answers DEVICE_REVOKED, correct PIN or not.
  const c1 = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
  await expect(
    api.token({ device_id: act.device_id, challenge: c1.challenge, pin_proof: pinProof(secret, c1.challenge) }),
  ).rejects.toMatchObject({ status: 401, code: 'DEVICE_REVOKED' });
  const c2 = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
  await expect(api.token({ device_id: act.device_id, challenge: c2.challenge, pin_proof: 'wrong' })).rejects.toMatchObject({
    status: 401,
    code: 'DEVICE_REVOKED',
  });
});

it('a wrong request_secret on activate is 401 and an activation after activate_until is 401', async () => {
  const clock = { value: START };
  const { transport, api, key } = makeApi(clock);
  const jwk = await key.create();

  const req = await api.requestDevice({ email: 'act1@x.com', public_key: jwk, device: DEVICE, app_version: APP_VERSION });
  transport.controls.approve(req.request_id);
  await expect(api.activate({ request_id: req.request_id, request_secret: 'not-the-secret' })).rejects.toMatchObject({
    status: 401,
    code: 'REQUEST_INVALID',
  });

  const req2 = await api.requestDevice({ email: 'act2@x.com', public_key: jwk, device: DEVICE, app_version: APP_VERSION });
  transport.controls.approve(req2.request_id);
  clock.value += 10 * 60_000 + 1; // past activate_until
  await expect(api.activate({ request_id: req2.request_id, request_secret: req2.request_secret })).rejects.toMatchObject({
    status: 401,
    code: 'REQUEST_INVALID',
  });
});

it('revokeSelf goes through revokeDevice: the old token is rejected and a fresh session answers DEVICE_REVOKED', async () => {
  const clock = { value: START };
  const { transport, api, key } = makeApi(clock);
  const jwk = await key.create();
  const act = await enrolAndActivate(api, transport, jwk, 'self-revoke@x.com');
  const secret = fromB64url(act.pin_secret);

  await api.revokeSelf({ accessToken: act.access_token });

  // Tokens are deleted (not just flagged), so the old one no longer resolves at all — still a
  // straightforward 401 either way.
  await expect(api.me({ accessToken: act.access_token })).rejects.toMatchObject({ status: 401 });

  // A fresh challenge + a correctly-signed proof needs no old token, and still answers
  // DEVICE_REVOKED — proving the device itself, not just its tokens, was revoked.
  const c = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
  await expect(
    api.token({ device_id: act.device_id, challenge: c.challenge, pin_proof: pinProof(secret, c.challenge) }),
  ).rejects.toMatchObject({ status: 401, code: 'DEVICE_REVOKED' });
});

it('controls.revokeNow revokes through the same path as revokeSelf: the old token is rejected and a fresh session answers DEVICE_REVOKED', async () => {
  const clock = { value: START };
  const { transport, api, key } = makeApi(clock);
  const jwk = await key.create();
  const act = await enrolAndActivate(api, transport, jwk, 'revoke-now@x.com');
  const secret = fromB64url(act.pin_secret);

  transport.controls.revokeNow();

  await expect(api.me({ accessToken: act.access_token })).rejects.toMatchObject({ status: 401 });
  const c = await api.challenge({ device_id: act.device_id, purpose: 'refresh' });
  await expect(
    api.token({ device_id: act.device_id, challenge: c.challenge, pin_proof: pinProof(secret, c.challenge) }),
  ).rejects.toMatchObject({ status: 401, code: 'DEVICE_REVOKED' });
});

it('completes activation for a client whose baseUrl is not https://termhub.dev (e.g. http://localhost:3000)', async () => {
  const clock = { value: START };
  const transport = createMockTransport({ latency: [0, 0], now: () => clock.value });
  const key = new SoftwareDeviceKey('pin.salt' as VaultKey);
  const api = createHttpMobileApi({
    transport,
    baseUrl: 'http://localhost:3000',
    app: APP,
    key,
    onTokenExpired: async () => null,
    now: () => clock.value,
  });
  const jwk = await key.create();

  const act = await enrolAndActivate(api, transport, jwk, 'localhost@x.com');
  expect(act.expires_in).toBe(900);
  expect((await api.me({ accessToken: act.access_token })).device.id).toBe(act.device_id);
});

it('the response to requestDevice has the same shape for any e-mail', async () => {
  const clock = { value: START };
  const { api, key } = makeApi(clock);
  const jwk = await key.create();

  const known = await api.requestDevice({ email: 'known@x.com', public_key: jwk, device: DEVICE, app_version: APP_VERSION });
  const unknown = await api.requestDevice({ email: 'never-seen-before@x.com', public_key: jwk, device: DEVICE, app_version: APP_VERSION });

  expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
  expect(known.poll_after).toBe(unknown.poll_after);
  expect(await api.pollRequest(known.request_id, known.request_secret)).toEqual({ status: 'pending' });
  expect(await api.pollRequest(unknown.request_id, unknown.request_secret)).toEqual({ status: 'pending' });
});
