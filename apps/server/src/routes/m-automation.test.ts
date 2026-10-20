import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationSetupActionId, decisionProofMessage } from '@termhub/mobile-api';
import type { Device } from '../db/repositories/devices.js';
import type { Repositories } from '../db/repositories/index.js';
import type { SessionService } from '../mobile/session.js';
import { applyErrorHandler } from '../lib/errors.js';
import { normalizeSetup } from '../setup/schema.js';
import { mobileAutomationPauseRoutes, mobileAutomationSetupRoutes, mobileCardAutoRoutes } from './m-automation.js';

const device = { id: 'd1', user_id: 'u1' } as unknown as Device;
const ACTION = automationSetupActionId('p1');

async function build(stored: unknown = {}) {
  let data = normalizeSetup(stored, 2);
  const save = vi.fn(async (_p: string, next: typeof data) => {
    data = next;
    return { project_id: 'p1', version: 2, data, updated_at: 'now' };
  });
  const setAuto = vi.fn(async () => ({ changed: 1 }));
  const setTimeZone = vi.fn(async () => {});
  const repos = {
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id, owner_id: 'u1' } : undefined)) },
    tasks: { findById: vi.fn(async () => ({ id: 't1', project_id: 'p1', auto: true })), setAuto },
    projectSetup: { get: vi.fn(async () => ({ project_id: 'p1', version: 2, data, updated_at: null })), save },
    automationEvents: { insert: vi.fn(async (e: object) => ({ id: 'ev', created_at: '', ...e })) },
    users: { setTimeZone },
  } as unknown as Repositories;
  const session = {
    consumeDecisionChallenge: vi.fn(async (_d: Device, challenge: string, actionId: string) => challenge === 'c1' && actionId === ACTION),
    checkPin: vi.fn(async (_d: Device, message: string, proof: string) =>
      message === decisionProofMessage('c1', ACTION, 'automation_setup') && proof === 'good' ? { ok: true as const } : { ok: false as const, code: 'PIN_INVALID' as const, failures: 1 },
    ),
  };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1', role: 'member' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.mobile = { device, user: { id: 'u1' } } as never;
  });
  await app.register((a) => mobileAutomationSetupRoutes(a, repos, { session: session as unknown as SessionService }), { prefix: '/projects' });
  await app.register((a) => mobileCardAutoRoutes(a, repos), { prefix: '/tasks' });
  await app.ready();
  return { app, save, setAuto, setTimeZone, session, data: () => data };
}

const put = (app: FastifyInstance, automation: object, proof?: object) =>
  app.inject({ method: 'PUT', url: '/projects/p1/setup/automation', payload: { automation, ...proof } });

