import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import { applyErrorHandler, HttpError } from '../lib/errors.js';
import type { RevokeInput } from '../mobile/revocation.js';
import { mobileDeviceRoutes, mobilePushTokenRoutes } from './m-devices.js';

const device: Device = {
  id: 'd1',
  user_id: 'u1',
  name: 'iPhone de Ana',
  platform: 'ios',
  model: 'iPhone 15',
  os_version: '18.0',
  app_version: '1.0.0+1',
  public_key: '{}',
  key_thumbprint: 'thumb',
  pin_failures: 0,
  pin_locked_until: null,
  status: 'active',
  revoked_at: null,
  revoked_reason: null,
  push_token: null,
  last_seen_at: '2026-09-20T00:00:00.000Z',
  last_ip: null,
  request_id: null,
  created_at: '2026-09-19T00:00:00.000Z',
};
const user = { id: 'u1', email: 'ana@example.com' };
const deviceMobile = { device, user } as never;

const validRequestBody = {
  email: 'ana@example.com',
  public_key: { kty: 'EC', crv: 'P-256', x: 'x-coord', y: 'y-coord' },
  device: { platform: 'ios', model: 'iPhone 15', os_version: '18.0', name: 'Meu iPhone' },
  app_version: '1.0.0+1',
};

function buildApp(opts: { mobile?: unknown } = {}) {
  const enrolment = {
    request: vi.fn(async () => ({ request_id: 'r1', request_secret: 'thb_req_' + 'a'.repeat(43), verification_code: 'K7F2QD', expires_at: '2026-09-24T00:10:00.000Z', poll_after: 2000 })),
    poll: vi.fn(async () => ({ status: 'pending' as const })),
    activate: vi.fn(async () => ({ device, pin_secret: 'pin-secret-plain', access_token: 'thb_mob_' + 'b'.repeat(43), expires_in: 900 })),
  };
  const revoke = vi.fn(async (_id: string, _input: RevokeInput) => device);
  const devices = {
    setPushToken: vi.fn(async () => undefined),
    findByPushToken: vi.fn(async () => undefined as Device | undefined),
  };
  const deviceEvents = { record: vi.fn(async () => undefined) };
  const repos = { devices, deviceEvents } as unknown as Repositories;
  const push = { testPush: vi.fn(async () => ({ scheduled_for: '2026-10-05T00:00:10.000Z', ticket: null })) };

  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    if (opts.mobile !== undefined) request.mobile = opts.mobile as never;
  });
  app.register((a) => mobileDeviceRoutes(a, repos, { enrolment: enrolment as never, revoke }), { prefix: '/devices' });
  app.register((a) => mobilePushTokenRoutes(a, repos, push), { prefix: '' });

  return { app, enrolment, revoke, devices, deviceEvents, push };
}

describe('POST /devices/requests', () => {
  it('rejects an invalid body with 400 VALIDATION and never calls the service', async () => {
    const { app, enrolment } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/devices/requests', payload: { email: 'not-an-email' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('VALIDATION');
    expect(enrolment.request).not.toHaveBeenCalled();
  });

  it('answers 202 with the service result, passing clientLocation', async () => {
    const { app, enrolment } = buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/devices/requests',
      payload: validRequestBody,
      headers: { 'cf-ipcountry': 'BR', 'cf-ipcity': 'Sao Paulo' },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ request_id: 'r1', verification_code: 'K7F2QD' });
    expect(enrolment.request).toHaveBeenCalledTimes(1);
    const [body, ctx] = enrolment.request.mock.calls[0];
    expect(body.email).toBe('ana@example.com');
    expect(ctx.country).toBe('BR');
    expect(ctx.city).toBe('Sao Paulo');
    expect(typeof ctx.ip).toBe('string');
  });

  it('a 429 from the service passes through with retry-after: 600', async () => {
    const { app, enrolment } = buildApp();
    enrolment.request.mockRejectedValueOnce(new HttpError(429, 'Muitos pedidos', 'RATE_LIMITED'));
    const r = await app.inject({ method: 'POST', url: '/devices/requests', payload: validRequestBody });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('600');
  });
});

