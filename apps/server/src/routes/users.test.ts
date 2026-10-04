import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories, WaitlistEntry } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { Role } from '../db/repositories/roles.js';
import type { Device } from '../db/repositories/devices.js';
import type { DeviceEvent } from '../db/repositories/device-events.js';
import type { Mail } from '../email/mailer.js';
import { applyErrorHandler } from '../lib/errors.js';
import { invalidatePermissionCache } from '../auth/permissions.js';
import { userRoutes } from './users.js';

const role: Role = { id: 'r-auth', name: 'AUTHENTICATED', label: 'Autenticado', description: null, is_system: true, is_admin: false, created_at: '' };
const adminRole: Role = { id: 'r-admin', name: 'ADMIN', label: 'Admin', description: null, is_system: true, is_admin: true, created_at: '' };

function entry(overrides: Partial<WaitlistEntry>): WaitlistEntry {
  return {
    id: 'w1', first_name: 'Ana', last_name: 'Lima', email: 'ana@gmail.com', phone_country: '55', phone_area: '62', phone_number: '999990000',
    phone: '+5562999990000', linkedin: null, github: null, locale: 'pt', source: 'landing', created_at: '2026-09-18T00:00:00.000Z', ...overrides,
  };
}

function user(overrides: Partial<User>): User {
  return {
    id: 'u-existing', email: 'ana@gmail.com', name: 'Ana', avatar_url: null, password_hash: null, google_id: null, role: 'member', role_id: role.id,
    invited_at: null, last_login_at: null, review_enabled_until: null, review_enabled_by: null, created_at: '', ...overrides,
  };
}

function device(overrides: Partial<Device> & { id: string }): Device {
  return {
    user_id: 'u-existing', name: 'iPhone de Ana', platform: 'ios', model: 'iPhone 15', os_version: '18.1', app_version: '1.0.0+1',
    public_key: '{}', key_thumbprint: 't', pin_failures: 0, pin_locked_until: null, status: 'active', revoked_at: null, revoked_reason: null,
    push_token: null, last_seen_at: null, last_ip: null, request_id: null, created_at: '2026-09-19T00:00:00.000Z', ...overrides,
  };
}

function deviceEvent(overrides: Partial<DeviceEvent> & { id: string; kind: DeviceEvent['kind'] }): DeviceEvent {
  return {
    user_id: 'u-existing', device_id: null, request_id: null, actor: 'user', ip: null, country: null, city: null, meta: {},
    created_at: '2026-09-19T00:00:00.000Z', ...overrides,
  };
}

/** Stubbed repos, mailer and allowlist; the route under test is the waitlist → alpha invite. */
function buildApp(opts: { entries: WaitlistEntry[]; users?: User[]; sendError?: Error }) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user({ id: 'admin', name: 'Pedro', email: 'pedro@gmail.com' });
  });
  const users = [...(opts.users ?? [])];
  const created: Parameters<Repositories['users']['create']>[0][] = [];
  const marked: string[][] = [];
  const sent: Mail[] = [];
  const repos = {
    users: {
      findByEmail: async (email: string) => users.find((u) => u.email === email),
      create: async (input: Parameters<Repositories['users']['create']>[0]) => {
        created.push(input);
        const u = user({ id: `u-${created.length}`, email: input.email, name: input.name, role_id: input.role_id, invited_at: new Date().toISOString() });
        users.push(u);
        return u;
      },
    },
    roles: { findById: async (id: string) => (id === role.id ? role : undefined) },
    waitlist: {
      findByIds: async (ids: string[]) => opts.entries.filter((e) => ids.includes(e.id)),
      markInvited: async (ids: string[]) => {
        marked.push(ids);
      },
    },
  } as unknown as Repositories;
  const mailer = {
    send: vi.fn(async (mail: Mail) => {
      if (opts.sendError) throw opts.sendError;
      sent.push(mail);
    }),
  };
  const access = { add: vi.fn(), remove: vi.fn(), status: vi.fn() };
  app.register((instance) => userRoutes(instance, repos, { mailer, access: access as never, deletion: { purge: vi.fn() }, revoke: null }), { prefix: '/api/users' });
  return { app, created, marked, sent };
}

