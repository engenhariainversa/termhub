import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canAccess } from '../auth/permissions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Device } from '../db/repositories/devices.js';
import { hashToken } from '../auth/tokens.js';
import { applyErrorHandler } from '../lib/errors.js';
import { buildMobileAuthHook } from './auth.js';
import { JtiCache } from './dpop.js';
import { MobileSocketRegistry, revokeDevice } from './revocation.js';
import { createMobileServices, registerMobileApi, type MobileDeps } from './app.js';

// registerMobileApi reads config.mobile, which is built from the env at import time.
vi.hoisted(() => {
  process.env.MOBILE_PUBLIC_URL = 'https://termhub.dev/';
});
vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn(async () => true) }));

const BASE = 'https://termhub.dev';
const TOKEN = 'thb_mob_' + 'A'.repeat(43);
const user = { id: 'u1', email: 'u@example.com', name: 'U' };
const nowSec = () => Math.floor(Date.now() / 1000);
const athOf = (token: string) => createHash('sha256').update(token).digest('base64url');
// registerMobileApi mounts /ws/m/chat on `upgrades` and gives it a child logger.
const log = { child: () => log, info: () => {}, warn: () => {} } as never;
/** The attachments plugin reads its deps when it registers; these tests never call its routes. */
const attachments = { service: {}, store: {}, queue: {}, quotaBytes: 0 } as never;

async function keypair() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  // `headerJwk` lets a test forge a proof: another key's signature under the stored key's jwk.
  const sign = (claims: Record<string, unknown>, headerJwk = jwk) =>
    new SignJWT({ iat: nowSec(), jti: randomUUID(), ...claims }).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: headerJwk }).sign(privateKey);
  return { jwk, sign };
}

type Key = Awaited<ReturnType<typeof keypair>>;

function deviceRow(jwk: object, status: 'active' | 'revoked' = 'active'): Device {
  return { id: 'd1', user_id: user.id, name: 'iPhone', platform: 'ios', model: 'x', os_version: '18', app_version: '1.0.0', public_key: JSON.stringify(jwk), key_thumbprint: 't', pin_failures: 0, pin_locked_until: null, status, revoked_at: null, revoked_reason: null, push_token: null, last_seen_at: null, last_ip: null, request_id: null, created_at: '' };
}

function fakeRepos(device: Device) {
  return {
    users: { findById: vi.fn(async (id: string) => (id === user.id ? user : undefined)) },
    deviceSessions: {
      findValidToken: vi.fn(async (hash: string) => (hash === hashToken(TOKEN) && device.status === 'active' ? { device } : undefined)),
      findTokenAny: vi.fn(async (hash: string) => (hash === hashToken(TOKEN) ? { device_id: device.id } : undefined)),
    },
    devices: {
      findById: vi.fn(async (id: string) => (id === device.id ? device : undefined)),
      touchSeen: vi.fn(async () => undefined),
    },
  };
}

async function buildTestApp(repos: ReturnType<typeof fakeRepos>, minAppVersion: string | null = null) {
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('user', null);
  app.addHook('preHandler', buildMobileAuthHook({ repos: repos as unknown as Repositories, publicUrl: BASE, minAppVersion, jtis: new JtiCache() }));
  app.get('/api/m/v1/open', { config: { mobileAuth: 'none' } }, async () => ({ ok: true }));
  app.get('/api/m/v1/me', async (req) => ({ user: req.user?.id, scope: req.scope, device: req.mobile && 'device' in req.mobile ? req.mobile.device.id : null }));
  app.get('/api/m/v1/chat', { config: { resource: 'chat', action: 'read' } }, async () => ({ ok: true }));
  app.post('/api/m/v1/enrol', { config: { mobileAuth: 'proof' } }, async (req) => ({ thumb: req.mobile && 'jwkThumbprint' in req.mobile ? req.mobile.jwkThumbprint : null }));
  await app.ready();
  return app;
}

