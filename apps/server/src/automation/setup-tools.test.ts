import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import { setupSchema, type ProjectSetupData } from '../setup/schema.js';
import { setAutomationPolicy, setMachineAutomation } from './setup-tools.js';

let stored: ProjectSetupData;
let allowed: boolean;

function ctx(token?: { gated: boolean }, approval?: { actionId: string; approvedAt: Date }) {
  const repos = {
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? { id: 'p1', owner_id: 'u1', name: 'termhub' } : id === 'px' ? { id: 'px', owner_id: 'u2' } : undefined)) },
    projectSetup: {
      get: vi.fn(async (id: string) => ({ project_id: id, version: 1, data: stored, updated_at: null })),
      save: vi.fn(async (id: string, data: ProjectSetupData) => {
        stored = data;
        return { project_id: id, version: 1, data, updated_at: '' };
      }),
    },
    machines: {
      findById: vi.fn(async (id: string) => (id === 'm1' ? { id: 'm1', owner_id: 'u1', name: 'hulk', automation_allowed: allowed } : undefined)),
      setAutomationAllowed: vi.fn(async (_id: string, v: boolean) => {
        allowed = v;
      }),
    },
    projectMachines: { listByMachine: vi.fn(async () => [{ project_id: 'p1' }, { project_id: 'p2' }, { project_id: 'p1' }]) },
    automationEvents: { insert: vi.fn(async (e: object) => ({ id: 'ev', created_at: '', ...e })) },
  };
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  const c = {
    repos: repos as unknown as Repositories,
    scope,
    scoped: new Scoped(repos as unknown as Repositories, scope),
    can: async () => true,
    ...(token ? { token: { id: 't', scopes: [], ...token } } : {}),
    ...(approval ? { approval } : {}),
  } as ControlContext;
  return { c, repos };
}

const chat = { gated: true };
const approved = { actionId: 'a1', approvedAt: new Date() };

beforeEach(() => {
  stored = setupSchema.parse({});
  allowed = false;
});

