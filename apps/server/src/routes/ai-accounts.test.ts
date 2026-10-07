import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { aiAccountRoutes } from './ai-accounts.js';

function build() {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1', role: 'member' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  const projects = [{ id: 'p9', name: 'DR Horton', owner_id: 'u1' }, { id: 'px', name: 'other', owner_id: 'u2' }];
  let account: AiAccount = { id: 'a1', provider: 'claude', label: 'drhorton', machine_id: 'm1', config_dir: null, exclusive_project: null, created_at: '' };
  const insert = vi.fn(async (e: object) => ({ ...e, id: 'e1', created_at: '' }));
  const repos = {
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? { id, name: 'jarvis', owner_id: 'u1' } : undefined)) },
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) },
    automationEvents: { insert },
    aiAccounts: {
      findById: vi.fn(async (id: string) => (id === account.id ? account : undefined)),
      list: vi.fn(async () => [account]),
      update: vi.fn(async (_id: string, patch: { label?: string; exclusive_project_id?: string | null }) => {
        const p = patch.exclusive_project_id === undefined ? undefined : projects.find((x) => x.id === patch.exclusive_project_id);
        account = { ...account, ...(patch.label ? { label: patch.label } : {}), ...(patch.exclusive_project_id === undefined ? {} : { exclusive_project: p ? { id: p.id, name: p.name } : null }) };
        return account;
      }),
    },
  } as unknown as Repositories;
  app.register((a) => aiAccountRoutes(a, repos), { prefix: '/ai-accounts' });
  return { app, insert, current: () => account };
}

describe('PATCH /ai-accounts/:id exclusive_project_id (TER-990)', () => {
  it('marks the account exclusive to a project, answers it with the project name and audits it', async () => {
    const { app, insert } = build();
    const res = await app.inject({ method: 'PATCH', url: '/ai-accounts/a1', payload: { exclusive_project_id: 'p9' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.exclusive_project).toEqual({ id: 'p9', name: 'DR Horton' });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p9', kind: 'account_exclusive_changed', payload: expect.objectContaining({ to_project_id: 'p9', via: 'web' }) }));
  });

  it('clears it with null, and leaves it alone when the field is absent', async () => {
    const { app, current } = build();
    await app.inject({ method: 'PATCH', url: '/ai-accounts/a1', payload: { exclusive_project_id: 'p9' } });
    await app.inject({ method: 'PATCH', url: '/ai-accounts/a1', payload: { label: 'D. R. Horton' } });
    expect(current().exclusive_project).toEqual({ id: 'p9', name: 'DR Horton' });
    await app.inject({ method: 'PATCH', url: '/ai-accounts/a1', payload: { exclusive_project_id: null } });
    expect(current().exclusive_project).toBeNull();
  });

  it("refuses a project outside the person's scope", async () => {
    const { app, current } = build();
    const res = await app.inject({ method: 'PATCH', url: '/ai-accounts/a1', payload: { exclusive_project_id: 'px' } });
    expect(res.statusCode).toBe(404);
    expect(current().exclusive_project).toBeNull();
  });
});
