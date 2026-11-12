import Fastify from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn() }));

import { canAccess } from '../auth/permissions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import type { ApiRun, StoredRunEvent } from '../db/repositories/api-runs.js';
import { NoCandidateError, RunLimitError, type RunService } from '../runs/service.js';
import { tk } from '../i18n/index.js';
import { hashApiToken } from '../auth/api-tokens.js';
import { runsV1Routes } from './runs-v1.js';

const SECRET = 'thb_pat_' + 'A'.repeat(43);
const REVOKED = 'thb_pat_' + 'R'.repeat(43);

const token = (over: Partial<ApiToken> = {}): ApiToken => ({
  id: 'tok1', user_id: 'u1', name: 'ci', scopes: ['runs'], expires_at: null, last_used_at: null, revoked_at: null, created_at: '', gated: false, chat_conversation_id: null, tab_id: null, ...over,
});

const run = (over: Partial<ApiRun> = {}): ApiRun => ({
  id: 'run1', user_id: 'u1', token_id: 'tok1', project_id: 'p1', machine_id: 'm1', machine_name: 'jarvis', account_id: 'a1', account_label: 'pessoal',
  provider: 'claude', model: 'sonnet', capabilities: ['read'], status: 'succeeded', workspace: { kind: 'project', path: '/w', branch: null },
  result: 'oi', usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.01 }, error_code: null, error_message: null, idempotency_key: null,
  timeout_ms: 600_000, created_at: '2026-11-11T00:00:00.000Z', started_at: '2026-11-11T00:00:01.000Z', ended_at: '2026-11-11T00:00:09.000Z', ...over,
});

const RUNS = [run(), run({ id: 'run2', status: 'running', result: null, ended_at: null }), run({ id: 'foreign', user_id: 'u2', project_id: 'p2' })];
const PROJECTS = [{ id: 'p1', key: 'TER', name: 'termhub', owner_id: 'u1' }, { id: 'p2', key: 'OTH', name: 'other', owner_id: 'u2' }];

const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): StoredRunEvent => ({ seq, type, payload, at: '2026-11-11T00:00:0' + seq + '.000Z' });
const EVENTS = [ev(1, 'started', { provider: 'claude' }), ev(2, 'text', { text: 'oi' }), ev(3, 'usage', { input_tokens: 1, output_tokens: 1 }), ev(4, 'done', { status: 'succeeded', result: 'oi', usage: null })];

/** A stand-in for RunService: the routes' side only (the service has its own tests). */
function fakeService(opts: { live?: boolean } = {}) {
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  return {
    stops,
    create: vi.fn<RunService['create']>(async () => ({ run: run({ id: 'new1', status: 'queued', result: null, ended_at: null }), created: true })),
    cancel: vi.fn<RunService['cancel']>(async (userId, id) => {
      const r = RUNS.find((x) => x.id === id && x.user_id === userId);
      return r ? { ...r, status: r.status === 'running' ? 'cancelled' : r.status } : undefined;
    }),
    subscribe: vi.fn<RunService['subscribe']>((_id, after, onEvent, onEnd) => {
      const stop = vi.fn();
      stops.push(stop);
      setTimeout(() => {
        for (const e of opts.live ? EVENTS.slice(0, 2) : EVENTS) if (e.seq > after) onEvent(e);
        if (!opts.live) onEnd();
      }, 0);
      return stop;
    }),
  };
}

function build(opts: { token?: ApiToken; flag?: boolean; grants?: string[]; legalPending?: boolean; service?: ReturnType<typeof fakeService>; keepAliveMs?: number } = {}) {
  const app = Fastify();
  const active = opts.token ?? token();
  const apiTokens = {
    findActiveByHash: vi.fn(async (hash: string) => (hash === hashApiToken(SECRET) ? active : undefined)),
    touchLastUsed: vi.fn(async () => {}),
    recordEvent: vi.fn(async (_e: Record<string, unknown>) => {}),
  };
  const apiRuns = {
    findForUser: vi.fn(async (userId: string, id: string) => RUNS.find((r) => r.id === id && r.user_id === userId)),
    listForUser: vi.fn(async (userId: string, o: { projectId?: string; status?: string; limit: number }) =>
      RUNS.filter((r) => r.user_id === userId && (!o.projectId || r.project_id === o.projectId) && (!o.status || r.status === o.status)).slice(0, o.limit)),
  };
  const repos = {
    apiTokens,
    apiRuns,
    tabs: { findById: vi.fn(async (id: string) => (id === 'tab1' ? { id: 'tab1', project_id: 'p1' } : undefined)) },
    users: { findById: vi.fn(async (id: string) => (id === 'u1' ? { id: 'u1', role_id: 'r', locale: null } : undefined)) },
    featureFlags: { overrideFor: vi.fn(async () => null), instanceValue: vi.fn(async (flag: string) => (flag === 'runs_api' ? (opts.flag ?? true) : null)) },
    securityEvents: { record: vi.fn(async () => {}) },
    legal: { statusFor: vi.fn(async () => ({ pending: opts.legalPending ? [{ document: 'terms' }] : [], upcoming: [] })) },
    projects: {
      findById: vi.fn(async (id: string) => PROJECTS.find((p) => p.id === id)),
      findByKey: vi.fn(async (key: string) => PROJECTS.find((p) => p.key === key)),
    },
  } as unknown as Repositories;
  const grants = opts.grants ?? ['runs:read', 'runs:create'];
  vi.mocked(canAccess).mockImplementation(async (_r, _u, resource, action) => grants.includes(`${resource}:${action}`));
  const service = opts.service ?? fakeService();
  app.register((a) => runsV1Routes(a, repos, { service, keepAliveMs: opts.keepAliveMs }), { prefix: '/api/v1' });
  return { app, apiTokens, apiRuns, service, repos };
}

