import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { WhatsappSettings } from '../db/repositories/whatsapp-settings.js';
import { applyErrorHandler } from '../lib/errors.js';
import { whatsappRoutes } from './whatsapp.js';

const dns = vi.hoisted(() => ({
  lookup: vi.fn(async (host: string) => {
    const table: Record<string, string> = { 'wpp.example.com': '104.21.1.1', 'other.example.com': '104.21.1.2', 'evil.example.com': '10.0.0.7' };
    if (!table[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return [{ address: table[host], family: 4 }];
  }),
}));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));
vi.mock('../lib/crypto.js', () => ({ encryptionAvailable: () => true }));

const row: WhatsappSettings = {
  user_id: 'u1',
  server_url: 'https://wpp.example.com',
  instance: 'termhub',
  number: '5562999998888',
  enabled: true,
  notify_needs_you: true,
  notify_done: true,
  last_sent_at: null,
  last_error: null,
  last_error_at: null,
  updated_at: '2026-11-23T00:00:00.000Z',
};

function buildApp(opts: { flag?: boolean; saved?: WhatsappSettings | null } = {}) {
  let saved = opts.saved === undefined ? row : opts.saved;
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'u1' } as never;
    // An admin viewing as someone else still edits only their own setup.
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'user', user: { id: 'u2' } }, ownerId: 'u2', createAs: 'u2' } as never;
  });
  const whatsapp = {
    get: vi.fn(async (_userId: string) => saved),
    apiKey: vi.fn(async () => (saved ? 'stored-key' : null)),
    save: vi.fn(async (userId: string, input: Record<string, unknown>) => {
      saved = { ...row, ...input, user_id: userId } as WhatsappSettings;
      return saved;
    }),
    delete: vi.fn(async () => saved !== null),
    noteDelivery: vi.fn(async () => undefined),
  };
  const repos = {
    whatsapp,
    featureFlags: { overrideFor: vi.fn(async () => opts.flag ?? true), instanceValue: vi.fn(async () => null) },
    securityEvents: { record: vi.fn(async () => undefined) },
  } as unknown as Repositories;
  app.register((a) => whatsappRoutes(a, repos), { prefix: '/whatsapp' });
  return { app, whatsapp };
}

const body = { server_url: 'https://wpp.example.com/', instance: 'termhub', number: '+55 62 99999-8888', enabled: true, notify_needs_you: true, notify_done: false };

afterEach(() => vi.unstubAllGlobals());

describe('whatsapp routes', () => {
  it('do not exist while the flag is off', async () => {
    const { app } = buildApp({ flag: false });
    expect((await app.inject({ method: 'GET', url: '/whatsapp' })).statusCode).toBe(404);
  });

  it('never return the API key', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/whatsapp' });
    expect(res.json().whatsapp).toMatchObject({ configured: true, has_api_key: true, number: '5562999998888' });
    expect(res.body).not.toContain('stored-key');
  });

  it("saves the signed-in person's own setup, normalised, and keeps the key when none is typed", async () => {
    const { app, whatsapp } = buildApp();
    const res = await app.inject({ method: 'PUT', url: '/whatsapp', payload: body });
    expect(res.statusCode).toBe(200);
    expect(whatsapp.save).toHaveBeenCalledWith('u1', expect.objectContaining({ server_url: 'https://wpp.example.com', number: '5562999998888' }));
    expect((whatsapp.save.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].api_key).toBeUndefined();
  });

  it('needs a key on the first save, a valid number and a public https server', async () => {
    const first = buildApp({ saved: null });
    expect((await first.app.inject({ method: 'PUT', url: '/whatsapp', payload: body })).statusCode).toBe(400);
    const { app } = buildApp();
    expect((await app.inject({ method: 'PUT', url: '/whatsapp', payload: { ...body, number: '123' } })).statusCode).toBe(400);
    for (const server_url of ['http://wpp.example.com', 'https://evil.example.com', 'https://localhost:8080']) {
      expect((await app.inject({ method: 'PUT', url: '/whatsapp', payload: { ...body, server_url } })).statusCode).toBe(400);
    }
  });

  it('tests the connection with the stored key only against the server it was saved for', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ instance: { state: 'open' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { app } = buildApp();
    const ok = await app.inject({ method: 'POST', url: '/whatsapp/test', payload: {} });
    expect(ok.json()).toEqual({ ok: true, state: 'open' });
    expect(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).apikey).toBe('stored-key');
    const elsewhere = await app.inject({ method: 'POST', url: '/whatsapp/test', payload: { server_url: 'https://other.example.com' } });
    expect(elsewhere.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a paired-but-closed instance as NOT_CONNECTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ instance: { state: 'close' } }), { status: 200 })));
    const { app } = buildApp();
    expect((await app.inject({ method: 'POST', url: '/whatsapp/test', payload: {} })).json()).toEqual({ ok: false, code: 'NOT_CONNECTED' });
  });

  it('sends the test message to the saved number', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const { app, whatsapp } = buildApp();
    expect((await app.inject({ method: 'POST', url: '/whatsapp/test-message' })).json()).toEqual({ ok: true });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).number).toBe('5562999998888');
    expect(whatsapp.noteDelivery).toHaveBeenCalledWith('u1', null);
  });

  it('removes the setup', async () => {
    const { app, whatsapp } = buildApp();
    expect((await app.inject({ method: 'DELETE', url: '/whatsapp' })).statusCode).toBe(200);
    expect(whatsapp.delete).toHaveBeenCalledWith('u1');
  });
});
