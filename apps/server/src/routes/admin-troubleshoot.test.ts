import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { SecurityEventInput } from '../db/repositories/security-events.js';
import { applyErrorHandler } from '../lib/errors.js';
import { invalidatePermissionCache } from '../auth/permissions.js';
import { adminTroubleshootRoutes } from './admin-troubleshoot.js';

const ADMIN = { id: 'adm', email: 'admin@x.dev', role_id: 'r-admin' };
const MEMBER = { id: 'mem', email: 'member@x.dev', role_id: 'r-member' };

/** What the support views may never carry, whatever the endpoint. */
const FORBIDDEN_FIELDS = /"(email|ip|last_ip|text|state_text|content|prompt|token|token_hash|network|host|hostname|public_key|push_token|cwd)"/;

function buildApp(user: typeof ADMIN, opts: { failAudit?: boolean } = {}) {
  invalidatePermissionCache();
  const order: string[] = [];
  const recorded: SecurityEventInput[] = [];
  const support = {
    searchUsers: vi.fn(async () => (order.push('read'), [{ user_id: 'u1', name: 'Humberto', created_at: '2026-10-01T00:00:00.000Z', last_login_at: null }])),
    findUser: vi.fn(async (id: string) => (id === 'u1' ? { id: 'u1', name: 'Humberto' } : undefined)),
    requests: vi.fn(async () => (order.push('read'), [{ at: '2026-10-20T10:00:00.000Z', kind: 'http', method: 'GET', route: '/api/tabs/:id', status: 200, duration_ms: 12, client: 'web/1.4.0' }])),
    tabs: vi.fn(async () => (order.push('read'), [{ tab_id: 't1', kind: 'terminal', agent: 'claude', machine_id: 'm1', machine_name: 'Mac', state: 'idle', state_at: null, created_at: '2026-10-20T09:00:00.000Z', events: { working: 3 } }])),
    errors: vi.fn(async () => (order.push('read'), [{ at: '2026-10-20T10:00:00.000Z', source: 'http', method: 'POST', route: '/api/chat', status: 500, duration_ms: 30 }])),
    clients: vi.fn(async () => (order.push('read'), [{ client: 'web/1.4.0', os: 'macOS', requests: 4, last_at: '2026-10-20T10:00:00.000Z' }])),
    devices: vi.fn(async () => [{ platform: 'ios', model: 'iPhone15,2', os_version: '18.0', app_version: '0.3.2', status: 'active', last_seen_at: null }]),
  };
  const repos = {
    roles: {
      findById: vi.fn(async (id: string) => ({ id, is_admin: id === 'r-admin' })),
      // A member whose role was granted users:read still gets 403: the endpoints are not a grant.
      permissionsOf: vi.fn(async () => [{ resource: 'users', action: 'read' }]),
    },
    support,
    securityEvents: {
      record: vi.fn(async (e: SecurityEventInput) => {
        if (opts.failAudit) throw new Error('db down');
        order.push('audit');
        recorded.push(e);
      }),
    },
    machines: { list: vi.fn(async () => []) },
    machineHooks: { installedAtByMachine: vi.fn(async () => ({})) },
  } as unknown as Repositories;
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
  });
  app.register((a) => adminTroubleshootRoutes(a, repos), { prefix: '/admin/troubleshoot' });
  return { app, recorded, order, support };
}

describe('admin troubleshoot routes: authorization', () => {
  it('refuses a non-admin with 403, even with users:read, and reads nothing', async () => {
    const { app, support, recorded } = buildApp(MEMBER);
    const r = await app.inject({ url: '/admin/troubleshoot/users/u1/requests?reason=TER-1091' });
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ url: '/admin/troubleshoot/users?q=hum&reason=TER-1091' })).statusCode).toBe(403);
    expect(support.requests).not.toHaveBeenCalled();
    expect(support.searchUsers).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('answers 400 to an admin without a reason, and reads nothing', async () => {
    const { app, support, recorded } = buildApp(ADMIN);
    for (const url of ['/admin/troubleshoot/users/u1/requests', '/admin/troubleshoot/users/u1/tabs?reason=', '/admin/troubleshoot/users?q=hum']) {
      expect((await app.inject({ url })).statusCode).toBe(400);
    }
    expect(support.requests).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('refuses a window longer than 7 days or upside down', async () => {
    const { app } = buildApp(ADMIN);
    const long = await app.inject({ url: '/admin/troubleshoot/users/u1/requests?reason=TER-1091&from=2026-10-01T00:00:00Z&to=2026-10-09T00:00:00Z' });
    expect(long.statusCode).toBe(400);
    expect(long.json().code).toBe('WINDOW_TOO_LONG');
    const back = await app.inject({ url: '/admin/troubleshoot/users/u1/requests?reason=TER-1091&from=2026-10-09T00:00:00Z&to=2026-10-08T00:00:00Z' });
    expect(back.json().code).toBe('INVALID_WINDOW');
  });

  it('answers 404 for an unknown user', async () => {
    const { app } = buildApp(ADMIN);
    expect((await app.inject({ url: '/admin/troubleshoot/users/nope/requests?reason=TER-1091' })).statusCode).toBe(404);
  });
});

