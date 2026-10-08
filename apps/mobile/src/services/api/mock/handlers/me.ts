// Authenticated device/account routes (P§6, design spec §4.2): `me`, `devices/self`,
// `devices/self/revoke`, `push-token`, `push-test`. All go through `verifyAuth`.
import { pushSettings, pushTestBody, pushTokenBody } from '../../contract';
import type { MockRouter } from '../router';
import { revokeDevice, type MockDevice, type MockState, verifyAuth, WireError } from '../state';

/** P§6's fixed permission list for the mobile role (ruling 7). */
const PERMISSIONS = [
  'chat:read',
  'chat:create',
  'chat:update',
  'devices:read',
  'devices:update',
  'devices:delete',
  'terminals:read',
  'terminals:create',
];

function deviceSelf(device: MockDevice) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    model: device.model,
    created_at: new Date(device.createdAt).toISOString(),
    last_seen_at: null,
  };
}

export function registerMeRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/me', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return {
      status: 200,
      body: {
        user: { id: device.userId, email: device.email, name: 'Pedro' },
        permissions: PERMISSIONS,
        features: { ...state.features },
        device: deviceSelf(device),
      },
    };
  });

  router.route('GET', '/api/m/v1/devices/self', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: deviceSelf(device) };
  });

  router.route('POST', '/api/m/v1/devices/self/revoke', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    // Same path as the brute-force lockout and `controls.revokeNow` (P§5.7): the device is marked
    // revoked and its sockets close with `4401`; its token rows stay, so a later call with one
    // answers `DEVICE_REVOKED` rather than an expired token.
    revokeDevice(state, device, 'user');
    return { status: 200, body: {} };
  });

  router.route('PUT', '/api/m/v1/push-token', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'PUT', htu: ctx.htu, now: ctx.now() });
    const body = pushTokenBody.parse(ctx.body);
    device.pushToken = body.token;
    return { status: 200, body: {} };
  });

  router.route('GET', '/api/m/v1/push-settings', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: { tab_finished: state.pushTabFinished } };
  });

  router.route('PUT', '/api/m/v1/push-settings', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'PUT', htu: ctx.htu, now: ctx.now() });
    state.pushTabFinished = pushSettings.parse(ctx.body).tab_finished;
    return { status: 200, body: { tab_finished: state.pushTabFinished } };
  });

  // Nothing is really sent in mock mode: it answers like the server (TER-913).
  router.route('POST', '/api/m/v1/push-test', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = pushTestBody.parse(ctx.body ?? {});
    if (!device.pushToken) throw new WireError(409, 'NO_PUSH_TOKEN', 'Este aparelho ainda não ativou as notificações.');
    const scheduledFor = new Date(ctx.now() + body.delay_seconds * 1000).toISOString();
    return { status: 202, body: { scheduled_for: scheduledFor, ticket: body.delay_seconds > 0 ? null : { status: 'ok' } } };
  });
}
