import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionForMethod } from '../auth/permissions.js';
import type { Machine } from '../db/repositories/types.js';
import { applyErrorHandler, HttpError } from '../lib/errors.js';

const installMachineHooksOn = vi.fn(async (..._a: unknown[]) => ({
  report: { hooks_url: 'https://termhub.example/hooks', claude: 'installed', codex: 'absent', cursor: 'absent', claude_dirs: [] },
  installed_at: '2026-10-20T12:00:00.000Z',
}));
vi.mock('../monitor/machine-hooks.js', () => ({ installMachineHooksOn: (...a: unknown[]) => installMachineHooksOn(...a) }));

const { mobileMachineRoutes } = await import('./m-machines.js');

const user = { id: 'u1', email: 'ana@example.com', name: 'Ana' };
const machine = { id: 'm1', name: 'box', type: 'agent', owner_id: 'u1' } as Machine;
const foreign = { id: 'm2', name: 'other', type: 'agent', owner_id: 'u2' } as Machine;

function build(grants: string[] = ['machines:update']) {
  const granted = new Set(grants);
  const repos = { machines: { findById: vi.fn(async (id: string) => [machine, foreign].find((m) => m.id === id)) } };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    const cfg = req.routeOptions.config as { resource?: string; action?: string };
    if (cfg.resource && !granted.has(`${cfg.resource}:${cfg.action}`)) throw new HttpError(403, `Sem permissão: ${cfg.resource}:${cfg.action}`, 'FORBIDDEN');
  });
  app.register(
    async (a) => {
      a.addHook('onRoute', (route) => {
        const cfg = (route.config ?? {}) as { action?: string };
        route.config = { ...cfg, resource: 'machines', action: cfg.action ?? actionForMethod(String(route.method)) } as never;
      });
      await mobileMachineRoutes(a, repos as never);
    },
    { prefix: '/machines' },
  );
  return { app };
}

afterEach(() => vi.clearAllMocks());

describe('POST /machines/:id/hooks (TER-1091)', () => {
  it('installs the hooks on a machine of the scope and answers when', async () => {
    const res = await build().app.inject({ method: 'POST', url: '/machines/m1/hooks' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ installed_at: '2026-10-20T12:00:00.000Z' });
    expect(installMachineHooksOn).toHaveBeenCalledWith(expect.anything(), machine);
  });

  it('a machine outside the scope answers 404 and installs nothing', async () => {
    const res = await build().app.inject({ method: 'POST', url: '/machines/m2/hooks' });
    expect(res.statusCode).toBe(404);
    expect(installMachineHooksOn).not.toHaveBeenCalled();
  });

  it('needs machines:update', async () => {
    const res = await build(['machines:read']).app.inject({ method: 'POST', url: '/machines/m1/hooks' });
    expect(res.statusCode).toBe(403);
  });

  it('a failure of the machine answers 409 with its message; an agent error keeps its status', async () => {
    installMachineHooksOn.mockRejectedValueOnce(new Error('settings.json ilegível'));
    expect((await build().app.inject({ method: 'POST', url: '/machines/m1/hooks' })).statusCode).toBe(409);
    installMachineHooksOn.mockRejectedValueOnce(new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE'));
    expect((await build().app.inject({ method: 'POST', url: '/machines/m1/hooks' })).statusCode).toBe(503);
  });
});
