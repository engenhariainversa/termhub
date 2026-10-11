import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { AuthService } from '../auth/service.js';
import { buildAuthHook } from '../auth/middleware.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../auth/tokens.js';
import { AccountDeletionService } from '../account/deletion.js';
import type { DataExportService } from '../account/data-export.js';
import { HttpError, applyErrorHandler } from '../lib/errors.js';
import { accountRoutes } from './account.js';

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'u1', email: 'ana@gmail.com', name: 'Ana', avatar_url: null, nickname: null, city_short_url_partner: null, city_short_url_custom: null,
    password_hash: 'x', google_id: null, role: 'member', role_id: 'r-auth', invited_at: null, last_login_at: null, review_enabled_until: null,
    review_enabled_by: null, deletion_requested_at: null, deletion_scheduled_at: null, created_at: '', ...overrides,
  };
}

const PENDING = { deletion_requested_at: '2026-10-01T12:00:00.000Z', deletion_scheduled_at: '2026-10-31T12:00:00.000Z' };
const CSRF = 'csrf-token';

/**
 * The real auth hook (session cookie, CSRF, the pending-deletion gate) in front of the account
 * routes and one ordinary route, with the session, the re-authentication and the deletion faked.
 */
async function build(opts: { me?: User } = {}) {
  let me = opts.me ?? user();
  const auth = {
    resolveSession: vi.fn(async (token: string) => (token === 'session' ? me : null)),
    loginWithPassword: vi.fn(async (_email: string, password: string) => (password === 'right' ? { ok: true as const, user: me } : { ok: false as const, reason: 'invalid' as const })),
    verifyLoginCode: vi.fn(async (_email: string, code: string) => (code === '123456' ? { ok: true as const, user: me } : { ok: false as const, reason: 'invalid' as const })),
    sendLoginCode: vi.fn(async () => ({ ok: true as const })),
  };
  const deletion = {
    assertCanDelete: vi.fn(async () => {}),
    request: vi.fn(async (u: User) => (me = { ...u, ...PENDING })),
    cancel: vi.fn(async () => true),
    sendLink: vi.fn(async () => {}),
    confirmLink: vi.fn(async (token: string) => (token === 'a'.repeat(43) ? user(PENDING) : undefined)),
  };
  const exportFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'th-export-route-')), 'x1.zip');
  await writeFile(exportFile, 'PK-zip');
  const exports = {
    status: vi.fn(async () => ({ export: null, next_allowed_at: null })),
    request: vi.fn(async () => ({ export: { id: 'x1', status: 'pending' }, next_allowed_at: '2026-10-08T12:00:00.000Z' })),
    openDownload: vi.fn(async (u: User, id: string) => {
      if (u.id !== 'u1' || id !== 'x1') throw new HttpError(404, 'Este arquivo não está mais disponível. Peça uma nova exportação no Perfil.', 'EXPORT_NOT_FOUND');
      return { file: exportFile, bytes: 6, filename: 'termhub-2026-10-07.zip' };
    }),
  };
  const repos = { roles: { findById: async () => undefined, permissionsOf: async () => [] } } as unknown as Repositories;
  const app = Fastify();
  app.addHook('onClose', async () => rm(path.dirname(exportFile), { recursive: true, force: true }));
  applyErrorHandler(app);
  await app.register(fastifyCookie);
  app.decorateRequest('user', null);
  await app.register(
    async (api) => {
      api.addHook('preHandler', buildAuthHook({ service: auth as unknown as AuthService, repos }));
      await api.register((a) => accountRoutes(a, { auth: auth as unknown as AuthService, deletion: deletion as unknown as AccountDeletionService, exports: exports as unknown as DataExportService }), { prefix: '/account' });
      api.get('/machines', async () => ({ machines: [] }));
    },
    { prefix: '/api' },
  );
  await app.ready();
  return { app, auth, deletion, exports };
}

const signedIn = { cookie: `${SESSION_COOKIE}=session; ${CSRF_COOKIE}=${CSRF}`, [CSRF_HEADER]: CSRF };

