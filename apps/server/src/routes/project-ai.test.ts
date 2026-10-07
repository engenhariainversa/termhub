import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { normalizeSetup } from '../setup/schema.js';
import { projectAiRoutes } from './project-ai.js';

const machine = (id: string, owner_id = 'u1') => ({ id, name: `máquina ${id}`, owner_id, type: 'agent' });
const machines = [machine('m1'), machine('m2'), machine('m3'), machine('mx', 'u2')];
const acc = (id: string, machine_id: string, provider = 'claude', config_dir: string | null = null) => ({ id, label: `conta ${id}`, provider, machine_id, config_dir, exclusive_project: null as { id: string; name: string } | null, created_at: '' });
const accounts = [acc('a1', 'm1'), acc('a2', 'm1', 'claude', '~/.claude-2'), acc('c1', 'm2', 'chatgpt'), acc('g1', 'm1', 'gemini'), acc('u3', 'm3'), acc('ax', 'mx')];

function build() {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1', role: 'member' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  let stored = normalizeSetup({ runner: { worktree: false } }, 2);
  const save = vi.fn(async (_p: string, data: typeof stored) => {
    stored = data;
    return { project_id: 'p1', version: 2, data, updated_at: 'now' };
  });
  const repos = {
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id, owner_id: 'u1' } : undefined)) },
    projectMachines: {
      listByProject: vi.fn(async () => [{ project_id: 'p1', machine_id: 'm1' }, { project_id: 'p1', machine_id: 'm2' }]),
    },
    machines: { findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)) },
    aiAccounts: {
      findById: vi.fn(async (id: string) => accounts.find((a) => a.id === id)),
      list: vi.fn(async (owner: string) => accounts.filter((a) => machines.find((m) => m.id === a.machine_id)!.owner_id === owner)),
    },
    projectSetup: { get: vi.fn(async () => ({ project_id: 'p1', version: 2, data: stored, updated_at: null })), save },
  } as unknown as Repositories;
  app.register((a) => projectAiRoutes(a, repos), { prefix: '/projects' });
  return { app, save, stored: () => stored };
}

describe('project AI routes', () => {
  it('lists the Claude and Codex accounts of the linked machines only, with the stored block', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/projects/p1/setup/ai' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ai: { accounts: [], models: { claude: null, chatgpt: null } },
      available: [
        { id: 'a1', label: 'conta a1', provider: 'claude', machine_id: 'm1', machine_name: 'máquina m1', default: true, exclusive_project: null },
        { id: 'a2', label: 'conta a2', provider: 'claude', machine_id: 'm1', machine_name: 'máquina m1', default: false, exclusive_project: null },
        { id: 'c1', label: 'conta c1', provider: 'chatgpt', machine_id: 'm2', machine_name: 'máquina m2', default: true, exclusive_project: null },
      ],
    });
  });

  it('saves only the ai block, leaving the rest of the setup as it was', async () => {
    const { app, stored } = build();
    const ai = { accounts: ['a2', 'a1', 'c1'], models: { claude: 'opus', chatgpt: null } };
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup/ai', payload: { ai } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ai).toEqual(ai);
    expect(stored().ai).toEqual(ai);
    expect(stored().runner.worktree).toBe(false);
  });

  it.each([
    ['another owner', 'ax', 'Conta de IA inexistente: ax'],
    ['a deleted account', 'nope', 'Conta de IA inexistente: nope'],
    ['a machine not linked to the project', 'u3', 'A conta "conta u3" está na máquina máquina m3, que não está ligada ao projeto'],
    ['a provider no agent can start', 'g1', 'A conta "conta g1" é gemini: o projeto só usa contas do Claude e do Codex'],
  ])('refuses %s, saving nothing', async (_what, id, message) => {
    const { app, save } = build();
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup/ai', payload: { ai: { accounts: [id] } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(message);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a model the shell could read', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup/ai', payload: { ai: { models: { claude: 'opus;id' } } } });
    expect(res.statusCode).toBe(400);
  });

  it('404s a project out of scope', async () => {
    const { app } = build();
    expect((await app.inject({ method: 'GET', url: '/projects/px/setup/ai' })).statusCode).toBe(404);
  });
});

describe('project AI routes with an account exclusive to a project (TER-990)', () => {
  const a2 = accounts.find((a) => a.id === 'a2')! as { exclusive_project?: { id: string; name: string } | null };
  const withExclusive = async (fn: () => Promise<void>) => {
    a2.exclusive_project = { id: 'p9', name: 'DR Horton' };
    try {
      await fn();
    } finally {
      a2.exclusive_project = null;
    }
  };

  it('lists it with the project it is exclusive to, so the Setup shows it disabled', () =>
    withExclusive(async () => {
      const { app } = build();
      const res = await app.inject({ method: 'GET', url: '/projects/p1/setup/ai' });
      expect(res.json().available).toContainEqual(expect.objectContaining({ id: 'a2', exclusive_project: { id: 'p9', name: 'DR Horton' } }));
      expect(res.json().available).toContainEqual(expect.objectContaining({ id: 'a1', exclusive_project: null }));
    }));

  it('refuses to add it to another project, saving nothing', () =>
    withExclusive(async () => {
      const { app, save } = build();
      const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup/ai', payload: { ai: { accounts: ['a1', 'a2'] } } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Conta exclusiva do projeto DR Horton: "conta a2" não pode rodar em outro projeto');
      expect(save).not.toHaveBeenCalled();
    }));

  it('answers the refusal in English', () =>
    withExclusive(async () => {
      const { app } = build();
      const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup/ai', headers: { 'accept-language': 'en' }, payload: { ai: { accounts: ['a2'] } } });
      expect(res.json().error).toBe('Account exclusive to project DR Horton: "conta a2" cannot run in another project');
    }));

  it('drops it, saving the rest, when the project listed it from before it became exclusive', async () => {
    const { app, stored } = build();
    await app.inject({ method: 'PUT', url: '/projects/p1/setup/ai', payload: { ai: { accounts: ['a2', 'a1'] } } });
    await withExclusive(async () => {
      const res = await app.inject({ method: 'PUT', url: '/projects/p1/setup/ai', payload: { ai: { accounts: ['a2', 'a1'], models: { claude: 'opus' } } } });
      expect(res.statusCode).toBe(200);
      expect(stored().ai).toEqual({ accounts: ['a1'], models: { claude: 'opus', chatgpt: null } });
    });
  });
});
