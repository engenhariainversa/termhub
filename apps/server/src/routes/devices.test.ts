import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { DeviceRequest } from '../db/repositories/device-requests.js';
import type { Device } from '../db/repositories/devices.js';
import { DEVICE_EVENT_KINDS, type DeviceEvent } from '../db/repositories/device-events.js';
import { applyErrorHandler, HttpError } from '../lib/errors.js';
import { deviceRoutes, describeDeviceEvent } from './devices.js';

const deviceRequest = (over: Partial<DeviceRequest> & { id: string }): DeviceRequest => ({
  user_id: 'u1',
  email_hash: 'h',
  public_key: '{}',
  key_thumbprint: 't',
  platform: 'ios',
  model: 'iPhone 15',
  os_version: '18.1',
  device_name: 'iPhone de Pedro',
  app_version: '1.0.0+1',
  verification_code: 'K7F2QD',
  status: 'pending',
  ip: '9.9.9.9',
  country: 'BR',
  city: 'Goiânia',
  created_at: '2026-09-19T00:00:00.000Z',
  expires_at: '2026-09-19T00:10:00.000Z',
  decided_at: null,
  activate_until: null,
  ...over,
});

const device = (over: Partial<Device> & { id: string }): Device => ({
  user_id: 'u1',
  name: 'iPhone de Pedro',
  platform: 'ios',
  model: 'iPhone 15',
  os_version: '18.1',
  app_version: '1.0.0+1',
  public_key: '{}',
  key_thumbprint: 't',
  pin_failures: 0,
  pin_locked_until: null,
  status: 'active',
  revoked_at: null,
  revoked_reason: null,
  push_token: null,
  last_seen_at: null,
  last_ip: null,
  request_id: 'r1',
  created_at: '2026-09-19T00:00:00.000Z',
  ...over,
});

const deviceEvent = (over: Partial<DeviceEvent> & { id: string; kind: DeviceEvent['kind'] }): DeviceEvent => ({
  user_id: 'u1',
  device_id: null,
  request_id: null,
  actor: 'user',
  ip: null,
  country: null,
  city: null,
  meta: {},
  created_at: '2026-09-19T00:00:00.000Z',
  ...over,
});

interface RegisteredRoute {
  method: string;
  url: string;
  config?: { action?: string };
}

/** Routes over stubbed repos and mobile services. `viewAs` simulates an admin viewing as another user. */
function buildApp(opts: { viewAs?: string } = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  // Captured for the `config.action` assertions below: this app never goes through app.ts's
  // `guarded()` (which would derive `action` from the HTTP method), so a route only carries an
  // `action` here when the route itself sets one — exactly what we want to prove.
  const routes: RegisteredRoute[] = [];
  app.addHook('onRoute', (route) => {
    routes.push({ method: String(route.method), url: route.url, config: route.config as { action?: string } | undefined });
  });
  app.addHook('preHandler', async (request) => {
    const owner = opts.viewAs ?? 'u1';
    request.user = { id: 'u1' } as never;
    request.scope = { user: { id: 'u1' } as never, viewAs: opts.viewAs ? { kind: 'user', user: { id: owner } as never } : { kind: 'self' }, ownerId: owner, createAs: owner };
  });

  const deviceRequests = {
    listPendingForUser: vi.fn(async (userId: string) => [deviceRequest({ id: 'r1', user_id: userId })]),
    countPendingForUser: vi.fn(async () => 1),
  };
  const devices = {
    listByUser: vi.fn(async (userId: string) => [device({ id: 'd1', user_id: userId })]),
    findById: vi.fn(async (id: string) => (id === 'd1' ? device({ id: 'd1', user_id: 'u1' }) : undefined)),
    rename: vi.fn(async (id: string, userId: string, name: string) => (id === 'd1' && userId === 'u1' ? device({ id, name }) : undefined)),
    countActive: vi.fn(async () => 2),
    findActiveById: vi.fn(async (id: string) => (id === 'd1' ? device({ id: 'd1', user_id: 'u1', push_token: 'ExponentPushToken[a]' }) : id === 'dx' ? device({ id: 'dx', user_id: 'u2' }) : undefined)),
  };
  const deviceEvents = {
    listForUser: vi.fn(async (userId: string) => [
      deviceEvent({ id: 'e1', user_id: userId, kind: 'request_approved', meta: { model: 'iPhone 15' } }),
    ]),
  };
  const enrolment = {
    approve: vi.fn(async (id: string) => deviceRequest({ id, status: 'approved' })),
    deny: vi.fn(async (id: string) => deviceRequest({ id, status: 'denied' })),
  };
  const revoke = vi.fn(async (id: string) => device({ id, status: 'revoked', revoked_at: '2026-09-19T01:00:00.000Z', revoked_reason: 'user' }));
  const push = { testPush: vi.fn(async () => ({ scheduled_for: '2026-10-05T00:00:00.000Z', ticket: { status: 'ok' as const } })) };

  app.register(
    (a) =>
      deviceRoutes(a, { deviceRequests, devices, deviceEvents } as unknown as Repositories, {
        enrolment: enrolment as never,
        revoke,
        push,
      }),
    { prefix: '/devices' },
  );
  return { app, routes, deviceRequests, devices, deviceEvents, enrolment, revoke, push };
}

