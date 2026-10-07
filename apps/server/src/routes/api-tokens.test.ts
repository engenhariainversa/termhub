import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import { applyErrorHandler } from '../lib/errors.js';
import { apiTokenRoutes } from './api-tokens.js';

const token = (over: Partial<ApiToken> & { id: string }): ApiToken => ({
  user_id: 'u1',
  name: over.id,
  scopes: ['read'],
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_at: '2026-09-19T00:00:00.000Z',
  gated: false,
  ...over,
});

/** Routes over a stubbed repository. `viewAs` simulates an admin viewing as another user. */
function buildApp(opts: { active?: number; viewAs?: string } = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    const owner = opts.viewAs ?? 'u1';
    request.user = { id: 'u1' } as never;
    request.scope = { user: { id: 'u1' } as never, viewAs: opts.viewAs ? { kind: 'user', user: { id: owner } as never } : { kind: 'self' }, ownerId: owner, createAs: owner };
  });
  const apiTokens = {
    listByUser: vi.fn(async (userId: string) => [token({ id: 't1', user_id: userId })]),
    countActive: vi.fn(async () => opts.active ?? 0),
    create: vi.fn(async (userId: string, input: { name: string; scopes: ApiToken['scopes']; expiresAt: Date | null; gated?: boolean }, hash: string) => {
      void hash;
      // Mirrors the real repository's own default (api-tokens.ts: `input.gated ?? false`): this
      // route never passes `gated` itself, so a Settings token comes out ungated.
      return token({ id: 'new', user_id: userId, name: input.name, scopes: input.scopes, expires_at: input.expiresAt?.toISOString() ?? null, gated: input.gated ?? false });
    }),
    revoke: vi.fn(async (id: string, userId: string) => (id === 't1' && userId === 'u1' ? token({ id, revoked_at: '2026-09-19T01:00:00.000Z' }) : undefined)),
    listEvents: vi.fn(async (id: string, userId: string) => (id === 't1' && userId === 'u1' ? [{ id: 'e1', tool: 'read_screen', ok: true }] : undefined)),
  };
  const securityEvents = { record: vi.fn(async () => {}) };
  app.register((a) => apiTokenRoutes(a, { apiTokens, securityEvents } as unknown as Repositories, { mcpUrl: 'https://termhub.dev/mcp' }), { prefix: '/api-tokens' });
  return { app, apiTokens, securityEvents };
}

