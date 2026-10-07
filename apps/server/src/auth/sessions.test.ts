import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Session, User } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { config } from '../config.js';
import { AuthService } from './service.js';
import { authRoutes } from './routes.js';
import { hashPassword, verifyPassword } from './password.js';
import { hashToken, SESSION_COOKIE } from './tokens.js';

const MIN = 60 * 1000;
const auth = config.auth as { sessionIdleMs: number | null };

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'u1', email: 'ana@example.com', name: 'Ana', avatar_url: null, password_hash: null, google_id: null, role: 'member', role_id: null,
    invited_at: null, last_login_at: null, review_enabled_until: null, review_enabled_by: null, created_at: '', ...overrides,
  } as User;
}

function session(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return { id: 's1', user_id: 'u1', token_hash: hashToken('tok-1'), expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_at: now, last_used_at: now, ip: '10.0.0.1', user_agent: 'Firefox', ...overrides };
}

function stubRepos(found?: { session: Session; user: User }) {
  const sessions = {
    create: vi.fn(async () => session()),
    findValidByTokenHash: vi.fn(async (h: string) => (found && found.session.token_hash === h ? found : undefined)),
    touch: vi.fn(async () => undefined),
    listForUser: vi.fn(async () => (found ? [found.session, session({ id: 's2', token_hash: 'other', ip: '10.0.0.2' })] : [])),
    deleteForUser: vi.fn(async (_u: string, id: string) => id === 's1' || id === 's2'),
    deleteAllForUser: vi.fn(async () => 1),
    deleteByTokenHash: vi.fn(async () => undefined),
  };
  const users = { setPassword: vi.fn(async () => undefined), touchLogin: vi.fn(async () => undefined) };
  const loginAttempts = { lockedFor: vi.fn(async () => 0), recordFailure: vi.fn(async () => 0), clear: vi.fn(async () => undefined) };
  return { sessions, users, loginAttempts, roles: { findById: vi.fn() } };
}

const asRepos = (r: ReturnType<typeof stubRepos>) => r as unknown as Repositories;

afterEach(() => {
  auth.sessionIdleMs = null;
});

describe('AuthService sessions', () => {
  it('records where a session was opened', async () => {
    const repos = stubRepos();
    await new AuthService(asRepos(repos), { send: vi.fn() } as never).createSession('u1', { ip: '1.2.3.4', user_agent: 'x'.repeat(600) });
    const [, , , origin] = repos.sessions.create.mock.calls[0] as unknown as [string, string, Date, { ip: string; user_agent: string }];
    expect(origin.ip).toBe('1.2.3.4');
    expect(origin.user_agent).toHaveLength(512);
  });

  it('looks sessions up with no idle cutoff by default, and with one when configured', async () => {
    const repos = stubRepos({ session: session(), user: user() });
    const service = new AuthService(asRepos(repos), { send: vi.fn() } as never);
    await service.resolveSession('tok-1');
    expect(repos.sessions.findValidByTokenHash).toHaveBeenLastCalledWith(hashToken('tok-1'), null);

    auth.sessionIdleMs = 30 * MIN;
    const before = Date.now();
    await service.resolveSession('tok-1');
    const cutoff = (repos.sessions.findValidByTokenHash.mock.calls.at(-1) as unknown as [string, Date])[1];
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * MIN);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 30 * MIN);
  });

  it('records a use at most once a minute', async () => {
    const fresh = stubRepos({ session: session(), user: user() });
    expect(await new AuthService(asRepos(fresh), { send: vi.fn() } as never).resolveSession('tok-1')).toMatchObject({ id: 'u1' });
    expect(fresh.sessions.touch).not.toHaveBeenCalled();

    const stale = stubRepos({ session: session({ last_used_at: new Date(Date.now() - 5 * MIN).toISOString() }), user: user() });
    await new AuthService(asRepos(stale), { send: vi.fn() } as never).resolveSession('tok-1');
    expect(stale.sessions.touch).toHaveBeenCalledWith('s1', expect.any(Date), expect.any(Date));
  });

  it('answers null for an unknown token without touching anything', async () => {
    const repos = stubRepos();
    expect(await new AuthService(asRepos(repos), { send: vi.fn() } as never).resolveSession('nope')).toBeNull();
    expect(repos.sessions.touch).not.toHaveBeenCalled();
  });
});