describe('set_automation_policy', () => {
  it('without fields it only reads: the patch fields, the policy text, nothing saved or logged', async () => {
    const { c, repos } = ctx(chat);
    const r = await setAutomationPolicy(c, { project_id: 'p1' });
    expect(r).toMatchObject({ project_id: 'p1', automation: { enabled: false, autonomy: 'pr', max_parallel: null }, changed: [] });
    expect(typeof r.text).toBe('string');
    expect(repos.projectSetup.save).not.toHaveBeenCalled();
    expect(repos.automationEvents.insert).not.toHaveBeenCalled();
  });

  it('on the concierge token, turning on without an approved card is refused and nothing changes', async () => {
    const { c, repos } = ctx(chat);
    await expect(setAutomationPolicy(c, { project_id: 'p1', enabled: true })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(setAutomationPolicy(c, { project_id: 'p1', autonomy: 'merge' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(repos.projectSetup.save).not.toHaveBeenCalled();
    expect(repos.automationEvents.insert).not.toHaveBeenCalled();
  });

  it('with the approved card it turns on, keeps the rest of the Setup and logs automation_on from the chat', async () => {
    stored = setupSchema.parse({ automation: { types: ['bug'], summary_hour: 18 } });
    const { c, repos } = ctx(chat, approved);
    const r = await setAutomationPolicy(c, { project_id: 'p1', enabled: true, autonomy: 'deploy', max_parallel: 2, required_checks: ['CI e Deploy'] });
    expect(r.changed).toEqual(['enabled', 'autonomy', 'required_checks', 'max_parallel']);
    expect(stored.automation).toMatchObject({ enabled: true, autonomy: 'deploy', max_parallel: 2, required_checks: ['CI e Deploy'], types: ['bug'], summary_hour: 18 });
    expect(repos.automationEvents.insert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'p1', kind: 'automation_on', payload: { via: 'chat', autonomy: 'deploy', from_autonomy: 'pr', max_parallel: 2, fields: 'enabled,autonomy,required_checks,max_parallel' } }),
    );
  });

  it('a brake needs no card: turning off, lowering the level and max_parallel, logged as automation_off', async () => {
    stored = setupSchema.parse({ automation: { enabled: true, autonomy: 'release', max_parallel: 4 } });
    const { c, repos } = ctx(chat);
    await setAutomationPolicy(c, { project_id: 'p1', enabled: false, autonomy: 'merge', max_parallel: 1 });
    expect(stored.automation).toMatchObject({ enabled: false, autonomy: 'merge', max_parallel: 1 });
    expect(repos.automationEvents.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'automation_off', payload: expect.objectContaining({ via: 'chat', from_autonomy: 'release' }) }));
  });

  it('a change with enabled untouched is setup_changed', async () => {
    stored = setupSchema.parse({ automation: { enabled: true, autonomy: 'release' } });
    const { c, repos } = ctx(chat);
    await setAutomationPolicy(c, { project_id: 'p1', autonomy: 'deploy' });
    expect(repos.automationEvents.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup_changed', payload: expect.objectContaining({ fields: 'autonomy' }) }));
  });

  it("a person's own MCP session changes it unmediated, logged with via mcp", async () => {
    const { c, repos } = ctx({ gated: false });
    await setAutomationPolicy(c, { project_id: 'p1', enabled: true, release_paths: ['apps/agent/package.json'] });
    expect(stored.automation).toMatchObject({ enabled: true, release_paths: ['apps/agent/package.json'] });
    expect(repos.automationEvents.insert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'automation_on', payload: expect.objectContaining({ via: 'mcp' }) }));
  });

  it('the same value again saves and logs nothing', async () => {
    stored = setupSchema.parse({ automation: { enabled: true } });
    const { c, repos } = ctx(chat);
    expect((await setAutomationPolicy(c, { project_id: 'p1', enabled: true })).changed).toEqual([]);
    expect(repos.projectSetup.save).not.toHaveBeenCalled();
  });

  it("another person's project is not found", async () => {
    const { c } = ctx({ gated: false });
    await expect(setAutomationPolicy(c, { project_id: 'px', enabled: false })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('set_machine_automation', () => {
  it('accepting on the concierge token needs the approved card', async () => {
    const { c, repos } = ctx(chat);
    await expect(setMachineAutomation(c, { machine_id: 'm1', accept: true })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(repos.machines.setAutomationAllowed).not.toHaveBeenCalled();
    const ok = ctx(chat, approved);
    expect(await setMachineAutomation(ok.c, { machine_id: 'm1', accept: true })).toEqual({ machine_id: 'm1', name: 'hulk', automation_allowed: true, changed: true });
    // one event per linked project, never twice for the same one
    expect(ok.repos.automationEvents.insert).toHaveBeenCalledTimes(2);
    expect(ok.repos.automationEvents.insert).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p2', kind: 'machine_opt_in', payload: { via: 'chat', machine_id: 'm1' } }));
  });

  it('refusing is a brake: no card needed, logged as machine_opt_out', async () => {
    allowed = true;
    const { c, repos } = ctx(chat);
    expect(await setMachineAutomation(c, { machine_id: 'm1', accept: false })).toMatchObject({ automation_allowed: false, changed: true });
    expect(repos.automationEvents.insert).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', kind: 'machine_opt_out' }));
  });

  it('the value it already has changes and logs nothing, even accepting without a card', async () => {
    allowed = true;
    const { c, repos } = ctx(chat);
    expect(await setMachineAutomation(c, { machine_id: 'm1', accept: true })).toMatchObject({ changed: false });
    expect(repos.automationEvents.insert).not.toHaveBeenCalled();
  });

  it("another person's machine is not found", async () => {
    const { c } = ctx({ gated: false });
    await expect(setMachineAutomation(c, { machine_id: 'mx', accept: false })).rejects.toMatchObject({ statusCode: 404 });
  });
});