describe('mobile automation setup routes', () => {
  let t: Awaited<ReturnType<typeof build>>;
  afterEach(async () => {
    await t.app.close();
  });

  describe('automation off', () => {
    beforeEach(async () => {
      t = await build();
    });

    it('reads the block, off and at pr by default', async () => {
      const r = await t.app.inject({ method: 'GET', url: '/projects/p1/setup/automation' });
      expect(r.statusCode).toBe(200);
      expect(r.json().automation).toMatchObject({ enabled: false, autonomy: 'pr' });
    });

    it('turning it on without a PIN proof is 401 PIN_REQUIRED and saves nothing', async () => {
      const r = await put(t.app, { ...t.data().automation, enabled: true });
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe('PIN_REQUIRED');
      expect(t.save).not.toHaveBeenCalled();
    });

    it('turning it on with a good proof saves the block and keeps the rest of the setup', async () => {
      const r = await put(t.app, { ...t.data().automation, enabled: true }, { challenge: 'c1', pin_proof: 'good' });
      expect(r.statusCode).toBe(200);
      expect(r.json().automation.enabled).toBe(true);
      expect(t.save).toHaveBeenCalledTimes(1);
    });

    it('a wrong PIN is 401 PIN_INVALID and saves nothing', async () => {
      const r = await put(t.app, { ...t.data().automation, enabled: true }, { challenge: 'c1', pin_proof: 'bad' });
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe('PIN_INVALID');
      expect(t.save).not.toHaveBeenCalled();
    });

    it('changing a field while staying off never asks', async () => {
      const r = await put(t.app, { ...t.data().automation, worktrees_dir: '~/wt' });
      expect(r.statusCode).toBe(200);
      expect(t.save).toHaveBeenCalledTimes(1);
    });

    it('saves the phone\'s time zone with a summary hour, and only then; an unknown zone is ignored (TER-974)', async () => {
      const send = (automation: object, time_zone: string) => t.app.inject({ method: 'PUT', url: '/projects/p1/setup/automation', payload: { automation, time_zone } });
      expect((await send({ ...t.data().automation, summary_hour: 8 }, 'America/Sao_Paulo')).statusCode).toBe(200);
      expect(t.setTimeZone).toHaveBeenCalledWith('u1', 'America/Sao_Paulo');
      expect((await send({ ...t.data().automation, summary_hour: 9 }, 'Not/A_Zone')).statusCode).toBe(200);
      expect((await send({ ...t.data().automation, summary_hour: null }, 'Europe/Lisbon')).statusCode).toBe(200);
      expect(t.setTimeZone).toHaveBeenCalledTimes(1);
      expect(t.data().automation.summary_hour).toBeNull();
    });

        it('an invalid block is a 400 validation error', async () => {
      const r = await put(t.app, { ...t.data().automation, epic_branch_pattern: 'sem-ref' });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('automation on at merge', () => {
    beforeEach(async () => {
      t = await build({ automation: { enabled: true, autonomy: 'merge' } });
    });

    it('raising to deploy without a proof is 401 PIN_REQUIRED', async () => {
      const r = await put(t.app, { ...t.data().automation, autonomy: 'deploy' });
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toBe('PIN_REQUIRED');
      expect(t.save).not.toHaveBeenCalled();
    });

    it('raising to deploy with a good proof saves', async () => {
      const r = await put(t.app, { ...t.data().automation, autonomy: 'deploy' }, { challenge: 'c1', pin_proof: 'good' });
      expect(r.statusCode).toBe(200);
      expect(r.json().automation.autonomy).toBe('deploy');
    });

    it('lowering the level and turning off never ask', async () => {
      expect((await put(t.app, { ...t.data().automation, autonomy: 'pr' })).statusCode).toBe(200);
      expect((await put(t.app, { ...t.data().automation, enabled: false })).statusCode).toBe(200);
      expect(t.session.consumeDecisionChallenge).not.toHaveBeenCalled();
    });
  });

  describe('PUT /tasks/:id/auto', () => {
    beforeEach(async () => {
      t = await build();
    });
    it('tags a card without a PIN', async () => {
      // the card is looked up through the scope: a task row in the project of the caller
      const r = await t.app.inject({ method: 'PUT', url: '/tasks/t1/auto', payload: { auto: true } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ id: 't1', auto: true });
      expect(t.setAuto).toHaveBeenCalledWith('t1', true);
    });
  });
});

describe('mobile pause routes', () => {
  async function buildPause() {
    const pauseUser = vi.fn(async (_id: string, at: Date) => ({ paused_at: at, fresh: false }));
    const resumeUser = vi.fn(async () => false);
    const repos = {
      projects: { list: vi.fn(async () => []) },
      automationPauses: { pauseUser, resumeUser, userPausedAt: vi.fn(async () => null), pausedProjects: vi.fn(async () => []) },
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
    await app.register((a) => mobileAutomationPauseRoutes(a, repos), { prefix: '/automation' });
    await app.ready();
    return { app, actions, pauseUser, resumeUser };
  }

  it('reads the state, pauses everything and resumes with no PIN proof, needing projects:update', async () => {
    const { app, actions, pauseUser, resumeUser } = await buildPause();
    expect(actions['POST /automation/pause']).toBe('update');
    expect(actions['POST /automation/resume']).toBe('update');
    expect((await app.inject({ method: 'GET', url: '/automation/state' })).json()).toEqual({ paused_at: null, projects: [], has_automation: false, can_update: false });
    const paused = await app.inject({ method: 'POST', url: '/automation/pause', payload: { scope: 'all' } });
    expect(paused.statusCode).toBe(200);
    expect(pauseUser).toHaveBeenCalledWith('u1', expect.any(Date));
    expect((await app.inject({ method: 'POST', url: '/automation/resume', payload: { scope: 'all' } })).statusCode).toBe(204);
    expect(resumeUser).toHaveBeenCalledWith('u1');
    await app.close();
  });
});