// argon2 hashes on purpose slowly (64 MiB, 3 passes): a test hashing twice needs more than 5 s on a busy runner.
describe('AuthService.changePassword', { timeout: 30_000 }, () => {
  const service = (repos: ReturnType<typeof stubRepos>) => new AuthService(asRepos(repos), { send: vi.fn() } as never);

  it('changes the password after confirming the current one, and ends the other sessions', async () => {
    const repos = stubRepos();
    const u = user({ password_hash: await hashPassword('old-secret') });
    const out = await service(repos).changePassword(u, session(), { current: 'old-secret', next: 'brand-new-pass' }, '1.1.1.1');
    expect(out).toEqual({ ok: true, revoked: 1 });
    const stored = (repos.users.setPassword.mock.calls[0] as unknown as [string, string])[1];
    expect(await verifyPassword(stored, 'brand-new-pass')).toBe(true);
    expect(repos.sessions.deleteAllForUser).toHaveBeenCalledWith('u1', 's1');
    expect(repos.loginAttempts.clear).toHaveBeenCalledWith('email:ana@example.com');
  });

  it('refuses a wrong current password and counts it against the login lock', async () => {
    const repos = stubRepos();
    const u = user({ password_hash: await hashPassword('old-secret') });
    expect(await service(repos).changePassword(u, session(), { current: 'guess', next: 'brand-new-pass' }, '1.1.1.1')).toEqual({ ok: false, reason: 'invalid' });
    expect(await service(repos).changePassword(u, session(), { current: null, next: 'brand-new-pass' }, '1.1.1.1')).toEqual({ ok: false, reason: 'invalid' });
    expect(repos.loginAttempts.recordFailure).toHaveBeenCalledWith('email:ana@example.com');
    expect(repos.users.setPassword).not.toHaveBeenCalled();
  });

  it('answers locked while the login lock holds', async () => {
    const repos = stubRepos();
    repos.loginAttempts.lockedFor.mockResolvedValue(60_000);
    const u = user({ password_hash: 'whatever' });
    expect(await service(repos).changePassword(u, session(), { current: 'x', next: 'brand-new-pass' }, '1.1.1.1')).toEqual({ ok: false, reason: 'locked', retryAfterMs: 60_000 });
  });

  it('refuses a short password or the e-mail itself', async () => {
    const repos = stubRepos();
    for (const next of ['1234567', 'ANA@example.com', 'x'.repeat(1025)]) {
      expect(await service(repos).changePassword(user(), session(), { current: null, next }, '1.1.1.1')).toEqual({ ok: false, reason: 'weak' });
    }
    expect(repos.users.setPassword).not.toHaveBeenCalled();
  });

  it('sets a first password only right after a sign-in', async () => {
    const repos = stubRepos();
    const old = session({ created_at: new Date(Date.now() - 11 * MIN).toISOString() });
    expect(await service(repos).changePassword(user(), old, { current: null, next: 'brand-new-pass' }, '1.1.1.1')).toEqual({ ok: false, reason: 'reauth' });
    expect(repos.users.setPassword).not.toHaveBeenCalled();
    expect(await service(repos).changePassword(user(), session(), { current: null, next: 'brand-new-pass' }, '1.1.1.1')).toEqual({ ok: true, revoked: 1 });
  });
});

describe('sessions routes', { timeout: 30_000 }, () => {
  let repos: ReturnType<typeof stubRepos>;

  function buildApp(signedIn = true) {
    const app = Fastify();
    void app.register(cookie);
    applyErrorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = signedIn ? user() : null;
    });
    const service = new AuthService(asRepos(repos), { send: vi.fn() } as never);
    app.register((a) => authRoutes(a, { repos: asRepos(repos), service }), { prefix: '/auth' });
    return app;
  }
  const withCookie = { cookies: { [SESSION_COOKIE]: 'tok-1' } };

  beforeEach(() => {
    repos = stubRepos({ session: session(), user: user() });
  });

  it('lists the sessions, marks the current one and never shows a token hash', async () => {
    const res = await buildApp().inject({ url: '/auth/sessions', ...withCookie });
    expect(res.statusCode).toBe(200);
    const { sessions } = res.json() as { sessions: Array<Record<string, unknown>> };
    expect(sessions.map((s) => [s.id, s.current, s.ip])).toEqual([
      ['s1', true, '10.0.0.1'],
      ['s2', false, '10.0.0.2'],
    ]);
    expect(sessions.every((s) => !('token_hash' in s))).toBe(true);
  });

  it('ends one session, 404 for one that is not the user’s', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/auth/sessions/s2', ...withCookie });
    expect(res.json()).toEqual({ ok: true, current: false });
    expect(repos.sessions.deleteForUser).toHaveBeenCalledWith('u1', 's2');
    expect((await app.inject({ method: 'DELETE', url: '/auth/sessions/zzz', ...withCookie })).statusCode).toBe(404);
  });

  it('clears the cookies when the current session is ended', async () => {
    const res = await buildApp().inject({ method: 'DELETE', url: '/auth/sessions/s1', ...withCookie });
    expect(res.json()).toEqual({ ok: true, current: true });
    expect(String(res.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
  });

  it('signs every other session out, keeping the current one', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/auth/sessions/revoke-others', ...withCookie });
    expect(res.json()).toEqual({ revoked: 1 });
    expect(repos.sessions.deleteAllForUser).toHaveBeenCalledWith('u1', 's1');
  });

  it('changes the password and maps refusals to codes', async () => {
    const app = buildApp();
    const ok = await app.inject({ method: 'POST', url: '/auth/me/password', payload: { new_password: 'brand-new-pass' }, ...withCookie });
    expect(ok.json()).toEqual({ ok: true, revoked: 1 });
    const weak = await app.inject({ method: 'POST', url: '/auth/me/password', payload: { new_password: 'short' }, ...withCookie });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('WEAK_PASSWORD');
    const noCookie = await app.inject({ method: 'POST', url: '/auth/me/password', payload: { new_password: 'brand-new-pass' } });
    expect(noCookie.statusCode).toBe(401);
  });

  it('needs a signed-in user', async () => {
    expect((await buildApp(false).inject({ url: '/auth/sessions' })).statusCode).toBe(401);
    expect((await buildApp(false).inject({ method: 'POST', url: '/auth/sessions/revoke-others' })).statusCode).toBe(401);
  });
});
