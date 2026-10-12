import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { monitorRoutes } from './monitor.js';

function buildApp(ownerId: string | null = 'u1') {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId, createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const repos = {
    tabs: {
      listWithState: vi.fn(async () => [{ id: 't1', project_id: 'p1', machine_id: 'm1', state: 'working' }]),
      listOpenTerminals: vi.fn(async () => [
        { id: 't1', project_id: 'p1', machine_id: 'm1', state: 'working' },
        { id: 't2', project_id: 'p1', machine_id: 'm1', state: null },
        { id: 't3', project_id: 'gone', machine_id: 'm1', state: null }, // project outside the owner's list
      ]),
    },
    projects: { list: vi.fn(async () => [{ id: 'p1', name: 'p1' }]) },
    automationRuns: { activeTabRefs: vi.fn(async () => [{ tab_id: 't1', ref: 'TER-7' }]) },
    machines: { list: vi.fn(async () => [{ id: 'm1', name: 'mac' }]) },
  } as unknown as Repositories;
  app.register((a) => monitorRoutes(a, repos), { prefix: '/monitor' });
  return { app, repos };
}

describe('GET /monitor', () => {
  it('/tabs still lists only tabs that reported a state', async () => {
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/monitor/tabs' })).json();
    expect(body.items.map((i: { tab: { id: string } }) => i.tab.id)).toEqual(['t1']);
  });

  it('/open-tabs lists every open terminal tab of the scope with its project and machine', async () => {
    const { app, repos } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/monitor/open-tabs' })).json();
    expect(body.items.map((i: { tab: { id: string } }) => i.tab.id)).toEqual(['t1', 't2']);
    expect(body.items[1]).toMatchObject({ project: { id: 'p1' }, machine: { id: 'm1', name: 'mac' } });
    expect(repos.tabs.listOpenTerminals).toHaveBeenCalledWith('u1');
    expect(repos.projects.list).toHaveBeenCalledWith({ owner: 'u1' });
    expect(repos.machines.list).toHaveBeenCalledWith('u1');
  });

  it('/auto-runs lists the tabs of the scope\'s active automatic runs with their card ref (TER-1044)', async () => {
    const { app, repos } = buildApp(null);
    const body = (await app.inject({ method: 'GET', url: '/monitor/auto-runs' })).json();
    expect(body).toEqual({ items: [{ tab_id: 't1', ref: 'TER-7' }] });
    expect(repos.automationRuns.activeTabRefs).toHaveBeenCalledWith(null);
  });
});