describe('device routes', () => {
  it('lists only pending device requests, with the verification code formatted', async () => {
    const { app, deviceRequests } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/devices/requests' });
    expect(r.statusCode).toBe(200);
    expect(deviceRequests.listPendingForUser).toHaveBeenCalledWith('u1', expect.any(Date));
    const body = r.json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({
      id: 'r1',
      device_name: 'iPhone de Pedro',
      model: 'iPhone 15',
      platform: 'ios',
      os_version: '18.1',
      country: 'BR',
      city: 'Goiânia',
      ip: '9.9.9.9',
      verification_code: 'K7F-2QD',
    });
    expect(body.requests[0]).not.toHaveProperty('public_key');
    expect(body.requests[0]).not.toHaveProperty('email_hash');
  });

  it('approves a request through the enrolment service and answers the request view', async () => {
    const { app, enrolment } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/devices/requests/r1/approve' });
    expect(r.statusCode).toBe(200);
    expect(enrolment.approve).toHaveBeenCalledWith('r1', expect.objectContaining({ id: 'u1' }), expect.any(Object));
    const body = r.json().request;
    expect(body).toMatchObject({ id: 'r1', device_name: 'iPhone de Pedro', model: 'iPhone 15', verification_code: 'K7F-2QD' });
    expect(body).not.toHaveProperty('public_key');
    expect(body).not.toHaveProperty('key_thumbprint');
    expect(body).not.toHaveProperty('email_hash');
    expect(body).not.toHaveProperty('status');
  });

  it('denies a request through the enrolment service and answers the request view', async () => {
    const { app, enrolment } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/devices/requests/r1/deny' });
    expect(r.statusCode).toBe(200);
    expect(enrolment.deny).toHaveBeenCalledWith('r1', expect.objectContaining({ id: 'u1' }), expect.any(Object));
    const body = r.json().request;
    expect(body).toMatchObject({ id: 'r1', device_name: 'iPhone de Pedro', model: 'iPhone 15', verification_code: 'K7F-2QD' });
    expect(body).not.toHaveProperty('public_key');
    expect(body).not.toHaveProperty('key_thumbprint');
    expect(body).not.toHaveProperty('email_hash');
    expect(body).not.toHaveProperty('status');
  });

  it('registers approve and deny as an update, not the create that guarded() would derive from POST', async () => {
    const { app, routes } = buildApp();
    await app.ready();
    const approve = routes.find((r) => r.method === 'POST' && r.url === '/devices/requests/:id/approve');
    const deny = routes.find((r) => r.method === 'POST' && r.url === '/devices/requests/:id/deny');
    expect(approve?.config).toMatchObject({ action: 'update' });
    expect(deny?.config).toMatchObject({ action: 'update' });
  });

  it('passes a DEVICE_LIMIT 409 from the enrolment service through with its pt-BR message', async () => {
    const { app, enrolment } = buildApp();
    enrolment.approve.mockRejectedValueOnce(new HttpError(409, 'Revogue um aparelho antes', 'DEVICE_LIMIT'));
    const r = await app.inject({ method: 'POST', url: '/devices/requests/r1/approve' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'Revogue um aparelho antes', code: 'DEVICE_LIMIT' });
  });

  it('lists the caller\'s devices', async () => {
    const { app, devices } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/devices' });
    expect(r.statusCode).toBe(200);
    expect(devices.listByUser).toHaveBeenCalledWith('u1');
    expect(r.json().devices).toHaveLength(1);
  });

  it('revokes the caller\'s own device only when it belongs to them', async () => {
    const { app, devices, revoke } = buildApp();
    const ok = await app.inject({ method: 'DELETE', url: '/devices/d1' });
    expect(ok.statusCode).toBe(200);
    expect(devices.findById).toHaveBeenCalledWith('d1');
    expect(revoke).toHaveBeenCalledWith('d1', { reason: 'user', actor: 'user', ip: expect.any(String) });
    expect(ok.json().device.status).toBe('revoked');
  });

  it('404s deleting another user\'s device and never calls revoke', async () => {
    const { app, devices, revoke } = buildApp();
    devices.findById.mockResolvedValueOnce(device({ id: 'd2', user_id: 'u2' }));
    const r = await app.inject({ method: 'DELETE', url: '/devices/d2' });
    expect(r.statusCode).toBe(404);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('404s deleting an unknown device', async () => {
    const { app, revoke } = buildApp();
    const r = await app.inject({ method: 'DELETE', url: '/devices/unknown' });
    expect(r.statusCode).toBe(404);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('trims and renames a device', async () => {
    const { app, devices } = buildApp();
    const r = await app.inject({ method: 'PATCH', url: '/devices/d1', payload: { name: '  Meu iPhone  ' } });
    expect(r.statusCode).toBe(200);
    expect(devices.rename).toHaveBeenCalledWith('d1', 'u1', 'Meu iPhone');
    expect(r.json().device.name).toBe('Meu iPhone');
  });

  it('rejects a name over 60 chars with 400 and renames nothing', async () => {
    const { app, devices } = buildApp();
    const r = await app.inject({ method: 'PATCH', url: '/devices/d1', payload: { name: 'x'.repeat(61) } });
    expect(r.statusCode).toBe(400);
    expect(devices.rename).not.toHaveBeenCalled();
  });

  it.each([
    ['request_created', { model: 'iPhone 15', platform: 'ios' }, 'Pedido de acesso de iPhone 15'],
    ['request_created', {}, 'Pedido de acesso'],
    ['request_approved', { model: 'iPhone 15' }, 'Pedido aprovado de iPhone 15'],
    ['request_approved', {}, 'Pedido aprovado'],
    ['request_denied', {}, 'Pedido recusado'],
    ['request_expired', {}, 'Pedido expirou sem resposta'],
    ['device_activated', {}, 'Aparelho ativado'],
    ['pin_failed', { failures: 2 }, 'PIN errado (2ª tentativa)'],
    ['pin_failed', {}, 'PIN errado'],
    ['device_revoked', {}, 'Aparelho revogado'],
    ['push_token_set', {}, 'Notificações ativadas neste aparelho'],
    ['push_failed', { code: 'DeviceNotRegistered' }, 'Notificação recusada: o aparelho não aceita mais avisos (app removido ou notificações desligadas)'],
    ['push_failed', { code: 'InvalidCredentials' }, 'Notificação não entregue: credencial da Apple ou do Google inválida no servidor'],
    ['push_failed', { code: 'MessageTooBig' }, 'Notificação não entregue (MessageTooBig)'],
    ['pin_locked', {}, 'PIN errado 3 vezes, aparelho bloqueado por 15 min'],
    ['device_revoked', { reason: 'pin_bruteforce' }, 'Aparelho revogado por tentativas de PIN'],
    ['device_revoked', { reason: 'user' }, 'Aparelho revogado por você'],
    ['device_revoked', { reason: 'admin' }, 'Aparelho revogado por um administrador'],
    ['device_revoked', { reason: 'review' }, 'Aparelho revogado ao desligar o modo revisão'],
    ['review_auto_approved', {}, 'Aprovado automaticamente (conta de revisão)'],
    ['review_changed', { until: '2026-09-30T18:45:00.000Z' }, 'Modo revisão ligado até 30/09/2026 15:45'],
    ['review_changed', { until: null }, 'Modo revisão desligado'],
    ['token_refreshed', {}, 'Sessão renovada'],
  ] as const)('describeDeviceEvent(%s) -> %s', (kind, meta, text) => {
    expect(describeDeviceEvent(deviceEvent({ id: 'e1', kind, meta }))).toBe(text);
  });

  it.each(DEVICE_EVENT_KINDS)('has a pt-BR sentence for %s, never the raw kind', (kind) => {
    const text = describeDeviceEvent(deviceEvent({ id: 'e1', kind, meta: {} }));
    expect(text).not.toBe(kind);
    expect(text).not.toMatch(/_/);
  });

  it('lists the last events with a pt-BR text', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/devices/events' });
    expect(r.statusCode).toBe(200);
    expect(r.json().events).toEqual([expect.objectContaining({ id: 'e1', kind: 'request_approved', text: 'Pedido aprovado de iPhone 15' })]);
  });

  it('returns a summary of pending requests and active devices', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/devices/summary' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ pending_requests: 1, active_devices: 2 });
  });

  it('an admin viewing as another user still sees and acts on that user\'s own devices only through request.user', async () => {
    const { app, deviceRequests, devices } = buildApp({ viewAs: 'u2' });
    await app.inject({ method: 'GET', url: '/devices/requests' });
    expect(deviceRequests.listPendingForUser).toHaveBeenCalledWith('u1', expect.any(Date));
    await app.inject({ method: 'GET', url: '/devices' });
    expect(devices.listByUser).toHaveBeenCalledWith('u1');
    await app.inject({ method: 'DELETE', url: '/devices/d1' });
    expect(devices.findById).toHaveBeenCalledWith('d1');
  });
});

describe('POST /devices/:id/test-push (TER-913)', () => {
  it('sends to the user\'s own active device with the kind and delay, answers 202, action update', async () => {
    const { app, push, routes } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/devices/d1/test-push', payload: { kind: 'reply', delay_seconds: 10 } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ scheduled_for: '2026-10-05T00:00:00.000Z', ticket: { status: 'ok' } });
    expect(push.testPush).toHaveBeenCalledWith({ id: 'u1' }, expect.objectContaining({ id: 'd1' }), 'reply', 10);
    expect(routes.find((x) => x.method === 'POST' && x.url === '/devices/:id/test-push')?.config?.action).toBe('update');
  });

  it('defaults to a confirmation sent at once', async () => {
    const { app, push } = buildApp();
    await app.inject({ method: 'POST', url: '/devices/d1/test-push' });
    expect(push.testPush).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'confirmation', 0);
  });

  it('404 for another user\'s device and for one that is not active (revoked or unknown)', async () => {
    const { app, push } = buildApp();
    for (const id of ['dx', 'd-revoked']) {
      const r = await app.inject({ method: 'POST', url: `/devices/${id}/test-push`, payload: {} });
      expect(r.statusCode).toBe(404);
    }
    expect(push.testPush).not.toHaveBeenCalled();
  });

  it('rejects a delay over 120 s and an unknown kind', async () => {
    const { app, push } = buildApp();
    expect((await app.inject({ method: 'POST', url: '/devices/d1/test-push', payload: { delay_seconds: 121 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/devices/d1/test-push', payload: { kind: 'boom' } })).statusCode).toBe(400);
    expect(push.testPush).not.toHaveBeenCalled();
  });
});

describe('describeDeviceEvent push_test', () => {
  it.each([
    [{ outcome: 'delivered_to_provider' }, 'Notificação de teste: entregue à Apple/Google'],
    [{ outcome: 'receipt_pending' }, 'Notificação de teste enviada; a Apple/Google ainda não confirmou'],
    [{ outcome: 'send_failed' }, 'Notificação de teste falhou: o servidor não conseguiu enviar'],
    [{ outcome: 'InvalidCredentials' }, 'Notificação de teste falhou: InvalidCredentials'],
  ])('%j', (meta, text) => {
    expect(describeDeviceEvent(deviceEvent({ id: 'e', kind: 'push_test', meta }))).toBe(text);
  });
});