const get = (app: ReturnType<typeof Fastify>, url: string, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) => app.inject({ method: 'GET', url, headers });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.mocked(canAccess).mockReset());

describe('/api/v1 auth', () => {
  it('answers 401 UNAUTHENTICATED without an Authorization header', async () => {
    const { app } = build();
    const r = await get(app, '/api/v1/runs', {});
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Não autenticado' } });
  });

  it('never accepts the session cookie: cookie only is 401', async () => {
    const { app } = build();
    const r = await get(app, '/api/v1/runs', { cookie: 'termhub_session=abc; termhub_csrf=x', 'x-csrf-token': 'x' });
    expect(r.statusCode).toBe(401);
  });

  it('answers 401 for a revoked (or unknown) token', async () => {
    const { app } = build();
    expect((await get(app, '/api/v1/runs', { authorization: `Bearer ${REVOKED}` })).statusCode).toBe(401);
  });

  it('answers 404 while the runs_api flag is off for the owner, even with the scope', async () => {
    const { app } = build({ flag: false });
    const r = await get(app, '/api/v1/runs');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });

  it('answers 403 SCOPE_REQUIRED for a token without runs', async () => {
    const { app } = build({ token: token({ scopes: ['read', 'tasks', 'terminals', 'memory'] }) });
    const r = await get(app, '/api/v1/runs');
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('SCOPE_REQUIRED');
  });

  it.each([
    ['gated (concierge)', token({ gated: true })],
    ['tab', token({ tab_id: 'tab1' })],
  ])('refuses a %s token even if its row says runs', async (_n, tok) => {
    const { app } = build({ token: tok });
    expect((await get(app, '/api/v1/runs')).json().error.code).toBe('SCOPE_REQUIRED');
  });

  it('answers 403 FORBIDDEN when the role has no runs:read grant', async () => {
    const { app } = build({ grants: [] });
    const r = await get(app, '/api/v1/runs');
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('FORBIDDEN');
  });

  it('answers 403 LEGAL_ACCEPTANCE_REQUIRED while the Terms are pending', async () => {
    const { app } = build({ legalPending: true });
    expect((await get(app, '/api/v1/runs')).json().error.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
  });

  it('answers an unknown path under /api/v1 with the v1 404 shape', async () => {
    const { app } = build();
    const r = await get(app, '/api/v1/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada' } });
  });
});

describe('GET /api/v1/runs/:id', () => {
  it('answers the own run in the documented shape', async () => {
    const { app } = build();
    const r = await get(app, '/api/v1/runs/run1');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      id: 'run1', project_id: 'p1', status: 'succeeded', provider: 'claude', model: 'sonnet', capabilities: ['read'],
      machine: { id: 'm1', name: 'jarvis' }, account: 'pessoal', workspace: { kind: 'project', path: '/w', branch: null },
      result: 'oi', usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.01 }, error: null, timeout_s: 600,
      created_at: '2026-11-11T00:00:00.000Z', started_at: '2026-11-11T00:00:01.000Z', ended_at: '2026-11-11T00:00:09.000Z',
      events_url: '/api/v1/runs/run1/events',
    });
  });

  it("answers 404 for another person's run, the same as a missing one", async () => {
    const { app } = build();
    const foreign = await get(app, '/api/v1/runs/foreign');
    const missing = await get(app, '/api/v1/runs/missing');
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
  });

  it('records one ApiTokenEvent per call, metadata only', async () => {
    const { app, apiTokens } = build();
    await get(app, '/api/v1/runs/run1');
    await get(app, '/api/v1/runs/foreign');
    await flush();
    expect(apiTokens.recordEvent.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ token_id: 'tok1', tool: 'REST GET /runs/:id', project_id: 'p1', ok: true, error_code: null }),
      expect.objectContaining({ token_id: 'tok1', tool: 'REST GET /runs/:id', project_id: null, ok: false, error_code: 'NOT_FOUND' }),
    ]);
  });
});