describe('admin troubleshoot routes: audit', () => {
  it('writes every query to the security trail before reading, with the reason, endpoint and window', async () => {
    const { app, recorded, order, support } = buildApp(ADMIN);
    const r = await app.inject({ url: '/admin/troubleshoot/users/u1/requests?reason=TER-1091&from=2026-10-20T00:00:00Z&to=2026-10-20T12:00:00Z&route_prefix=/api/tabs' });
    expect(r.statusCode).toBe(200);
    expect(order).toEqual(['audit', 'read']);
    expect(recorded).toEqual([
      expect.objectContaining({
        actor_id: 'adm',
        actor_email: 'admin@x.dev',
        action: 'support.troubleshoot',
        target_type: 'user',
        target_id: 'u1',
        meta: { endpoint: 'requests', reason: 'TER-1091', via: 'api', from: '2026-10-20T00:00:00.000Z', to: '2026-10-20T12:00:00.000Z', route_prefix: '/api/tabs' },
      }),
    ]);
    expect(support.requests).toHaveBeenCalledWith('u1', { from: new Date('2026-10-20T00:00:00Z'), to: new Date('2026-10-20T12:00:00Z') }, '/api/tabs', 201);
  });

  it('defaults the window to the last 12 hours', async () => {
    const { app, recorded } = buildApp(ADMIN);
    await app.inject({ url: '/admin/troubleshoot/users/u1/errors?reason=TER-1091' });
    const meta = recorded[0]!.meta as { from: string; to: string };
    expect(Date.parse(meta.to) - Date.parse(meta.from)).toBe(12 * 3600_000);
  });

  it('audits every endpoint and the search (by the ids found, never the text searched)', async () => {
    const { app, recorded } = buildApp(ADMIN);
    for (const ep of ['requests', 'tabs', 'machines', 'errors', 'client']) {
      expect((await app.inject({ url: `/admin/troubleshoot/users/u1/${ep}?reason=TER-1091` })).statusCode).toBe(200);
    }
    expect((await app.inject({ url: '/admin/troubleshoot/users?q=humberto@x.dev&reason=TER-1091' })).statusCode).toBe(200);
    expect(recorded.map((e) => (e.meta as { endpoint: string }).endpoint)).toEqual(['requests', 'tabs', 'machines', 'errors', 'client', 'search']);
    expect(recorded[5]!.meta).toMatchObject({ found: ['u1'] });
    expect(JSON.stringify(recorded)).not.toContain('humberto@x.dev');
  });

  it('answers nothing when the trail cannot be written', async () => {
    const { app, support } = buildApp(ADMIN, { failAudit: true });
    const r = await app.inject({ url: '/admin/troubleshoot/users/u1/requests?reason=TER-1091' });
    expect(r.statusCode).toBe(500);
    expect(support.requests).not.toHaveBeenCalled();
  });
});

describe('admin troubleshoot routes: scope', () => {
  it('never answers e-mails, IPs or content, on any endpoint', async () => {
    const { app } = buildApp(ADMIN);
    const bodies = [];
    for (const ep of ['requests', 'tabs', 'machines', 'errors', 'client']) bodies.push((await app.inject({ url: `/admin/troubleshoot/users/u1/${ep}?reason=TER-1091` })).body);
    bodies.push((await app.inject({ url: '/admin/troubleshoot/users?q=hum&reason=TER-1091' })).body);
    for (const b of bodies) {
      expect(b).not.toMatch(FORBIDDEN_FIELDS);
      expect(b).not.toContain('@');
    }
    expect(JSON.parse(bodies[5]!)).toEqual({ endpoint: 'search', users: [{ user_id: 'u1', name: 'Humberto', created_at: '2026-10-01T00:00:00.000Z', last_login_at: null }] });
  });
});
