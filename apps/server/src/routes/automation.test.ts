import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { normalizeSetup } from '../setup/schema.js';
import { automationPauseRoutes, projectAutomationEventRoutes } from './automation.js';

async function build() {
  const pauseProject = vi.fn(async (_id: string, at: Date) => ({ paused_at: at, fresh: true }));
  const resumeUser = vi.fn(async () => true);
  const userPausedAt = vi.fn(async () => new Date('2026-10-05T09:00:00.000Z') as Date | null);
  const pausedProjects = vi.fn(async () => [{ id: 'p1', paused_at: new Date('2026-10-05T08:00:00.000Z') }]);
  const listByProject = vi.fn(async () => [{ id: 'e1', project_id: 'p1', task_id: null, run_id: null, kind: 'paused', payload: {}, created_at: '2026-10-05T10:00:00.000Z' }]);
  const repos = {
    projects: {
      findById: async (id: string) => (id === 'p1' ? { id, owner_id: 'u1' } : id === 'p9' ? { id, owner_id: 'u9' } : undefined),
      list: async () => [{ id: 'p1', owner_id: 'u1' }],
    },
    projectSetup: { get: async () => ({ data: normalizeSetup({}, 2) }) },
    automationPauses: { pauseProject, resumeUser, userPausedAt, pausedProjects },
    automationEvents: { insert: async () => ({ id: 'e1', project_id: 'p1', task_id: null, run_id: null, kind: 'paused', payload: {}, created_at: '' }), listByProject },
  } as unknown as Repositories;
  const app = Fastify();
  applyErrorHandler(app);
  const actions: Record<string, unknown> = {};
  app.addHook('onRoute', (route) => {
    actions[`${route.method} ${route.url}`] = (route.config as { action?: string } | undefined)?.action;
  });
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1', role: 'member' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  await app.register((a) => automationPauseRoutes(a, repos), { prefix: '/automation' });
  await app.register((a) => projectAutomationEventRoutes(a, repos), { prefix: '/projects' });
  await app.ready();
  return { app, actions, pauseProject, resumeUser, listByProject, userPausedAt, pausedProjects };
}

describe('automation pause and event routes', () => {
  it('pause and resume need projects:update, not create', async () => {
    const { actions } = await build();
    expect(actions['POST /automation/pause']).toBe('update');
    expect(actions['POST /automation/resume']).toBe('update');
  });

  it('reads the pause state: the person\'s pause and the projects paused on their own', async () => {
    const { app, pausedProjects } = await build();
    const res = await app.inject({ method: 'GET', url: '/automation/state' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ paused_at: '2026-10-05T09:00:00.000Z', projects: [{ id: 'p1', paused_at: '2026-10-05T08:00:00.000Z' }] });
    expect(pausedProjects).toHaveBeenCalledWith('u1');
  });

  it('the state of a person who paused nothing has a null paused_at', async () => {
    const { app, userPausedAt, pausedProjects } = await build();
    userPausedAt.mockResolvedValueOnce(null);
    pausedProjects.mockResolvedValueOnce([]);
    expect((await app.inject({ method: 'GET', url: '/automation/state' })).json()).toEqual({ paused_at: null, projects: [] });
  });

  it('pauses a project and answers its timestamp', async () => {
    const { app, pauseProject } = await build();
    const res = await app.inject({ method: 'POST', url: '/automation/pause', payload: { scope: 'p1', interrupt: true } });
    expect(res.statusCode).toBe(200);
    expect(Number.isNaN(Date.parse(res.json().paused_at))).toBe(false);
    expect(pauseProject).toHaveBeenCalledWith('p1', expect.any(Date));
  });

  it('a project outside the scope is a 404, a malformed body a 400', async () => {
    const { app, pauseProject } = await build();
    expect((await app.inject({ method: 'POST', url: '/automation/pause', payload: { scope: 'p9' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/automation/pause', payload: { scope: '' } })).statusCode).toBe(400);
    expect(pauseProject).not.toHaveBeenCalled();
  });

  it('resume all answers 204', async () => {
    const { app, resumeUser } = await build();
    const res = await app.inject({ method: 'POST', url: '/automation/resume', payload: { scope: 'all' } });
    expect(res.statusCode).toBe(204);
    expect(resumeUser).toHaveBeenCalledWith('u1');
  });

  it('lists a project\'s events, paging with before', async () => {
    const { app, listByProject } = await build();
    const res = await app.inject({ method: 'GET', url: '/projects/p1/automation/events?before=2026-10-05T10:00:00.000Z&limit=20' });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(1);
    expect(listByProject).toHaveBeenCalledWith('p1', { before: new Date('2026-10-05T10:00:00.000Z'), limit: 20 });
    expect((await app.inject({ method: 'GET', url: '/projects/p9/automation/events' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/projects/p1/automation/events?before=yesterday' })).statusCode).toBe(400);
  });
});