describe('GET /api/v1/runs', () => {
  it("lists only the owner's runs, newest first as the repository gives them", async () => {
    const { app } = build();
    const r = await get(app, '/api/v1/runs');
    expect(r.statusCode).toBe(200);
    expect(r.json().runs.map((x: { id: string }) => x.id)).toEqual(['run1', 'run2']);
  });

  it('filters by status and by project key', async () => {
    const { app, apiRuns } = build();
    expect((await get(app, '/api/v1/runs?status=running')).json().runs.map((x: { id: string }) => x.id)).toEqual(['run2']);
    await get(app, '/api/v1/runs?project=ter&limit=5');
    expect(apiRuns.listForUser).toHaveBeenLastCalledWith('u1', { projectId: 'p1', status: undefined, limit: 5 });
  });

  it("answers 404 for another person's project", async () => {
    const { app, apiRuns } = build();
    expect((await get(app, '/api/v1/runs?project=OTH')).statusCode).toBe(404);
    expect((await get(app, '/api/v1/runs?project=p2')).statusCode).toBe(404);
    expect(apiRuns.listForUser).not.toHaveBeenCalled();
  });

  it('answers 422 VALIDATION for a bad query', async () => {
    const { app } = build();
    const r = await get(app, '/api/v1/runs?status=bogus');
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('VALIDATION');
  });
});

describe('/api/v1 mounted next to /api, as app.ts does', () => {
  it("never runs /api's session hook, and keeps its own 404", async () => {
    const { app } = build();
    const sessionHook = vi.fn<(req: { url: string }) => Promise<void>>(async () => {});
    app.register(
      async (api) => {
        api.addHook('preHandler', sessionHook);
        api.get('/health', async () => ({ ok: true }));
        api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Rota não encontrada', code: 'NOT_FOUND' }));
      },
      { prefix: '/api' },
    );
    expect((await get(app, '/api/v1/runs/run1')).statusCode).toBe(200);
    expect((await get(app, '/api/v1/nope')).json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada' } });
    expect((await get(app, '/api/nope')).json()).toEqual({ error: 'Rota não encontrada', code: 'NOT_FOUND' });
    expect(sessionHook.mock.calls.map(([req]) => req.url)).toEqual(['/api/nope']);
  });
});

const post = (app: ReturnType<typeof Fastify>, url: string, body?: unknown) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${SECRET}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, payload: body === undefined ? undefined : JSON.stringify(body) });

