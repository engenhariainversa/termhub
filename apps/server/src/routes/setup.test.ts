import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

// Same reason as routes/tickets.test.ts: routes/setup.js -> control/tickets.js -> control/tasks.js
// reads config.publicUrl at import time, and config.js validates process.env on import.
vi.mock('../config.js', () => ({ config: { publicUrl: 'https://app.test' } }));

import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { effectiveRepos } from '../setup/repos.js';
import { normalizeSetup, SETUP_VERSION, type ProjectSetupData } from '../setup/schema.js';
import { forgetSync } from '../setup/tickets-sync.js';
import { setupRoutes } from './setup.js';
import { nudgeAiMemoryRules } from '../memory/ai-memory-sync.js';

vi.mock('../memory/ai-memory-sync.js', () => ({ nudgeAiMemoryRules: vi.fn() }));

vi.mock('../setup/tickets-sync.js', () => ({
  syncProjectTickets: vi.fn(async () => ({ sources: [{ provider: 'github', integration_id: 'g', scope: 'a/b', error: 'Falha ao consultar github: 401' }], synced_at: 'now' })),
  lastSync: () => null,
  forgetSync: vi.fn(),
}));

function build(saved: unknown[], ai?: unknown, automation?: unknown, more: Record<string, unknown> = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1', role: 'admin' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const pruneSource = vi.fn(async () => 2);
  const save = vi.fn(async (_p: string, data: unknown) => ({ data }));
  const repos = {
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    integrations: { findById: vi.fn(async (id: string) => ({ id, owner_id: id === 'foreign' ? 'u2' : 'u1', provider: 'github', config: {} })) },
    machines: { findById: vi.fn() },
    projectSetup: {
      get: vi.fn(async () => ({ data: { ticket_sources: saved, ...(ai ? { ai } : {}), ...(automation ? { automation } : {}), ...more } })),
      save,
    },
    // nothing discovered: the list is what the setup alone gives
    projectRepositories: { effective: vi.fn(async (_p: string, data: ProjectSetupData) => effectiveRepos(normalizeSetup(data, SETUP_VERSION), [])) },
    tickets: { pruneSource },
    automationEvents: { insert: vi.fn(async (e: object) => ({ id: 'ev', created_at: '', ...e })) },
  } as unknown as Repositories;
  app.register((a) => setupRoutes(a, repos), { prefix: '/projects' });
  return { app, pruneSource, save };
}

const src = (scope: string) => ({ provider: 'github', integration_id: 'g', scope, filter: null, sync_minutes: 0 });

describe('setup routes', () => {
  it('saving without a source prunes that source\'s non-imported tickets', async () => {
    const { app, pruneSource } = build([src('a/b'), src('a/c')]);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [src('a/b')] } });
    expect(res.statusCode).toBe(200);
    expect(pruneSource).toHaveBeenCalledExactlyOnceWith('p1', { integration_id: 'g', scope: 'a/c' });
  });

  it('refuses a duplicate source', async () => {
    const { app } = build([]);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [src('a/b'), src('a/b')] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('DUPLICATE_SOURCE');
  });

  it('a body from the previous web app (tickets only, no ticket_sources) keeps the source and prunes nothing', async () => {
    const { app, pruneSource, save } = build([src('a/b')]);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { tickets: { ...src('a/b'), include_done: true } } });
    expect(res.statusCode).toBe(200);
    expect(pruneSource).not.toHaveBeenCalled();
    const data = save.mock.calls[0][1] as { ticket_sources: unknown[] };
    expect(data.ticket_sources).toEqual([src('a/b')]);
  });

  it('saving forgets the project\'s sync throttle, so a new source syncs right away', async () => {
    const { app } = build([]);
    vi.mocked(forgetSync).mockClear();
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [src('a/b')] } });
    expect(res.statusCode).toBe(200);
    expect(forgetSync).toHaveBeenCalledExactlyOnceWith('p1');
  });

  it('sync answers 502 when every source failed', async () => {
    const { app } = build([src('a/b')]);
    const res = await app.inject({ method: 'POST', url: '/projects/p1/tickets/sync' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('PROVIDER_ERROR');
  });
});

describe('full setup PUT and the ai block (TER-589)', () => {
  it('keeps the stored ai block whatever the body says: it has its own endpoint', async () => {
    const stored = { accounts: ['a1'], models: { claude: 'opus', chatgpt: null } };
    for (const payload of [{}, { ai: { accounts: [], models: { claude: null, chatgpt: null } } }]) {
      const { app, save } = build([], stored);
      const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload });
      expect(res.statusCode).toBe(200);
      expect((save.mock.calls[0][1] as { ai: unknown }).ai).toEqual(stored);
    }
  });
});

describe('setup PUT and the automation block', () => {
  const stored = { enabled: true, autonomy: 'merge', max_parallel: 2 };

  it('keeps the stored block when the body omits it (older clients)', async () => {
    const { app, save } = build([], undefined, stored);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: {} });
    expect(res.statusCode).toBe(200);
    expect((save.mock.calls[0][1] as { automation: unknown }).automation).toEqual(stored);
  });

  it('replaces it when the body sends one', async () => {
    const { app, save } = build([], undefined, stored);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { automation: { enabled: false } } });
    expect(res.statusCode).toBe(200);
    const sent = (save.mock.calls[0][1] as { automation: { enabled: boolean; autonomy: string } }).automation;
    expect(sent.enabled).toBe(false);
    expect(sent.autonomy).toBe('pr');
  });
});