const invite = (app: ReturnType<typeof Fastify>, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/users/invite-from-waitlist', payload });

describe('POST /api/users/invite-from-waitlist', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a user per entry, sends the alpha e-mail in the entry locale and marks it invited', async () => {
    const { app, created, marked, sent } = buildApp({ entries: [entry({}), entry({ id: 'w2', email: 'bob@gmail.com', first_name: 'Bob', locale: 'en' })] });
    const res = await invite(app, { ids: ['w1', 'w2'], role_id: role.id });
    expect(res.statusCode).toBe(200);
    expect(created.map((c) => [c.email, c.name, c.role_id])).toEqual([
      ['ana@gmail.com', 'Ana Lima', role.id],
      ['bob@gmail.com', 'Bob Lima', role.id],
    ]);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ['ana@gmail.com', expect.stringContaining('Você está na alpha')],
      ['bob@gmail.com', expect.stringContaining("You're in the termhub alpha")],
    ]);
    expect(sent[0]!.text).toContain('https://77a.it/comunidadetermhub');
    expect(marked).toEqual([['w1', 'w2']]);
    const body = res.json();
    expect(body.results.map((r: { id: string; mail: { sent: boolean } }) => [r.id, r.mail.sent])).toEqual([
      ['w1', true],
      ['w2', true],
    ]);
  });

  it('reuses an existing user with the same e-mail instead of failing with 409', async () => {
    const existing = user({ id: 'u-existing' });
    const { app, created, marked, sent } = buildApp({ entries: [entry({})], users: [existing] });
    const res = await invite(app, { ids: ['w1'], role_id: role.id });
    expect(res.statusCode).toBe(200);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(marked).toEqual([['w1']]);
    expect(res.json().results[0]).toMatchObject({ id: 'w1', user_id: 'u-existing', existing: true });
  });

  it('reports an unknown id in the results without touching the others', async () => {
    const { app, created, marked } = buildApp({ entries: [entry({})] });
    const res = await invite(app, { ids: ['w1', 'nope'], role_id: role.id });
    expect(res.statusCode).toBe(200);
    expect(created).toHaveLength(1);
    expect(marked).toEqual([['w1']]);
    expect(res.json().results).toEqual([expect.objectContaining({ id: 'w1' }), { id: 'nope', error: 'Entry not found' }]);
  });

  it('still marks the entry and reports the mail failure when sending fails', async () => {
    const { app, marked } = buildApp({ entries: [entry({})], sendError: new Error('smtp down') });
    const res = await invite(app, { ids: ['w1'], role_id: role.id });
    expect(res.statusCode).toBe(200);
    expect(marked).toEqual([['w1']]);
    expect(res.json().results[0].mail).toEqual({ sent: false, error: 'smtp down' });
  });

  it('answers 400 for an unknown role', async () => {
    const { app } = buildApp({ entries: [entry({})] });
    const res = await invite(app, { ids: ['w1'], role_id: 'r-nope' });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/users/:id', () => {
  function buildDeleteApp(purged = true) {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = user({ id: 'admin', name: 'Pedro', email: 'pedro@gmail.com' });
    });
    const repos = {
      users: { findById: async (id: string) => (id === 'u-ana' ? user({ id: 'u-ana' }) : undefined) },
      roles: { findById: async (id: string) => (id === role.id ? role : undefined) },
    } as unknown as Repositories;
    const access = { add: vi.fn(), remove: vi.fn(), status: vi.fn() };
    const purge = vi.fn(async () => purged);
    app.register((instance) => userRoutes(instance, repos, { mailer: { send: vi.fn() }, access: access as never, deletion: { purge }, revoke: null }), { prefix: '/api/users' });
    return { app, purge };
  }

  // The same cascade as a self-service deletion (TER-720), at once and without the e-mail: nothing
  // the account owned is left behind ownerless, and the public city, agents and Access entry are
  // cleaned up by the service (account/deletion.test.ts).
  it('deletes the account and everything it owns through the deletion service', async () => {
    const { app, purge } = buildDeleteApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/users/u-ana' });
    expect(res.statusCode).toBe(200);
    expect(purge).toHaveBeenCalledWith('u-ana', { actor: 'admin:admin', notify: false });
  });

  it('refuses the admin themselves and an unknown id', async () => {
    const { app, purge } = buildDeleteApp();
    expect((await app.inject({ method: 'DELETE', url: '/api/users/admin' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/users/nobody' })).statusCode).toBe(404);
    expect(purge).not.toHaveBeenCalled();
  });
});

// ── Store-review switch (Task 17): POST/GET/DELETE .../review, .../devices ────────────────────

interface ReviewAppOpts {
  users?: User[];
  devices?: Device[];
  events?: DeviceEvent[];
  /** null simulates config.mobile unset (app.ts passes `revoke: null` in that case). */
  revoke?: ReturnType<typeof vi.fn> | null;
  /** overrides the default stub, e.g. to make one call reject while others still succeed. */
  revokeImpl?: (id: string) => Promise<Device | undefined>;
  /** role id -> its grants, for `canAccess`'s `devices:create` check (GET .../devices' `can_enrol`). */
  rolePermissions?: Record<string, Array<{ resource: string; action: string }>>;
}

function buildReviewApp(opts: ReviewAppOpts = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user({ id: 'admin', name: 'Pedro', email: 'pedro@gmail.com', role_id: adminRole.id });
  });
  const users = opts.users ?? [user({ id: 'u-target' })];
  const devices = opts.devices ?? [];
  const events = opts.events ?? [];
  const setReview = vi.fn(async (id: string, until: Date | null, by: string | null) => {
    const idx = users.findIndex((u) => u.id === id);
    const updated = { ...users[idx]!, review_enabled_until: until ? until.toISOString() : null, review_enabled_by: by };
    users[idx] = updated;
    return updated;
  });
  const recordEvent = vi.fn(async () => {});
  const defaultRevokeImpl = async (id: string) => {
    const d = devices.find((x) => x.id === id);
    return d ? { ...d, status: 'revoked' as const, revoked_reason: 'review' } : undefined;
  };
  const revoke = opts.revoke === null ? null : (opts.revoke ?? vi.fn(opts.revokeImpl ?? defaultRevokeImpl));
  const repos = {
    users: {
      findById: async (id: string) => users.find((u) => u.id === id),
      setReview,
    },
    roles: {
      findById: async (id: string) => (id === role.id ? role : id === adminRole.id ? adminRole : undefined),
      permissionsOf: async (roleId: string) => opts.rolePermissions?.[roleId] ?? [],
    },
    devices: {
      listByUser: async (userId: string) => devices.filter((d) => d.user_id === userId),
      findById: async (id: string) => devices.find((d) => d.id === id),
    },
    deviceEvents: {
      record: recordEvent,
      listForUser: async (userId: string) => events.filter((e) => e.user_id === userId),
    },
  } as unknown as Repositories;
  const mailer = { send: vi.fn() };
  const access = { add: vi.fn(), remove: vi.fn(), status: vi.fn() };
  app.register((instance) => userRoutes(instance, repos, { mailer, access: access as never, deletion: { purge: vi.fn() }, revoke: revoke as never }), { prefix: '/api/users' });
  return { app, users, devices, events, setReview, recordEvent, revoke };
}