describe('GET /devices/requests/:id', () => {
  it('answers 401 without a bearer', async () => {
    const { app, enrolment } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/devices/requests/r1' });
    expect(r.statusCode).toBe(401);
    expect(enrolment.poll).not.toHaveBeenCalled();
  });

  it('answers { status: "closed" } without ever calling poll when the bearer does not match REQUEST_SECRET_RE', async () => {
    const { app, enrolment } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/devices/requests/r1', headers: { authorization: 'Bearer garbage' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'closed' });
    expect(enrolment.poll).not.toHaveBeenCalled();
  });

  it('calls poll(id, secret) and returns its status for a well-formed bearer', async () => {
    const { app, enrolment } = buildApp();
    const secret = 'thb_req_' + 'c'.repeat(43);
    const r = await app.inject({ method: 'GET', url: '/devices/requests/r1', headers: { authorization: `Bearer ${secret}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'pending' });
    expect(enrolment.poll).toHaveBeenCalledWith('r1', secret);
  });
});

describe('POST /devices/activate', () => {
  it('passes the proof jwk/thumbprint to activate and answers 201 without pin_secret_enc', async () => {
    const { app, enrolment } = buildApp({ mobile: { proofJwk: { kty: 'EC' }, jwkThumbprint: 'thumb-x' } });
    const r = await app.inject({ method: 'POST', url: '/devices/activate', payload: { request_id: 'r1', request_secret: 'thb_req_' + 'a'.repeat(43) } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body).toEqual({ device_id: 'd1', pin_secret: 'pin-secret-plain', access_token: expect.stringMatching(/^thb_mob_/), expires_in: 900 });
    expect(JSON.stringify(body)).not.toContain('pin_secret_enc');
    expect(enrolment.activate).toHaveBeenCalledTimes(1);
    const [, proof] = enrolment.activate.mock.calls[0];
    expect(proof).toEqual({ jwk: { kty: 'EC' }, thumbprint: 'thumb-x' });
  });
});

describe('GET /devices/self', () => {
  it('returns the deviceSelf shape of request.mobile.device', async () => {
    const { app } = buildApp({ mobile: deviceMobile });
    const r = await app.inject({ method: 'GET', url: '/devices/self' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: 'd1', name: 'iPhone de Ana', platform: 'ios', model: 'iPhone 15', created_at: '2026-09-19T00:00:00.000Z', last_seen_at: '2026-09-20T00:00:00.000Z' });
  });
});

describe('POST /devices/self/revoke', () => {
  it('calls revokeDevice with reason user, actor user, and the caller IP, then answers { ok: true }', async () => {
    const { app, revoke } = buildApp({ mobile: deviceMobile });
    const r = await app.inject({ method: 'POST', url: '/devices/self/revoke' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(revoke).toHaveBeenCalledWith('d1', { reason: 'user', actor: 'user', ip: expect.any(String) });
  });
});

describe('PUT /push-token', () => {
  const goodToken = 'ExponentPushToken[abc123XYZ]';

  it('rejects a malformed Expo token with 400', async () => {
    const { app, devices } = buildApp({ mobile: deviceMobile });
    const r = await app.inject({ method: 'PUT', url: '/push-token', payload: { token: 'not-a-token' } });
    expect(r.statusCode).toBe(400);
    expect(devices.setPushToken).not.toHaveBeenCalled();
  });

  it('sets the token, records push_token_set, and answers { ok: true }', async () => {
    const { app, devices, deviceEvents } = buildApp({ mobile: deviceMobile });
    const r = await app.inject({ method: 'PUT', url: '/push-token', payload: { token: goodToken } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(devices.setPushToken).toHaveBeenCalledWith('d1', goodToken);
    expect(deviceEvents.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'push_token_set', device_id: 'd1' }));
  });

  it('moves a token already on another device: clears it there before setting it here', async () => {
    const { app, devices } = buildApp({ mobile: deviceMobile });
    const other: Device = { ...device, id: 'd2', user_id: 'u2' };
    devices.findByPushToken.mockResolvedValueOnce(other);
    const r = await app.inject({ method: 'PUT', url: '/push-token', payload: { token: goodToken } });
    expect(r.statusCode).toBe(200);
    const calls = devices.setPushToken.mock.calls;
    expect(calls[0]).toEqual(['d2', null]);
    expect(calls[1]).toEqual(['d1', goodToken]);
  });
});

describe('POST /push-test (TER-913)', () => {
  it('sends a test push to the calling device and answers 202', async () => {
    const { app, push } = buildApp({ mobile: deviceMobile });
    const r = await app.inject({ method: 'POST', url: '/push-test', payload: { kind: 'tab_question', delay_seconds: 10 } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ scheduled_for: '2026-10-05T00:00:10.000Z', ticket: null });
    expect(push.testPush).toHaveBeenCalledWith(user, device, 'tab_question', 10);
  });

  it('401 without a device session; 400 for a delay over 120 s', async () => {
    expect((await buildApp().app.inject({ method: 'POST', url: '/push-test', payload: {} })).statusCode).toBe(401);
    const { app, push } = buildApp({ mobile: deviceMobile });
    expect((await app.inject({ method: 'POST', url: '/push-test', payload: { delay_seconds: 121 } })).statusCode).toBe(400);
    expect(push.testPush).not.toHaveBeenCalled();
  });
});
