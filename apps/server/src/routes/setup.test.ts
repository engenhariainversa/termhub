import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

// Same reason as routes/tickets.test.ts: routes/setup.js -> control/tickets.js -> control/tasks.js
// reads config.publicUrl at import time, and config.js validates process.env on import.
vi.mock('../config.js', () => ({ config: { publicUrl: 'https://app.test' } }));

import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { forgetSync } from '../setup/tickets-sync.js';
import { setupRoutes } from './setup.js';
import { nudgeAiMemoryRules } from '../memory/ai-memory-sync.js';

vi.mock('../memory/ai-memory-sync.js', () => ({ nudgeAiMemoryRules: vi.fn() }));

vi.mock('../setup/tickets-sync.js', () => ({
  syncProjectTickets: vi.fn(async () => ({ sources: [{ provider: 'github', integration_id: 'g', scope: 'a/b', error: 'Falha ao consultar github: 401' }], synced_at: 'now' })),
  lastSync: () => null,
  forgetSync: vi.fn(),
}));

function build(saved: unknown[], ai?: unknown, automation?: unknown, aiMemory?: unknown) {
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
    integrations: { findById: vi.fn(async (id: string) => ({ id, owner_id: 'u1', provider: 'github', config: {} })) },
    machines: { findById: vi.fn() },
    projectSetup: {
      get: vi.fn(async () => ({ data: { ticket_sources: saved, ...(ai ? { ai } : {}), ...(automation ? { automation } : {}), ...(aiMemory ? { ai_memory: aiMemory } : {}) } })),
      save,
    },
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
    const { app, save } = build([], undefined, undefined, { publish_rules: true });
    vi.mocked(nudgeAiMemoryRules).mockClear();
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [] } });
    expect(res.statusCode).toBe(200);
    expect((save.mock.calls[0][1] as { ai_memory: unknown }).ai_memory).toEqual({ publish_rules: true });
    expect(nudgeAiMemoryRules).toHaveBeenCalledWith(expect.anything(), 'p1', expect.anything(), { fresh: true });
  });

  it('turning it off is saved and still nudges (the pages are removed)', async () => {
    const { app, save } = build([], undefined, undefined, { publish_rules: true });
    vi.mocked(nudgeAiMemoryRules).mockClear();
    await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [], ai_memory: { publish_rules: false } } });
    expect((save.mock.calls[0][1] as { ai_memory: unknown }).ai_memory).toEqual({ publish_rules: false });
    expect(nudgeAiMemoryRules).toHaveBeenCalledOnce();
  });

  it('never nudges a project that does not use the option', async () => {
    const { app } = build([], undefined, undefined, { publish_rules: false });
    vi.mocked(nudgeAiMemoryRules).mockClear();
    await app.inject({ method: 'PUT', url: '/projects/p1/setup', payload: { ticket_sources: [] } });
    expect(nudgeAiMemoryRules).not.toHaveBeenCalled();
  });
});