describe('POST /api/users/:id/review', () => {
  beforeEach(() => {
    invalidatePermissionCache();
  });

  it('turns review on for the chosen number of days, recording review_changed and answering review_enabled_until as now + days', async () => {
    const { app, setReview, recordEvent } = buildReviewApp();
    const before = Date.now();
    const res = await app.inject({ method: 'POST', url: '/api/users/u-target/review', payload: { days: 3, revoke_devices: false } });
    const after = Date.now();
    expect(res.statusCode).toBe(200);
    const returned = res.json().user.review_enabled_until as string;
    // The admin view keeps who turned it on (toPublicUser, used by /auth/me, strips it).
    expect(res.json().user.review_enabled_by).toBe('admin');
    const untilMs = new Date(returned).getTime();
    // The route computes `now` itself (no injectable clock), so pin it to a window around the call
    // instead of a single instant: still tight enough to catch a wrong offset (hours, days, sign).
    expect(untilMs).toBeGreaterThanOrEqual(before + 3 * 24 * 60 * 60 * 1000);
    expect(untilMs).toBeLessThanOrEqual(after + 3 * 24 * 60 * 60 * 1000);
    expect(setReview).toHaveBeenCalledWith('u-target', new Date(returned), 'admin');
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u-target', kind: 'review_changed', actor: 'admin:admin', meta: { until: returned } }));
  });

  it('days: null turns review off', async () => {
    const { app, setReview } = buildReviewApp({ users: [user({ id: 'u-target', review_enabled_until: '2026-10-01T00:00:00.000Z', review_enabled_by: 'admin:someone' })] });
    const res = await app.inject({ method: 'POST', url: '/api/users/u-target/review', payload: { days: null } });
    expect(res.statusCode).toBe(200);
    expect(setReview).toHaveBeenCalledWith('u-target', null, 'admin');
    expect(res.json().user.review_enabled_until).toBeNull();
  });

  it('refuses an admin target with 400 REVIEW_ADMIN before writing anything', async () => {
    const { app, setReview, recordEvent } = buildReviewApp({ users: [user({ id: 'u-admin', role_id: adminRole.id })] });
    const res = await app.inject({ method: 'POST', url: '/api/users/u-admin/review', payload: { days: 3 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'A conta de revisão não pode ser admin.', code: 'REVIEW_ADMIN' });
    expect(setReview).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('with revoke_devices, revokes every active device of the target with reason review', async () => {
    const devices = [
      device({ id: 'd1', user_id: 'u-target', status: 'active' }),
      device({ id: 'd2', user_id: 'u-target', status: 'revoked' }),
      device({ id: 'd3', user_id: 'someone-else', status: 'active' }),
    ];
    const { app, revoke } = buildReviewApp({ devices });
    const res = await app.inject({ method: 'POST', url: '/api/users/u-target/review', payload: { days: 7, revoke_devices: true } });
    expect(res.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('d1', { reason: 'review', actor: 'admin:admin' });
    expect(res.json().revoked_devices).toBe(1);
  });

  it('with revoke_devices, one failing revoke does not abort the rest nor the response, and only successes are counted', async () => {
    const devices = [
      device({ id: 'd1', user_id: 'u-target', status: 'active' }),
      device({ id: 'd2', user_id: 'u-target', status: 'active' }),
    ];
    const revokeImpl = vi.fn(async (id: string) => {
      if (id === 'd1') throw new Error('boom');
      return { ...devices.find((d) => d.id === id)!, status: 'revoked' as const, revoked_reason: 'review' };
    });
    const { app } = buildReviewApp({ devices, revokeImpl });
    const res = await app.inject({ method: 'POST', url: '/api/users/u-target/review', payload: { days: 7, revoke_devices: true } });
    expect(res.statusCode).toBe(200);
    expect(revokeImpl).toHaveBeenCalledTimes(2);
    expect(revokeImpl).toHaveBeenCalledWith('d1', { reason: 'review', actor: 'admin:admin' });
    expect(revokeImpl).toHaveBeenCalledWith('d2', { reason: 'review', actor: 'admin:admin' });
    expect(res.json().revoked_devices).toBe(1);
  });

  it('answers 404 for an unknown user', async () => {
    const { app } = buildReviewApp({ users: [] });
    const res = await app.inject({ method: 'POST', url: '/api/users/nope/review', payload: { days: 1 } });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/users/:id/devices', () => {
  beforeEach(() => {
    invalidatePermissionCache();
  });

  it("answers the target's devices and events, each event carrying its pt-BR text", async () => {
    const devices = [device({ id: 'd1', user_id: 'u-target' })];
    const events = [deviceEvent({ id: 'e1', user_id: 'u-target', kind: 'request_approved', meta: { model: 'iPhone 15' } })];
    const { app } = buildReviewApp({ devices, events });
    const res = await app.inject({ method: 'GET', url: '/api/users/u-target/devices' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.devices).toEqual([expect.objectContaining({ id: 'd1' })]);
    expect(body.events).toEqual([expect.objectContaining({ id: 'e1', text: 'Pedido aprovado de iPhone 15' })]);
  });

  it("carries a review_changed event's text among the target's events", async () => {
    const events = [deviceEvent({ id: 'e1', user_id: 'u-target', kind: 'review_changed', meta: { until: '2026-09-30T18:45:00.000Z' } })];
    const { app } = buildReviewApp({ events });
    const res = await app.inject({ method: 'GET', url: '/api/users/u-target/devices' });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([expect.objectContaining({ id: 'e1', text: 'Modo revisão ligado até 30/09/2026 15:45' })]);
  });

  it("answers can_enrol true when the target's role has devices:create", async () => {
    const { app } = buildReviewApp({ rolePermissions: { [role.id]: [{ resource: 'devices', action: 'create' }] } });
    const res = await app.inject({ method: 'GET', url: '/api/users/u-target/devices' });
    expect(res.statusCode).toBe(200);
    expect(res.json().can_enrol).toBe(true);
  });

  it("answers can_enrol false when the target's role lacks devices:create", async () => {
    const { app } = buildReviewApp({ rolePermissions: { [role.id]: [] } });
    const res = await app.inject({ method: 'GET', url: '/api/users/u-target/devices' });
    expect(res.statusCode).toBe(200);
    expect(res.json().can_enrol).toBe(false);
  });

  it('answers 503 MOBILE_DISABLED when the server has no revoke closure (mobile not configured)', async () => {
    const { app } = buildReviewApp({ revoke: null });
    const res = await app.inject({ method: 'GET', url: '/api/users/u-target/devices' });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('MOBILE_DISABLED');
  });
});

describe('DELETE /api/users/:id/devices/:deviceId', () => {
  it("revokes the target's device with reason admin", async () => {
    const devices = [device({ id: 'd1', user_id: 'u-target' })];
    const { app, revoke } = buildReviewApp({ devices });
    const res = await app.inject({ method: 'DELETE', url: '/api/users/u-target/devices/d1' });
    expect(res.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith('d1', { reason: 'admin', actor: 'admin:admin' });
  });

  it('404s unless the device belongs to :id', async () => {
    const devices = [device({ id: 'd1', user_id: 'someone-else' })];
    const { app, revoke } = buildReviewApp({ devices });
    const res = await app.inject({ method: 'DELETE', url: '/api/users/u-target/devices/d1' });
    expect(res.statusCode).toBe(404);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('answers 503 MOBILE_DISABLED when the server has no revoke closure', async () => {
    const { app } = buildReviewApp({ revoke: null });
    const res = await app.inject({ method: 'DELETE', url: '/api/users/u-target/devices/d1' });
    expect(res.statusCode).toBe(503);
  });
});