describe('buildMobileAuthHook', () => {
  let key: Key;
  let repos: ReturnType<typeof fakeRepos>;
  let app: FastifyInstance;
  const proofFor = (path: string, method = 'GET', extra: Record<string, unknown> = { ath: athOf(TOKEN) }, k = key) =>
    k.sign({ htm: method, htu: `${BASE}${path}`, ...extra });
  const deviceHeaders = async (path: string, k = key) => ({ authorization: `Bearer ${TOKEN}`, dpop: await proofFor(path, 'GET', { ath: athOf(TOKEN) }, k) });

  beforeEach(async () => {
    key = await keypair();
    repos = fakeRepos(deviceRow(key.jwk));
    app = await buildTestApp(repos);
  });
  afterEach(async () => {
    await app.close();
    vi.mocked(canAccess).mockClear();
  });

  it("answers a 'none' route without any header", async () => {
    const r = await app.inject({ method: 'GET', url: '/api/m/v1/open' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("authenticates a 'device' route with the token and a bound proof, scoped to self", async () => {
    const r = await app.inject({ method: 'GET', url: '/api/m/v1/me?x=1', headers: await deviceHeaders('/api/m/v1/me') });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user).toBe(user.id);
    expect(body.device).toBe('d1');
    expect(body.scope.ownerId).toBe(user.id);
    expect(body.scope.createAs).toBe(user.id);
    expect(body.scope.viewAs).toEqual({ kind: 'self' });
    expect(repos.devices.touchSeen).toHaveBeenCalledWith('d1', expect.any(String), expect.any(Date));
  });

  it('never reads a session cookie, and refuses a personal API token before touching the database', async () => {
    const cookie = await app.inject({ method: 'GET', url: '/api/m/v1/me', headers: { cookie: 'termhub_session=abc' } });
    expect(cookie.statusCode).toBe(401);
    expect(cookie.json().code).toBe('UNAUTHORIZED');
    const pat = await app.inject({ method: 'GET', url: '/api/m/v1/me', headers: { authorization: `Bearer thb_pat_${'A'.repeat(43)}`, dpop: await proofFor('/api/m/v1/me') } });
    expect(pat.statusCode).toBe(401);
    expect(pat.json().code).toBe('UNAUTHORIZED');
    expect(repos.deviceSessions.findValidToken).not.toHaveBeenCalled();
  });

  it('rejects a proof by another key, a replayed jti and a proof for another path', async () => {
    const other = await keypair();
    const forgedProof = await other.sign({ htm: 'GET', htu: `${BASE}/api/m/v1/me`, ath: athOf(TOKEN) }, key.jwk);
    const forged = await app.inject({ method: 'GET', url: '/api/m/v1/me', headers: { authorization: `Bearer ${TOKEN}`, dpop: forgedProof } });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().code).toBe('PROOF_INVALID');
    const otherKey = await app.inject({ method: 'GET', url: '/api/m/v1/me', headers: await deviceHeaders('/api/m/v1/me', other) });
    expect(otherKey.statusCode).toBe(401);
    expect(otherKey.json().code).toBe('PROOF_KEY_MISMATCH');

    const headers = await deviceHeaders('/api/m/v1/me');
    expect((await app.inject({ method: 'GET', url: '/api/m/v1/me', headers })).statusCode).toBe(200);
    const replay = await app.inject({ method: 'GET', url: '/api/m/v1/me', headers });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('PROOF_REPLAYED');

    const wrongPath = await app.inject({ method: 'GET', url: '/api/m/v1/me', headers: await deviceHeaders('/api/m/v1/chat') });
    expect(wrongPath.statusCode).toBe(401);
    expect(wrongPath.json().code).toBe('PROOF_URL');
  });

  it('does not burn the jti of a proof whose signature failed', async () => {
    const jtis = new JtiCache();
    const claim = vi.spyOn(jtis, 'claim');
    const a = Fastify();
    applyErrorHandler(a);
    a.decorateRequest('user', null);
    a.addHook('preHandler', buildMobileAuthHook({ repos: repos as unknown as Repositories, publicUrl: BASE, minAppVersion: null, jtis }));
    a.get('/api/m/v1/me', async () => ({ ok: true }));
    const other = await keypair();
    const r = await a.inject({ method: 'GET', url: '/api/m/v1/me', headers: await deviceHeaders('/api/m/v1/me', other) });
    expect(r.statusCode).toBe(401);
    expect(claim).not.toHaveBeenCalled();
    await a.close();
  });

  it('answers DEVICE_REVOKED for a token of a revoked device, TOKEN_EXPIRED for an expired or unknown one', async () => {
    const revoked = fakeRepos(deviceRow(key.jwk, 'revoked'));
    const a = await buildTestApp(revoked);
    const r = await a.inject({ method: 'GET', url: '/api/m/v1/me', headers: await deviceHeaders('/api/m/v1/me') });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'Este aparelho foi removido da conta', code: 'DEVICE_REVOKED' });
    await a.close();

    // Expired: the row is still there (findTokenAny sees it), but findValidToken no longer answers.
    const expired = fakeRepos(deviceRow(key.jwk));
    expired.deviceSessions.findValidToken.mockResolvedValue(undefined);
    const e = await buildTestApp(expired);
    const x = await e.inject({ method: 'GET', url: '/api/m/v1/me', headers: await deviceHeaders('/api/m/v1/me') });
    expect(x.statusCode).toBe(401);
    expect(x.json()).toEqual({ error: 'Sessão expirada.', code: 'TOKEN_EXPIRED' });
    await e.close();

    const unknown = `thb_mob_${'B'.repeat(43)}`;
    const u = await app.inject({ method: 'GET', url: '/api/m/v1/me', headers: { authorization: `Bearer ${unknown}`, dpop: await proofFor('/api/m/v1/me', 'GET', { ath: athOf(unknown) }) } });
    expect(u.statusCode).toBe(401);
    expect(u.json().code).toBe('TOKEN_EXPIRED');
  });

  it('a device revoked through revokeDevice answers DEVICE_REVOKED on its next call, not TOKEN_EXPIRED', async () => {
    // A tiny in-memory store: findValidToken refuses an inactive device, findTokenAny still sees the row.
    const dev = deviceRow(key.jwk);
    const tokens = new Map([[hashToken(TOKEN), 'd1']]);
    const store = {
      users: { findById: vi.fn(async (id: string) => (id === user.id ? { ...user } : undefined)) },
      deviceSessions: {
        findValidToken: vi.fn(async (hash: string) => (tokens.get(hash) === dev.id && dev.status === 'active' ? { device: dev } : undefined)),
        findTokenAny: vi.fn(async (hash: string) => (tokens.has(hash) ? { device_id: tokens.get(hash)! } : undefined)),
        deleteTokensForDevice: vi.fn(async (id: string) => {
          for (const [h, d] of tokens) if (d === id) tokens.delete(h);
          return 1;
        }),
      },
      devices: {
        findById: vi.fn(async (id: string) => (id === dev.id ? dev : undefined)),
        touchSeen: vi.fn(async () => undefined),
        revoke: vi.fn(async () => {
          if (dev.status !== 'active') return undefined;
          dev.status = 'revoked';
          return dev;
        }),
        setPushToken: vi.fn(async () => undefined),
      },
      deviceEvents: { record: vi.fn(async () => undefined) },
    };
    const a = await buildTestApp(store as unknown as ReturnType<typeof fakeRepos>);
    const before = await a.inject({ method: 'GET', url: '/api/m/v1/me', headers: await deviceHeaders('/api/m/v1/me') });
    expect(before.statusCode).toBe(200);

    await revokeDevice({ repos: store as unknown as Repositories, sockets: new MobileSocketRegistry(), mailer: { send: vi.fn(async () => undefined) } }, 'd1', { reason: 'user', actor: 'user' });

    const after = await a.inject({ method: 'GET', url: '/api/m/v1/me', headers: await deviceHeaders('/api/m/v1/me') });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: 'Este aparelho foi removido da conta', code: 'DEVICE_REVOKED' });
    expect(store.deviceSessions.findValidToken).toHaveBeenCalled();
    await a.close();
  });

  it("checks the route's resource grant", async () => {
    vi.mocked(canAccess).mockResolvedValueOnce(false);
    const r = await app.inject({ method: 'GET', url: '/api/m/v1/chat', headers: await deviceHeaders('/api/m/v1/chat') });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('Sem permissão: chat:read');
    expect(vi.mocked(canAccess)).toHaveBeenCalledWith(expect.anything(), user, 'chat', 'read');
  });

  it('refuses an app older than the minimum with 426, tolerates no header, rejects a malformed one', async () => {
    const a = await buildTestApp(repos, '1.0.0');
    const old = await a.inject({ method: 'GET', url: '/api/m/v1/open', headers: { 'x-termhub-app': 'ios/0.9.0+1' } });
    expect(old.statusCode).toBe(426);
    expect(old.json()).toEqual({ error: 'Atualize o app do termhub para continuar', code: 'APP_TOO_OLD' });
    // 426 precedes auth: a device route with no credentials still answers 426.
    expect((await a.inject({ method: 'GET', url: '/api/m/v1/me', headers: { 'x-termhub-app': 'ios/0.9.0+1' } })).statusCode).toBe(426);
    expect((await a.inject({ method: 'GET', url: '/api/m/v1/open' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/m/v1/open', headers: { 'x-termhub-app': 'ios/1.0.0+7' } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/m/v1/open', headers: { 'x-termhub-app': 'garbage' } })).statusCode).toBe(400);
    await a.close();
  });

  it("'proof' mode accepts a proof without a token and exposes its key thumbprint", async () => {
    const r = await app.inject({ method: 'POST', url: '/api/m/v1/enrol', headers: { dpop: await proofFor('/api/m/v1/enrol', 'POST', {}) } });
    expect(r.statusCode).toBe(200);
    expect(r.json().thumb).toBe(await calculateJwkThumbprint(key.jwk, 'sha256'));
    const withAth = await app.inject({ method: 'POST', url: '/api/m/v1/enrol', headers: { dpop: await proofFor('/api/m/v1/enrol', 'POST') } });
    expect(withAth.statusCode).toBe(200);
    const none = await app.inject({ method: 'POST', url: '/api/m/v1/enrol' });
    expect(none.statusCode).toBe(401);
  });
});

