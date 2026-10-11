import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import { setAccountExclusive } from './account-exclusive.js';
import type { ControlContext, ControlToken } from './context.js';
import { listAiAccounts } from './inventory.js';

const DRH = { id: 'p9', name: 'DR Horton' };

function world(exclusive: { id: string; name: string } | null = null, token?: ControlToken) {
  let account: AiAccount = { id: 'a1', provider: 'claude', label: 'drhorton', machine_id: 'm1', config_dir: '~/.claude-drh', exclusive_project: exclusive, created_at: '' };
  const projects = [{ id: 'p9', name: 'DR Horton', owner_id: 'u1' }, { id: 'p1', name: 'termhub', owner_id: 'u1' }, { id: 'px', name: 'other', owner_id: 'u2' }];
  const insert = vi.fn(async (e: object) => ({ ...e, id: 'e1', created_at: '' }));
  const repos = {
    aiAccounts: {
      findById: vi.fn(async (id: string) => (id === account.id ? account : undefined)),
      list: vi.fn(async () => [account]),
      update: vi.fn(async (_id: string, patch: { exclusive_project_id?: string | null }) => {
        const p = projects.find((x) => x.id === patch.exclusive_project_id);
        account = { ...account, exclusive_project: p ? { id: p.id, name: p.name } : null };
        return account;
      }),
    },
    machines: { findById: vi.fn(async (id: string) => (id === 'm1' ? { id, name: 'jarvis', owner_id: 'u1' } : undefined)), list: vi.fn(async () => [{ id: 'm1', name: 'jarvis', owner_id: 'u1' }]) },
    projects: { findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)) },
    automationEvents: { insert },
  };
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  const log = { info: vi.fn(), warn: vi.fn() };
  const ctx: ControlContext = { repos: repos as unknown as Repositories, scope, scoped: new Scoped(repos as unknown as Repositories, scope), can: async () => true, token, log };
  return { ctx, repos, insert, log, current: () => account };
}

describe('setAccountExclusive (TER-990)', () => {
  it('over MCP, says what would change and changes nothing without confirm', async () => {
    const w = world(null, { id: 't', scopes: ['terminals'] });
    await expect(setAccountExclusive(w.ctx, { account_id: 'a1', project_id: 'p9' }, 'mcp')).rejects.toMatchObject({
      code: 'CONFIRM_REQUIRED',
      message: 'Isso deixa a conta "drhorton" exclusiva do projeto DR Horton: nenhum outro projeto poderá usá-la; repita com confirm: true para confirmar',
    });
    expect(w.repos.aiAccounts.update).not.toHaveBeenCalled();
  });

  it('with confirm, marks it and audits the change on the project', async () => {
    const w = world(null, { id: 't', scopes: ['terminals'] });
    const r = await setAccountExclusive(w.ctx, { account_id: 'a1', project_id: 'p9', confirm: true }, 'mcp');
    expect(r).toEqual({ changed: true, account: { id: 'a1', label: 'drhorton', provider: 'claude', machine_id: 'm1', exclusive_project: DRH } });
    expect(w.insert).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p9', kind: 'account_exclusive_changed', payload: { account_id: 'a1', from_project_id: null, to_project_id: 'p9', via: 'mcp' } }));
    expect(w.log.info).toHaveBeenCalledWith({ accountId: 'a1', from: null, to: 'p9', via: 'mcp' }, 'exclusive account: changed');
  });

  it('freeing it audits on the project it left; moving it audits on both', async () => {
    const w = world(DRH);
    await setAccountExclusive(w.ctx, { account_id: 'a1', project_id: 'p1' }, 'web');
    expect(w.insert.mock.calls.map(([e]) => (e as { project_id: string }).project_id)).toEqual(['p9', 'p1']);
    w.insert.mockClear();
    await setAccountExclusive(w.ctx, { account_id: 'a1', project_id: null }, 'web');
    expect(w.insert).toHaveBeenCalledTimes(1);
    expect(w.insert).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', payload: expect.objectContaining({ from_project_id: 'p1', to_project_id: null }) }));
    expect(w.current().exclusive_project).toBeNull();
  });

  it('no change is no write and no event', async () => {
    const w = world(DRH);
    expect((await setAccountExclusive(w.ctx, { account_id: 'a1', project_id: 'p9' }, 'web')).changed).toBe(false);
    expect(w.repos.aiAccounts.update).not.toHaveBeenCalled();
    expect(w.insert).not.toHaveBeenCalled();
  });

  it('refuses an agent tab, even confirmed: it could hand the account to its own project', async () => {
    const w = world(DRH, { id: 't', scopes: ['terminals'], tab: { id: 'tab1', project_id: 'p1' } });
    await expect(setAccountExclusive(w.ctx, { account_id: 'a1', project_id: 'p1', confirm: true }, 'mcp')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(w.repos.aiAccounts.update).not.toHaveBeenCalled();
  });

  it('a project outside the scope is not found', async () => {
    const w = world();
    await expect(setAccountExclusive(w.ctx, { account_id: 'a1', project_id: 'px' }, 'web')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('list_ai_accounts shows the exclusive project (TER-990)', () => {
  it('as exclusive_project, null for a free account', async () => {
    const w = world(DRH);
    const { accounts } = await listAiAccounts(w.ctx, {});
    expect(accounts).toEqual([expect.objectContaining({ id: 'a1', exclusive_project: DRH })]);
    const free = world();
    expect((await listAiAccounts(free.ctx, {})).accounts[0].exclusive_project).toBeNull();
  });
});
