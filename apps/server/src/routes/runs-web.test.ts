import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { runsWebRoutes } from './runs-web.js';

const PROJECTS = [{ id: 'p1', key: 'TER', name: 'termhub', owner_id: 'u1' }, { id: 'p2', key: 'OTH', name: 'other', owner_id: 'u2' }];

/** `viewAs` simulates an admin viewing as u2: the route must still answer u1's own runs. */
function build(opts: { flag?: boolean; viewAs?: string } = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    const owner = opts.viewAs ?? 'u1';
    request.user = { id: 'u1' } as never;
    request.scope = { user: { id: 'u1' } as never, viewAs: opts.viewAs ? { kind: 'user', user: { id: owner } as never } : { kind: 'self' }, ownerId: owner, createAs: owner };
  });
  const apiRuns = {
    listForUser: vi.fn(async (userId: string) => [{ id: `run-of-${userId}`, user_id: userId, project_id: 'p1', capabilities: ['read'], status: 'succeeded', timeout_ms: 600_000, created_at: '', started_at: null, ended_at: null, machine_id: null, machine_name: null, account_label: null, error_code: null }]),
  };
  const repos = {
    apiRuns,
    featureFlags: { overrideFor: vi.fn(async () => null), instanceValue: vi.fn(async (flag: string) => (flag === 'runs_api' ? (opts.flag ?? true) : null)) },
    projects: { findById: vi.fn(async (id: string) => PROJECTS.find((p) => p.id === id)), findByKey: vi.fn(async (key: string) => PROJECTS.find((p) => p.key === key)) },
  } as unknown as Repositories;
  app.register((a) => runsWebRoutes(a, repos), { prefix: '/runs' });
  return { app, apiRuns };
}

describe('GET /api/runs (Progresso)', () => {
  it('answers 404 while the runs_api flag is off', async () => {
    const { app, apiRuns } = build({ flag: false });
    expect((await app.inject({ url: '/runs' })).statusCode).toBe(404);
    expect(apiRuns.listForUser).not.toHaveBeenCalled();
  });

  it("lists the session user's own runs of a project", async () => {
    const { app, apiRuns } = build();
    const r = await app.inject({ url: '/runs?project=p1&limit=10' });
    expect(r.statusCode).toBe(200);
    expect(r.json().runs.map((x: { id: string }) => x.id)).toEqual(['run-of-u1']);
    expect(apiRuns.listForUser).toHaveBeenCalledWith('u1', { projectId: 'p1', limit: 10 });
  });

  it('never follows "view as": an admin viewing as someone gets their own runs, and 404 on the other project', async () => {
    const { app, apiRuns } = build({ viewAs: 'u2' });
    expect((await app.inject({ url: '/runs' })).json().runs.map((x: { id: string }) => x.id)).toEqual(['run-of-u1']);
    expect((await app.inject({ url: '/runs?project=p2' })).statusCode).toBe(404);
    expect(apiRuns.listForUser).toHaveBeenCalledTimes(1);
  });
});
