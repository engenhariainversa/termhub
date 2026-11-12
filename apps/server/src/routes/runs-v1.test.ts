import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/permissions.js', async (orig) => ({ ...(await orig<typeof import('../auth/permissions.js')>()), canAccess: vi.fn() }));

import { canAccess } from '../auth/permissions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import type { ApiRun } from '../db/repositories/api-runs.js';
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

function build(opts: { token?: ApiToken; flag?: boolean; grants?: string[]; legalPending?: boolean } = {}) {
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
    legal: { statusFor: vi.fn(async () => ({ pending: opts.legalPending ? [{ document: 'terms' }] : [], upcoming: [] })) },
    projects: {
      findById: vi.fn(async (id: string) => PROJECTS.find((p) => p.id === id)),
      findByKey: vi.fn(async (key: string) => PROJECTS.find((p) => p.key === key)),
    },
  } as unknown as Repositories;
  const grants = opts.grants ?? ['runs:read', 'runs:create'];
  vi.mocked(canAccess).mockImplementation(async (_r, _u, resource, action) => grants.includes(`${resource}:${action}`));
  app.register((a) => runsV1Routes(a, repos), { prefix: '/api/v1' });
  return { app, apiTokens, apiRuns };
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