describe('api token routes', () => {
  it('creates a token: returns the plain token once, stores only its hash', async () => {
    const { app, apiTokens } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: '  laptop  ', scopes: ['terminals', 'read', 'read'], expires_in_days: 90 } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.token).toMatch(/^thb_pat_[A-Za-z0-9_-]{43}$/);
    expect(body.mcp_url).toBe('https://termhub.dev/mcp');
    expect(body.api_token).toMatchObject({ name: 'laptop', scopes: ['read', 'terminals'] });
    expect(JSON.stringify(body.api_token)).not.toContain(body.token);

    const [userId, input, hash] = apiTokens.create.mock.calls[0];
    expect(userId).toBe('u1');
    expect(input.scopes).toEqual(['read', 'terminals']);
    expect(input.expiresAt.getTime() - Date.now()).toBeGreaterThan(89.9 * 24 * 3600 * 1000);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(body.token);
  });

  it('creates a token through Settings ungated: only the concierge\'s own mint ever sets the gate flag', async () => {
    const { app, apiTokens } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: 'meu notebook', scopes: ['read', 'terminals'] } });
    expect(r.statusCode).toBe(201);
    expect(r.json().api_token.gated).toBe(false);
    expect(apiTokens.create.mock.calls[0][1]).not.toHaveProperty('gated');
  });

  it('creates a token without expiry', async () => {
    const { app, apiTokens } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: 'ci', scopes: ['read'] } });
    expect(r.statusCode).toBe(201);
    expect(apiTokens.create.mock.calls[0][1].expiresAt).toBeNull();
  });

  it('accepts the memory scope (spec 2026-09-26 concierge memory D14)', async () => {
    const { app, apiTokens } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: 'memoria', scopes: ['memory'] } });
    expect(r.statusCode).toBe(201);
    expect(apiTokens.create.mock.calls[0][1].scopes).toEqual(['memory']);
  });

  it.each([
    ['no scopes', { name: 'a', scopes: [] }],
    ['an unknown scope', { name: 'a', scopes: ['read', 'admin'] }],
    ['a blank name', { name: '   ', scopes: ['read'] }],
    ['a name over 80 chars', { name: 'x'.repeat(81), scopes: ['read'] }],
    ['expiry 0 days', { name: 'a', scopes: ['read'], expires_in_days: 0 }],
    ['expiry 366 days', { name: 'a', scopes: ['read'], expires_in_days: 366 }],
    ['a fractional expiry', { name: 'a', scopes: ['read'], expires_in_days: 1.5 }],
  ])('rejects %s with 400 and creates nothing', async (_n, payload) => {
    const { app, apiTokens } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload });
    expect(r.statusCode).toBe(400);
    expect(apiTokens.create).not.toHaveBeenCalled();
  });

  it('refuses a 21st active token with 409', async () => {
    const { app, apiTokens } = buildApp({ active: 20 });
    const r = await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: 'a', scopes: ['read'] } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('Limite de 20 tokens ativos: revogue um antes de criar outro');
    expect(apiTokens.create).not.toHaveBeenCalled();
  });

  it('lists the caller\'s tokens and never a hash', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/api-tokens' });
    expect(r.statusCode).toBe(200);
    expect(r.json().tokens).toHaveLength(1);
    expect(r.body).not.toMatch(/hash/i);
  });

  it('an admin viewing as another user still manages only their own tokens', async () => {
    const { app, apiTokens } = buildApp({ viewAs: 'u2' });
    await app.inject({ method: 'GET', url: '/api-tokens' });
    expect(apiTokens.listByUser).toHaveBeenCalledWith('u1');
    await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: 'a', scopes: ['read'] } });
    expect(apiTokens.countActive).toHaveBeenCalledWith('u1');
    expect(apiTokens.create.mock.calls[0][0]).toBe('u1');
    await app.inject({ method: 'DELETE', url: '/api-tokens/t1' });
    expect(apiTokens.revoke).toHaveBeenCalledWith('t1', 'u1');
  });

  it('revokes the caller\'s token and 404s anyone else\'s', async () => {
    const { app } = buildApp();
    const ok = await app.inject({ method: 'DELETE', url: '/api-tokens/t1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().api_token.revoked_at).not.toBeNull();
    const nope = await app.inject({ method: 'DELETE', url: '/api-tokens/t9' });
    expect(nope.statusCode).toBe(404);
    expect(nope.json().error).toBe('Token não encontrado');
  });

  it('puts creating and revoking a token on the security trail, never the token itself', async () => {
    const { app, securityEvents } = buildApp();
    const created = await app.inject({ method: 'POST', url: '/api-tokens', payload: { name: 'laptop', scopes: ['read'] } });
    await app.inject({ method: 'DELETE', url: '/api-tokens/t1' });
    const calls = securityEvents.record.mock.calls.map((c) => (c as unknown[])[0] as { action: string; target_id: string });
    expect(calls.map((c) => [c.action, c.target_id])).toEqual([
      ['api_token.create', 'new'],
      ['api_token.revoke', 't1'],
    ]);
    expect(JSON.stringify(calls)).not.toContain(created.json().token);
  });

  it('lists the MCP calls of the caller\'s own token, and 404s anyone else\'s', async () => {
    const { app, apiTokens } = buildApp({ viewAs: 'u2' });
    const ok = await app.inject({ url: '/api-tokens/t1/events?limit=20' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ events: [{ id: 'e1', tool: 'read_screen', ok: true }], retention_days: 30 });
    // the signed-in user's, never the viewed-as person's
    expect(apiTokens.listEvents).toHaveBeenCalledWith('t1', 'u1', 20);
    expect((await app.inject({ url: '/api-tokens/t9/events' })).statusCode).toBe(404);
  });
});