describe('registerMobileApi', () => {
  it('serves /health unauthenticated, guards guardedMobile routes with the device hook, and 404s in its own shape', async () => {
    const key = await keypair();
    const repos = fakeRepos(deviceRow(key.jwk));
    const deps = { repos: repos as unknown as Repositories, upgrades: { addPublic: vi.fn() } as never, log, attachments } as MobileDeps;
    const app = Fastify();
    applyErrorHandler(app);
    app.decorateRequest('user', null);
    await registerMobileApi(app, createMobileServices(deps), deps, async (guardedMobile) => {
      await guardedMobile('chat', async (a) => { a.get('/ping', async () => ({ pong: true })); }, '/chat');
    });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/m/v1/health' })).json()).toEqual({ ok: true });
    const anon = await app.inject({ method: 'GET', url: '/api/m/v1/chat/ping' });
    expect(anon.statusCode).toBe(401);
    const dpop = await key.sign({ htm: 'GET', htu: `${BASE}/api/m/v1/chat/ping`, ath: athOf(TOKEN) });
    vi.mocked(canAccess).mockResolvedValueOnce(false);
    const guarded = await app.inject({ method: 'GET', url: '/api/m/v1/chat/ping', headers: { authorization: `Bearer ${TOKEN}`, dpop } });
    expect(guarded.statusCode).toBe(403);
    expect(guarded.json().error).toBe('Sem permissão: chat:read');
    const dpop2 = await key.sign({ htm: 'GET', htu: `${BASE}/api/m/v1/chat/ping`, ath: athOf(TOKEN) });
    const ok = await app.inject({ method: 'GET', url: '/api/m/v1/chat/ping', headers: { authorization: `Bearer ${TOKEN}`, dpop: dpop2 } });
    expect(ok.json()).toEqual({ pong: true });
    // Like /api, an unknown path is behind the auth hook: anonymous callers learn nothing about the route map.
    expect((await app.inject({ method: 'GET', url: '/api/m/v1/nope' })).statusCode).toBe(401);
    const dpop3 = await key.sign({ htm: 'GET', htu: `${BASE}/api/m/v1/nope`, ath: athOf(TOKEN) });
    const nf = await app.inject({ method: 'GET', url: '/api/m/v1/nope', headers: { authorization: `Bearer ${TOKEN}`, dpop: dpop3 } });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: 'Rota não encontrada', code: 'NOT_FOUND' });
    await app.close();
  });

  it('mounts /session/challenge and /session/token without the device-token hook (mobileAuth none)', async () => {
    const key = await keypair();
    const device = deviceRow(key.jwk);
    const repos = fakeRepos(device);
    const findActiveById = vi.fn(async (id: string) => (id === device.id ? device : undefined));
    const deps = { repos: { ...repos, devices: { ...repos.devices, findActiveById } } as unknown as Repositories, upgrades: { addPublic: vi.fn() } as never, log, attachments } as MobileDeps;
    const app = Fastify();
    applyErrorHandler(app);
    app.decorateRequest('user', null);
    await registerMobileApi(app, createMobileServices(deps), deps);
    await app.ready();
    const unknown = await app.inject({ method: 'POST', url: '/api/m/v1/session/challenge', payload: { device_id: 'nope' } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('DEVICE_NOT_FOUND');
    // No bearer: the route itself answers, checking the proof against the stored key.
    const forged = await app.inject({ method: 'POST', url: '/api/m/v1/session/token', headers: { dpop: 'garbage' }, payload: { device_id: 'd1', challenge: 'c', pin_proof: 'p' } });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().code).toBe('PROOF_INVALID');
    await app.close();
  });
});
