import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { integrationRoutes } from './integrations.js';

/** Each name resolves to what this table says; anything else does not resolve. */
const dns = vi.hoisted(() => {
  const table: Record<string, string[]> = {
    'acme.atlassian.net': ['104.192.141.1'],
    'jira.evil.example': ['172.18.0.3'], // a public-looking name pointing into the compose network
    'mixed.evil.example': ['104.192.141.2', '10.0.0.7'],
    'metadata.evil.example': ['169.254.169.254'],
    'v6.evil.example': ['::1'],
  };
  const lookup = vi.fn(async (host: string) => {
    const addrs = table[host];
    if (!addrs) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
  return { lookup };
});
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));
vi.mock('../lib/crypto.js', () => ({ encryptionAvailable: () => true }));

const saved = { id: 'j1', provider: 'jira', name: 'Jira', config: { baseUrl: 'https://acme.atlassian.net', email: 'a@b' }, owner_id: 'u1', created_at: '2026-10-07T00:00:00.000Z' };

function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'u1' } as never;
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' } as never;
  });
  const integrations = {
    list: vi.fn(async () => [saved]),
    findById: vi.fn(async (id: string) => (id === 'j1' ? saved : undefined)),
    getSecret: vi.fn(async () => 'token'),
    create: vi.fn(async (input: Record<string, unknown>) => ({ ...saved, ...input, id: 'new' })),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ ...saved, ...patch, id })),
    delete: vi.fn(async () => true),
  };
  app.register((a) => integrationRoutes(a, { integrations } as unknown as Repositories), { prefix: '/integrations' });
  return { app, integrations };
}

const jira = (baseUrl: string) => ({ provider: 'jira', name: 'Jira', config: { baseUrl, email: 'a@b' }, secret: 'token' });

/** The base URLs the server must refuse, and a piece of the reason it gives. */
const REFUSED: [string, string][] = [
  ['http://acme.atlassian.net', 'https'],
  ['https://user:pw@acme.atlassian.net', 'usuário'],
  ['https://jira', 'domínio completo'],
  ['https://localhost', 'domínio completo'],
  ['https://db.internal', 'domínio completo'],
  ['https://127.0.0.1', 'rede interna'],
  ['https://[::1]', 'rede interna'],
  ['https://10.0.0.5', 'rede interna'],
  ['https://169.254.169.254', 'rede interna'],
  ['https://jira.evil.example', 'rede interna'],
  ['https://mixed.evil.example', 'rede interna'],
  ['https://metadata.evil.example', 'rede interna'],
  ['https://v6.evil.example', 'rede interna'],
  ['https://nowhere.evil.example', 'resolver'],
];

afterEach(() => vi.unstubAllGlobals());

describe('integration routes: Jira base URL (TER-578)', () => {
  it.each(REFUSED)('create refuses %s', async (baseUrl, reason) => {
    const { app, integrations } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/integrations', payload: jira(baseUrl) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain(reason);
    expect(integrations.create).not.toHaveBeenCalled();
  });

  it('create accepts a public https site', async () => {
    const { app, integrations } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/integrations', payload: jira('https://acme.atlassian.net') });
    expect(r.statusCode).toBe(201);
    expect(integrations.create).toHaveBeenCalledOnce();
  });

  it('other providers do not take a base URL and are not checked', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/integrations', payload: { provider: 'linear', name: 'L', config: {}, secret: 'k' } });
    expect(r.statusCode).toBe(201);
  });

  it.each(REFUSED)('patch refuses %s', async (baseUrl, reason) => {
    const { app, integrations } = buildApp();
    const r = await app.inject({ method: 'PATCH', url: '/integrations/j1', payload: { config: { baseUrl, email: 'a@b' } } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain(reason);
    expect(integrations.update).not.toHaveBeenCalled();
  });

  it('patch without config keeps working', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'PATCH', url: '/integrations/j1', payload: { name: 'Outro' } });
    expect(r.statusCode).toBe(200);
  });

  it.each(REFUSED)('test refuses %s without calling it', async (baseUrl, reason) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { app } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/integrations/test', payload: { provider: 'jira', config: { baseUrl, email: 'a@b' }, secret: 'token' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('test of a saved integration checks the merged base URL', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { app } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/integrations/test', payload: { provider: 'jira', config: { baseUrl: 'https://jira.evil.example' }, integration_id: 'j1' } });
    expect(r.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('test does not follow a redirect off the site', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'http://termhub-db-1:5432/' } }));
    vi.stubGlobal('fetch', fetch);
    const { app } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/integrations/test', payload: { provider: 'jira', config: saved.config, secret: 'token' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: false });
    expect(r.json().error).toContain('recusado');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('test does not echo the answer body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"internal":"s3cret"}', { status: 403 })));
    const { app } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/integrations/test', payload: { provider: 'jira', config: saved.config, secret: 'token' } });
    expect(r.json()).toEqual({ ok: false, error: 'Jira 403' });
  });

  it('test of a public site goes through', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ displayName: 'Ana' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ values: [{ key: 'P', name: 'Proj' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { app } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/integrations/test', payload: { provider: 'jira', config: saved.config, secret: 'token' } });
    expect(r.json()).toMatchObject({ ok: true, account: 'Ana' });
    expect(fetch.mock.calls[0][0]).toBe('https://acme.atlassian.net/rest/api/3/myself');
  });
});