describe('POST /api/v1/runs', () => {
  it('answers 202 with the run id and events_url, and audits without the prompt', async () => {
    const { app, service, repos } = build();
    const r = await post(app, '/api/v1/runs', { project: 'TER', prompt: 'segredo do prompt', capabilities: ['read', 'read'], budget: { timeout_s: 120 }, idempotency_key: 'k1' });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ run_id: 'new1', status: 'queued', events_url: '/api/v1/runs/new1/events' });
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ id: 'u1' }) }), {
      project: 'TER', prompt: 'segredo do prompt', capabilities: ['read'], model_class: undefined, model: null, provider: null, machine: null, timeout_s: 120, idempotency_key: 'k1',
    });
    const record = vi.mocked(repos.securityEvents.record);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api_run.create', target_id: 'new1' }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('segredo');
  });

  it('defaults to read and 600 s', async () => {
    const { app, service } = build();
    await post(app, '/api/v1/runs', { project: 'TER', prompt: 'oi' });
    expect(service.create.mock.calls[0]![1]).toMatchObject({ capabilities: ['read'], timeout_s: 600 });
  });

  it('a replay of the same idempotency key answers the same run and is not audited again', async () => {
    const service = fakeService();
    service.create.mockResolvedValue({ run: run(), created: false });
    const { app, repos } = build({ service });
    const r = await post(app, '/api/v1/runs', { project: 'TER', prompt: 'oi', idempotency_key: 'k1' });
    expect(r.statusCode).toBe(202);
    expect(r.json().run_id).toBe('run1');
    expect(repos.securityEvents.record).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown field', { project: 'TER', prompt: 'oi', argv: ['--x'] }],
    ['a timeout above 3600 s', { project: 'TER', prompt: 'oi', budget: { timeout_s: 3601 } }],
    ['a prompt above 100 000 chars', { project: 'TER', prompt: 'x'.repeat(100_001) }],
    ['an unknown capability', { project: 'TER', prompt: 'oi', capabilities: ['push'] }],
  ])('answers 422 VALIDATION for %s', async (_n, body) => {
    const { app, service } = build();
    const r = await post(app, '/api/v1/runs', body);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('VALIDATION');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('answers 429 RATE_LIMITED with Retry-After', async () => {
    const service = fakeService();
    service.create.mockRejectedValue(new RunLimitError(42));
    const { app } = build({ service });
    const r = await post(app, '/api/v1/runs', { project: 'TER', prompt: 'oi' });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('42');
    expect(r.json().error.code).toBe('RATE_LIMITED');
  });

  it('answers 409 NO_ACCOUNT_AVAILABLE with the reason per account', async () => {
    const service = fakeService();
    service.create.mockRejectedValue(new NoCandidateError('NO_ACCOUNT_AVAILABLE', tk('Nenhuma conta disponível para a run'), [{ account: 'pessoal', machine: 'jarvis', reason: 'usage_peak' }]));
    const { app } = build({ service });
    const r = await post(app, '/api/v1/runs', { project: 'TER', prompt: 'oi' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { code: 'NO_ACCOUNT_AVAILABLE', message: 'Nenhuma conta disponível para a run', candidates: [{ account: 'pessoal', machine: 'jarvis', reason: 'usage_peak' }] } });
  });

  it('answers 409 AGENT_OUTDATED when every machine runs an older agent', async () => {
    const service = fakeService();
    service.create.mockRejectedValue(new NoCandidateError('AGENT_OUTDATED', tk('Nenhuma conta disponível para a run'), [{ account: 'pessoal', machine: 'jarvis', reason: 'agent_outdated' }]));
    const { app } = build({ service });
    expect((await post(app, '/api/v1/runs', { project: 'TER', prompt: 'oi' })).json().error.code).toBe('AGENT_OUTDATED');
  });

  it('needs the runs:create grant', async () => {
    const { app, service } = build({ grants: ['runs:read'] });
    expect((await post(app, '/api/v1/runs', { project: 'TER', prompt: 'oi' })).statusCode).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/runs/:id/events', () => {
  it('streams the events as SSE (id = seq) and closes after done', async () => {
    const { app } = build();
    const r = await get(app, '/api/v1/runs/run1/events');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    const ids = [...r.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([1, 2, 3, 4]);
    expect(r.body).toContain('event: done\ndata: {"seq":4,"type":"done","at":"2026-11-11T00:00:04.000Z","status":"succeeded","result":"oi","usage":null}');
  });

  it('a reconnect with Last-Event-ID gets only what came after it', async () => {
    const { app, service } = build();
    const r = await get(app, '/api/v1/runs/run1/events', { authorization: `Bearer ${SECRET}`, 'last-event-id': '2' });
    expect(service.subscribe.mock.calls[0]![1]).toBe(2);
    expect([...r.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([3, 4]);
  });

  it("answers 404 for another person's run, never a stream", async () => {
    const { app, service } = build();
    const r = await get(app, '/api/v1/runs/foreign/events');
    expect(r.statusCode).toBe(404);
    expect(service.subscribe).not.toHaveBeenCalled();
  });

  it('a client that disconnects stops its stream and never cancels the run', async () => {
    const service = fakeService({ live: true });
    const { app } = build({ service, keepAliveMs: 20 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = (app.server.address() as AddressInfo).port;
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/runs/run2/events', headers: { authorization: `Bearer ${SECRET}` } }, (res) => {
          let text = '';
          res.on('data', (c: Buffer) => {
            text += c.toString();
            // Two events and a keep-alive in: the client goes away mid-run.
            if (text.includes('id: 2') && text.includes(': keep-alive')) {
              req.destroy();
              resolve(text);
            }
          });
        });
        req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
      });
      expect(body).toContain('id: 1');
      await vi.waitFor(() => expect(service.stops[0]).toHaveBeenCalled());
      expect(service.cancel).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/v1/runs/:id/cancel', () => {
  it('answers 202 with the new status and audits it', async () => {
    const { app, service, repos } = build();
    const r = await post(app, '/api/v1/runs/run2/cancel');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ run_id: 'run2', status: 'cancelled' });
    expect(service.cancel).toHaveBeenCalledWith('u1', 'run2');
    expect(repos.securityEvents.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api_run.cancel', target_id: 'run2' }));
  });

  it("answers 404 for another person's run", async () => {
    const { app } = build();
    expect((await post(app, '/api/v1/runs/foreign/cancel')).statusCode).toBe(404);
  });
});