describe('setup PUT and the ai_memory block (TER-1019)', () => {
  it('a client that leaves the block out keeps the stored option, and the save nudges the sync', async () => {
    const { app, save } = build([], undefined, undefined, { ai_memory: { publish_rules: true } });
    vi.mocked(nudgeAiMemoryRules).mockClear();
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [] } });
    expect(res.statusCode).toBe(200);
    expect((save.mock.calls[0][1] as { ai_memory: unknown }).ai_memory).toEqual({ publish_rules: true });
    expect(nudgeAiMemoryRules).toHaveBeenCalledWith(expect.anything(), 'p1', expect.anything(), { fresh: true });
  });

  it('turning it off is saved and still nudges (the pages are removed)', async () => {
    const { app, save } = build([], undefined, undefined, { ai_memory: { publish_rules: true } });
    vi.mocked(nudgeAiMemoryRules).mockClear();
    await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [], ai_memory: { publish_rules: false } } });
    expect((save.mock.calls[0][1] as { ai_memory: unknown }).ai_memory).toEqual({ publish_rules: false, use_in_runs: false });
    expect(nudgeAiMemoryRules).toHaveBeenCalledOnce();
  });

  it('never nudges a project that does not use the option', async () => {
    const { app } = build([], undefined, undefined, { ai_memory: { publish_rules: false } });
    vi.mocked(nudgeAiMemoryRules).mockClear();
    await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [] } });
    expect(nudgeAiMemoryRules).not.toHaveBeenCalled();
  });
});

describe('setup and the project repositories (TER-1076)', () => {
  const repo = { integration_id: 'g', full_name: 'acme/api', base_branch: 'develop' };
  const override = { full_name: 'acme/web', autonomy: 'merge', merge_order: 1 };
  const storedRepos = [{ full_name: 'acme/bff', enabled: false }];
  const storedDefaults = { integration_id: 'g', scan_depth: 2 };

  it('GET answers the effective list next to the setup', async () => {
    const { app } = build([], undefined, { autonomy: 'merge' }, { repo });
    const res = await app.inject({ method: 'GET', url: '/projects/p1/setup' });
    expect(res.statusCode).toBe(200);
    expect(res.json().effective_repos).toEqual([expect.objectContaining({ full_name: 'acme/api', key: 'main', base_branch: 'develop', autonomy: 'merge', discovered: false })]);
    expect(res.json().setup.data.repo).toEqual(repo);
  });

  it('PUT saves the overrides and answers the list they give', async () => {
    const { app, save } = build([]);
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { repo, automation: { autonomy: 'deploy' }, repo_defaults: { scan_depth: 3 }, repos: [override] } });
    expect(res.statusCode).toBe(200);
    const data = save.mock.calls[0][1] as ProjectSetupData;
    expect(data.repos).toEqual([expect.objectContaining({ ...override, enabled: true })]);
    expect(data.repo_defaults).toEqual({ integration_id: null, scan_depth: 3 });
    expect(res.json().effective_repos.map((e: { full_name: string; autonomy: string; key: string | null }) => [e.full_name, e.key, e.autonomy])).toEqual([['acme/api', 'main', 'deploy'], ['acme/web', null, 'merge']]);
  });

  it('keeps the stored overrides and defaults when the body omits them (a client from before them)', async () => {
    const { app, save } = build([], undefined, undefined, { repos: storedRepos, repo_defaults: storedDefaults });
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { repo } });
    expect(res.statusCode).toBe(200);
    const data = save.mock.calls[0][1] as ProjectSetupData;
    expect(data.repos).toEqual(storedRepos);
    expect(data.repo_defaults).toEqual(storedDefaults);
  });

  it('replaces them when the body sends them, an empty list included', async () => {
    const { app, save } = build([], undefined, undefined, { repos: storedRepos, repo_defaults: storedDefaults });
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { repos: [], repo_defaults: {} } });
    expect(res.statusCode).toBe(200);
    const data = save.mock.calls[0][1] as ProjectSetupData;
    expect(data.repos).toEqual([]);
    expect(data.repo_defaults).toEqual({ integration_id: null, scan_depth: 1 });
  });

  it('refuses an integration outside the scope in the defaults or in an override', async () => {
    for (const payload of [{ repo_defaults: { integration_id: 'foreign' } }, { repos: [{ full_name: 'acme/web', integration_id: 'foreign' }] }]) {
      const { app, save } = build([]);
      const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Integração do repositório inexistente');
      expect(save).not.toHaveBeenCalled();
    }
  });

  it('refuses an override above the project level, measured against the stored level when the body has no automation', async () => {
    const above = build([]);
    expect((await above.app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { automation: { autonomy: 'pr' }, repos: [override] } })).statusCode).toBe(400);
    expect(above.save).not.toHaveBeenCalled();

    const stored = build([], undefined, { enabled: true, autonomy: 'merge' });
    expect((await stored.app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { repos: [override] } })).statusCode).toBe(200);
    expect((stored.save.mock.calls[0][1] as ProjectSetupData).automation).toEqual({ enabled: true, autonomy: 'merge' });

    const storedLow = build([], undefined, { enabled: true, autonomy: 'pr' });
    expect((await storedLow.app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { repos: [override] } })).statusCode).toBe(400);
  });
});
