import { describe, expect, it, vi } from 'vitest';
import { normalizeSetup } from '../setup/schema.js';
import type { ControlContext } from './context.js';
import { setChatAccount } from './chat-account.js';

function ctxFor(owner = 'u1') {
  const machines = [{ id: 'm1', name: 'jarvis', type: 'agent', owner_id: 'u1' }, { id: 'm2', name: 'hulk', type: 'agent', owner_id: 'u1' }];
  const accounts = [
    { id: 'a1', provider: 'claude', label: 'Claude', machine_id: 'm1', config_dir: null, exclusive_project: null },
    { id: 'a2', provider: 'claude', label: 'Claude', machine_id: 'm2', config_dir: null, exclusive_project: null },
  ];
  const setRunAccount = vi.fn(async () => undefined);
  const ctx = {
    scope: { user: { id: 'u1' }, ownerId: 'u1' },
    scoped: { project: vi.fn(async (id: string) => ({ project: { id, owner_id: owner, name: 'Opa' } })) },
    repos: {
      machines: { list: vi.fn(async () => machines) },
      aiAccounts: { list: vi.fn(async () => accounts) },
      projectSetup: { get: vi.fn(async () => ({ data: normalizeSetup({ ai: { accounts: ['a1', 'a2'], chat_machine_id: 'm1' } }, 2) })) },
      projectMachines: { listByProject: vi.fn(async () => [{ machine_id: 'm1' }, { machine_id: 'm2' }]) },
      chat: { getOrCreateForProject: vi.fn(async () => ({ id: 'c_p1' })), setRunAccount },
    },
  } as unknown as ControlContext;
  return { ctx, setRunAccount };
}

describe('set_chat_account (TER-1144)', () => {
  it("moves the project chat to one of the project's accounts, or back to the project's choice", async () => {
    const { ctx, setRunAccount } = ctxFor();
    const r = await setChatAccount(ctx, { project_id: 'p1', account_id: 'a2' });
    expect(setRunAccount).toHaveBeenCalledWith('c_p1', 'a2');
    expect(r).toMatchObject({ account: { id: 'a2', machine: 'hulk' }, concierge_machine: 'jarvis' });
    await setChatAccount(ctx, { project_id: 'p1', account_id: null });
    expect(setRunAccount).toHaveBeenLastCalledWith('c_p1', null);
  });

  it("refuses an account the project does not list, and someone else's project", async () => {
    const { ctx, setRunAccount } = ctxFor();
    await expect(setChatAccount(ctx, { project_id: 'p1', account_id: 'zz' })).rejects.toMatchObject({ code: 'CHAT_ACCOUNT_NOT_IN_PROJECT' });
    await expect(setChatAccount(ctxFor('u2').ctx, { project_id: 'p1', account_id: 'a1' })).rejects.toMatchObject({ statusCode: 404 });
    expect(setRunAccount).not.toHaveBeenCalled();
  });
});
