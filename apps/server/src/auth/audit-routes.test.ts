import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { SecurityEventInput } from '../db/repositories/security-events.js';
import { applyErrorHandler } from '../lib/errors.js';
import { invalidatePermissionCache } from './permissions.js';
import { authRoutes } from './routes.js';
import type { LoginResult } from './service.js';

const admin = { id: 'u1', email: 'admin@x.dev', name: 'Admin', role_id: 'r-admin', locale: null };
const other = { id: 'u2', email: 'pessoa@x.dev', name: 'Pessoa', role_id: 'r-user', locale: null };

/** The auth routes over stubbed repos and service; `rows` collects what the security trail got. */
function buildApp(opts: { user?: typeof admin | null; viewAs?: 'self' | 'user'; login?: LoginResult } = {}) {
  invalidatePermissionCache();
  const rows: SecurityEventInput[] = [];
  const app = Fastify();
  app.register(fastifyCookie);
  applyErrorHandler(app);
  const user = opts.user === undefined ? admin : opts.user;
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    if (user) {
      request.scope = (opts.viewAs === 'user'
        ? { user, viewAs: { kind: 'user', user: other }, ownerId: other.id, createAs: other.id }
        : { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id }) as never;
    }
  });
  const repos = {
    users: { findById: vi.fn(async (id: string) => (id === other.id ? other : undefined)) },
    roles: {
      findById: vi.fn(async (id: string) => ({ id, name: id, label: id, is_admin: id === 'r-admin' })),
      permissionsOf: vi.fn(async () => []),
    },
    securityEvents: { record: vi.fn(async (e: SecurityEventInput) => void rows.push(e)) },
    viewAsAudit: { start: vi.fn(async () => {}), end: vi.fn(async () => {}) },
  } as unknown as Repositories;
  const service = {
    loginWithPassword: vi.fn(async () => opts.login ?? { ok: true, user: other }),
    createSession: vi.fn(async () => ({ token: 'tok', csrf: 'csrf', expiresAt: new Date(Date.now() + 60_000) })),
    destroySession: vi.fn(async () => {}),
  };
  app.register((a) => authRoutes(a, { repos, service } as never), { prefix: '/auth' });
  return { app, rows };
}

const login = (app: ReturnType<typeof buildApp>['app']) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'Pessoa@X.dev', password: 'secret-pass' } });

describe('security trail: sign-in', () => {
  it('records a successful sign-in as its own person, with the method and the IP', async () => {
    const { app, rows } = buildApp({ user: null });
    expect((await login(app)).statusCode).toBe(200);
    expect(rows).toEqual([expect.objectContaining({ action: 'auth.login', actor_id: 'u2', actor_email: 'pessoa@x.dev', view_as_id: null, ip: '127.0.0.1', meta: { method: 'password' } })]);
  });

  it('records a wrong password with the address tried, never the password', async () => {
    const { app, rows } = buildApp({ user: null, login: { ok: false, reason: 'invalid' } });
    expect((await login(app)).statusCode).toBe(401);
    expect(rows).toEqual([expect.objectContaining({ action: 'auth.login_failed', actor_id: null, target_type: 'email', target_label: 'pessoa@x.dev', meta: { method: 'password', reason: 'invalid' } })]);
    expect(JSON.stringify(rows)).not.toContain('secret-pass');
  });

  it('records the failure that set a lock, but not each refusal while locked', async () => {
    const first = buildApp({ user: null, login: { ok: false, reason: 'locked', retryAfterMs: 60_000, justLocked: true } });
    expect((await login(first.app)).statusCode).toBe(429);
    expect(first.rows.map((r) => r.meta)).toEqual([{ method: 'password', reason: 'locked' }]);

    const again = buildApp({ user: null, login: { ok: false, reason: 'locked', retryAfterMs: 50_000 } });
    expect((await login(again.app)).statusCode).toBe(429);
    expect(again.rows).toEqual([]);
  });

  it('a failed trail write never fails the sign-in', async () => {
    const app = Fastify();
    app.register(fastifyCookie);
    applyErrorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = null;
    });
    const service = {
      loginWithPassword: vi.fn(async () => ({ ok: true, user: other })),
      createSession: vi.fn(async () => ({ token: 'tok', csrf: 'csrf', expiresAt: new Date(Date.now() + 60_000) })),
    };
    const record = vi.fn(async () => {
      throw new Error('db down');
    });
    const repos = { roles: { findById: vi.fn(async () => undefined) }, securityEvents: { record } };
    app.register((a) => authRoutes(a, { repos, service } as never), { prefix: '/auth' });
    expect((await login(app)).statusCode).toBe(200);
    expect(record).toHaveBeenCalledOnce();
  });
});

describe('security trail: session and view-as', () => {
  it('records a sign-out', async () => {
    const { app, rows } = buildApp();
    expect((await app.inject({ method: 'POST', url: '/auth/logout', cookies: { termhub_session: 'tok' } })).statusCode).toBe(200);
    expect(rows.map((r) => [r.action, r.actor_id])).toEqual([['auth.logout', 'u1']]);
  });

  it('records an admin starting to view as someone, naming who', async () => {
    const { app, rows } = buildApp();
    expect((await app.inject({ method: 'POST', url: '/auth/view-as', payload: { user_id: 'u2' } })).statusCode).toBe(200);
    expect(rows).toEqual([expect.objectContaining({ action: 'auth.view_as', actor_id: 'u1', target_type: 'user', target_id: 'u2', target_label: 'pessoa@x.dev' })]);
  });

  it('records the end of a view-as, under the view-as it ends', async () => {
    const { app, rows } = buildApp({ viewAs: 'user' });
    expect((await app.inject({ method: 'POST', url: '/auth/view-as', payload: { user_id: null } })).statusCode).toBe(200);
    expect(rows).toEqual([expect.objectContaining({ action: 'auth.view_as_end', actor_id: 'u1', view_as_id: 'u2' })]);
  });

  it('records nothing when going back to yourself while already yourself', async () => {
    const { app, rows } = buildApp();
    expect((await app.inject({ method: 'POST', url: '/auth/view-as', payload: { user_id: null } })).statusCode).toBe(200);
    expect(rows).toEqual([]);
  });
});