describe('account deletion routes (signed in)', () => {
  let t: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    t = await build();
  });
  afterEach(async () => {
    await t.app.close();
  });

  it('GET /deletion says nothing is pending', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/account/deletion', headers: signedIn });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ pending: false, requested_at: null, scheduled_at: null });
  });

  it('a wrong password requests nothing', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/account/deletion', headers: signedIn, payload: { password: 'wrong' } });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('REAUTH_FAILED');
    expect(t.deletion.request).not.toHaveBeenCalled();
  });

  it('with the password: requests the deletion, answers the date and clears the session cookies', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/account/deletion', headers: signedIn, payload: { password: 'right' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ pending: true, requested_at: PENDING.deletion_requested_at, scheduled_at: PENDING.deletion_scheduled_at });
    expect(t.auth.loginWithPassword).toHaveBeenCalledWith('ana@gmail.com', 'right', expect.any(String));
    expect(t.deletion.request).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'web');
    const cookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
  });

  it('with an e-mailed code instead of a password', async () => {
    const sent = await t.app.inject({ method: 'POST', url: '/api/account/deletion/code', headers: signedIn });
    expect(sent.statusCode).toBe(200);
    expect(t.auth.sendLoginCode).toHaveBeenCalledWith('ana@gmail.com', expect.any(String), 'pt-BR');
    const r = await t.app.inject({ method: 'POST', url: '/api/account/deletion', headers: signedIn, payload: { code: '123456' } });
    expect(r.statusCode).toBe(200);
    expect(t.auth.verifyLoginCode).toHaveBeenCalledWith('ana@gmail.com', '123456', expect.any(String));
  });

  it('the last administrator is refused before the code is spent', async () => {
    t.deletion.assertCanDelete.mockRejectedValueOnce(new HttpError(409, 'único administrador', 'LAST_ADMIN'));
    const r = await t.app.inject({ method: 'POST', url: '/api/account/deletion', headers: signedIn, payload: { code: '123456' } });
    expect(r.statusCode).toBe(409);
    expect(t.auth.verifyLoginCode).not.toHaveBeenCalled();
    expect(t.deletion.request).not.toHaveBeenCalled();
  });

  it('needs the CSRF header like every other write', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/account/deletion', headers: { cookie: signedIn.cookie }, payload: { password: 'right' } });
    expect(r.statusCode).toBe(403);
    expect(t.deletion.request).not.toHaveBeenCalled();
  });
});

describe('a deactivated account (deletion pending)', () => {
  let t: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    t = await build({ me: user(PENDING) });
  });
  afterEach(async () => {
    await t.app.close();
  });

  it('is refused everywhere else with ACCOUNT_PENDING_DELETION', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/machines', headers: signedIn });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('ACCOUNT_PENDING_DELETION');
    const again = await t.app.inject({ method: 'POST', url: '/api/account/deletion', headers: signedIn, payload: { password: 'right' } });
    expect(again.statusCode).toBe(403);
  });

  it('still sees its status and can cancel', async () => {
    const status = await t.app.inject({ method: 'GET', url: '/api/account/deletion', headers: signedIn });
    expect(status.json()).toEqual({ pending: true, requested_at: PENDING.deletion_requested_at, scheduled_at: PENDING.deletion_scheduled_at });
    const r = await t.app.inject({ method: 'DELETE', url: '/api/account/deletion', headers: signedIn });
    expect(r.statusCode).toBe(200);
    expect(r.json().pending).toBe(false);
    expect(t.deletion.cancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }));
  });
});

describe('public page routes (TER-728)', () => {
  let t: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    t = await build();
  });
  afterEach(async () => {
    await t.app.close();
  });

  it('answers 202 for any address, without a session, and the honeypot sends nothing', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/account/deletion/link', remoteAddress: '10.0.0.1', payload: { email: 'Ana@Gmail.com' } });
    expect(r.statusCode).toBe(202);
    expect(t.deletion.sendLink).toHaveBeenCalledWith('ana@gmail.com');
    const bot = await t.app.inject({ method: 'POST', url: '/api/account/deletion/link', remoteAddress: '10.0.0.1', payload: { email: 'x@y.dev', website: 'spam' } });
    expect(bot.statusCode).toBe(400);
    expect(t.deletion.sendLink).toHaveBeenCalledTimes(1);
  });

  it('limits one address to a few requests per hour', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await t.app.inject({ method: 'POST', url: '/api/account/deletion/link', remoteAddress: '10.0.0.2', payload: { email: `a${i}@x.dev` } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('confirm: a good link requests the deletion; a bad one answers LINK_INVALID', async () => {
    const ok = await t.app.inject({ method: 'POST', url: '/api/account/deletion/confirm', remoteAddress: '10.0.0.3', payload: { token: 'a'.repeat(43) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ pending: true, requested_at: PENDING.deletion_requested_at, scheduled_at: PENDING.deletion_scheduled_at });
    const bad = await t.app.inject({ method: 'POST', url: '/api/account/deletion/confirm', remoteAddress: '10.0.0.3', payload: { token: 'b'.repeat(43) } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('LINK_INVALID');
  });
});

describe('data export routes (TER-741)', () => {
  let t: Awaited<ReturnType<typeof build>>;
  beforeEach(async () => {
    t = await build();
  });
  afterEach(async () => {
    await t.app.close();
  });

  it('GET /export reports the latest request of the signed-in account', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/account/export', headers: signedIn });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ export: null, next_allowed_at: null });
    expect(t.exports.status).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }));
  });

  it('POST /export files a request for the signed-in account (202)', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/account/export', headers: signedIn });
    expect(r.statusCode).toBe(202);
    expect(r.json().export).toEqual({ id: 'x1', status: 'pending' });
    expect(t.exports.request).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }));
  });

  it('the download streams the zip as an attachment', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/account/export/x1/download', headers: signedIn });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toBe('attachment; filename="termhub-2026-10-07.zip"');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.body).toBe('PK-zip');
  });

  it("another id is a 404, and a malformed one never reaches the service", async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/account/export/x2/download', headers: signedIn })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/account/export/..%2Fetc/download', headers: signedIn })).statusCode).toBe(400);
    expect(t.exports.openDownload).toHaveBeenCalledTimes(1);
  });

  it('needs a session', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/account/export/x1/download' });
    expect(r.statusCode).toBe(401);
    expect(t.exports.openDownload).not.toHaveBeenCalled();
  });
});
