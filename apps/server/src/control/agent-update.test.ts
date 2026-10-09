import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The agent connections, faked: which agents are online and on which version, and what agent.update answers.
const online = new Map<string, string>();
const channels = new Map<string, number>();
const rpc = vi.fn();
vi.mock('../agent/registry.js', async (orig) => {
  const actual = await orig<typeof import('../agent/registry.js')>();
  return {
    ...actual,
    agents: {
      info: (id: string) => (online.has(id) ? { agent_version: online.get(id) } : null),
      isOnline: (id: string) => online.has(id),
      openChannels: (id: string) => channels.get(id) ?? 0,
      rpc: async (id: string, method: string, params: unknown) => {
        if (!online.has(id)) throw new actual.AgentOfflineError('offline');
        return rpc(id, method, params);
      },
    },
  };
});
const readHooksStatus = vi.fn();
vi.mock('../monitor/install.js', () => ({ readHooksStatus: (...a: unknown[]) => readHooksStatus(...a) }));
const installMachineHooksOn = vi.fn(async () => ({ report: {}, installed_at: '2026-10-09T12:00:00.000Z' }));
vi.mock('../monitor/machine-hooks.js', () => ({ claudeAccountDirs: async () => [], installMachineHooksOn: (...a: unknown[]) => installMachineHooksOn(...(a as [])) }));

import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { Scoped } from '../auth/scope.js';
import { resetFollows } from '../agent/after-update.js';
import { autoUpdateTick, resetAutoUpdateAttempts, resetUpdateRequests, setLatestAgentRelease } from '../agent/latest-version.js';
import { MIN_AGENT_VERSION } from '../agent/min-version.js';
import { ControlError, type ControlContext } from './context.js';
import { updateMachineAgent } from './agent-update.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const machines: Machine[] = [
  { id: 'm1', name: 'hulk', type: 'agent', owner_id: 'u1', agent_version: '0.19.0', agent_credential: 'bearer', agent_auto_update: false } as Machine,
  { id: 'm2', name: 'jarvis', type: 'agent', owner_id: 'u1', agent_version: '9.0.0', agent_credential: 'key', agent_auto_update: true } as Machine,
  { id: 'm3', name: 'notebook', type: 'agent', owner_id: 'u1', agent_version: '0.20.0', agent_credential: 'key', agent_auto_update: true } as Machine,
  { id: 'local', name: 'servidor', type: 'local', owner_id: 'u1' } as Machine,
  { id: 'mx', name: 'de outra pessoa', type: 'agent', owner_id: 'u2' } as Machine,
];
let hooksInstalled: Set<string>;

function ctxFor(opts: { gated?: boolean; approved?: boolean; chatHost?: string | null } = {}): ControlContext {
  const repos = {
    machines: {
      findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)),
      list: vi.fn(async (owner: string) => machines.filter((m) => m.owner_id === owner)),
    },
    machineHooks: { findByMachine: vi.fn(async (id: string) => (hooksInstalled.has(id) ? { machine_id: id, installed_at: '2026-10-01T00:00:00.000Z' } : undefined)) },
    chat: { findByIdForUser: vi.fn(async () => (opts.chatHost === undefined ? undefined : { id: 'c1', machine_id: opts.chatHost })) },
  } as unknown as Repositories;
  const scope = { user: { id: 'u1', locale: null } as never, viewAs: { kind: 'self' as const }, ownerId: 'u1', createAs: 'u1' };
  return {
    repos,
    scope,
    scoped: new Scoped(repos, scope),
    can: async () => true,
    token: opts.gated ? { id: 'tok', scopes: ['terminals'], gated: true, chat_conversation_id: 'c1' } : undefined,
    approval: opts.approved ? { actionId: 'a1', approvedAt: new Date() } : undefined,
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

/** The wait between reconnect checks: the agent comes back on the version it was told to install. */
const reconnects = { sleep: async () => { for (const [id, v] of installing) online.set(id, v); }, timeoutMs: 5_000 };
const installing = new Map<string, string>();

const status = (scriptOutdated: boolean) => ({
  script: { installed: true, version: 'old', expected_version: 'new', outdated: scriptOutdated },
  claude: { present: true, state: 'current', dirs: [] },
  codex: { present: false, state: 'missing' },
  cursor: { present: false, state: 'missing' },
});

beforeEach(() => {
  online.clear();
  channels.clear();
  installing.clear();
  hooksInstalled = new Set(['m1']);
  rpc.mockReset().mockImplementation(async (id: string, _method: string, params: { version: string }) => {
    installing.set(id, params.version);
    return { installed_version: params.version, restart: 'service' };
  });
  readHooksStatus.mockReset().mockResolvedValue(status(true));
  installMachineHooksOn.mockClear();
  setLatestAgentRelease({ version: '9.0.0', integrity: INTEGRITY });
});

afterEach(() => {
  setLatestAgentRelease(null);
  resetFollows();
  resetAutoUpdateAttempts();
  resetUpdateRequests();
});

describe('update_machine_agent', () => {
  it('updates one machine, waits for it to come back and answers the versions, the hooks refresh and the re-pairing hint', async () => {
    online.set('m1', '0.19.0');
    const r = await updateMachineAgent(ctxFor(), { machine_id: 'm1' }, reconnects);
    expect(rpc).toHaveBeenCalledWith('m1', 'agent.update', { version: '9.0.0', integrity: INTEGRITY });
    expect(r).toMatchObject({ latest_agent_version: '9.0.0', min_agent_version: MIN_AGENT_VERSION });
    expect(r.machines).toEqual([
      { machine_id: 'm1', name: 'hulk', status: 'updated', before: '0.19.0', after: '9.0.0', below_min_version: false, hooks: 'reinstalled', repair_suggested: true },
    ]);
    expect(installMachineHooksOn).toHaveBeenCalledTimes(1);
  });

  it('leaves current hooks alone and never installs hooks termhub did not put there', async () => {
    online.set('m1', '0.19.0');
    readHooksStatus.mockResolvedValue(status(false));
    expect((await updateMachineAgent(ctxFor(), { machine_id: 'm1' }, reconnects)).machines[0].hooks).toBe('current');
    hooksInstalled.clear();
    online.set('m1', '0.19.0');
    resetFollows();
    expect((await updateMachineAgent(ctxFor(), { machine_id: 'm1' }, reconnects)).machines[0].hooks).toBe('not_installed');
    expect(installMachineHooksOn).not.toHaveBeenCalled();
  });

  it('answers not_back when the agent does not return on the new version in time', async () => {
    online.set('m1', '0.19.0');
    const r = await updateMachineAgent(ctxFor(), { machine_id: 'm1' }, { sleep: async () => {}, timeoutMs: 0 });
    expect(r.machines[0]).toMatchObject({ status: 'not_back', after: '0.19.0', hooks: 'skipped', below_min_version: true });
  });

  it('all: every agent machine of the person, each with its own outcome', async () => {
    online.set('m1', '0.19.0');
    online.set('m2', '9.0.0');
    const r = await updateMachineAgent(ctxFor(), { all: true }, reconnects);
    expect(r.machines.map((m) => [m.machine_id, m.status])).toEqual([
      ['m1', 'updated'],
      ['m2', 'current'],
      ['m3', 'offline'],
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('reports a failed install without throwing, and an agent too old to update itself', async () => {
    online.set('m1', '0.19.0');
    online.set('m3', '0.2.0');
    rpc.mockRejectedValue(new Error('boom'));
    const r = await updateMachineAgent(ctxFor(), { all: true }, reconnects);
    expect(r.machines.find((m) => m.machine_id === 'm1')).toMatchObject({ status: 'failed', after: '0.19.0' });
    expect(r.machines.find((m) => m.machine_id === 'm3')).toMatchObject({ status: 'too_old' });
  });

  it('asks the person first on the concierge token, before anything runs', async () => {
    online.set('m1', '0.19.0');
    await expect(updateMachineAgent(ctxFor({ gated: true, chatHost: null }), { machine_id: 'm1' }, reconnects)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('queues the machine the chat runs on instead of cutting the conversation; the scheduler updates it once idle', async () => {
    online.set('m1', '0.19.0');
    online.set('m3', '0.20.0');
    channels.set('m1', 1);
    const r = await updateMachineAgent(ctxFor({ gated: true, approved: true, chatHost: 'm1' }), { all: true }, reconnects);
    expect(r.machines.find((m) => m.machine_id === 'm1')).toMatchObject({ status: 'scheduled' });
    expect(r.machines.find((m) => m.machine_id === 'm3')).toMatchObject({ status: 'updated' });
    expect(rpc).not.toHaveBeenCalledWith('m1', expect.anything(), expect.anything());

    // the answer is over: the chat's channel closed and the tick updates it
    channels.delete('m1');
    const tickRepos = { machines: { listAgentMachines: async () => [machines[0]] }, tabs: { countBusyByMachine: async () => 0 } } as unknown as Repositories;
    await autoUpdateTick(tickRepos, { info: vi.fn(), warn: vi.fn() });
    expect(rpc).toHaveBeenCalledWith('m1', 'agent.update', { version: '9.0.0', integrity: INTEGRITY });
  });

  it('takes exactly one of machine_id and all, an agent machine of the caller only', async () => {
    await expect(updateMachineAgent(ctxFor(), {}, reconnects)).rejects.toBeInstanceOf(ControlError);
    await expect(updateMachineAgent(ctxFor(), { machine_id: 'm1', all: true }, reconnects)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(updateMachineAgent(ctxFor(), { machine_id: 'local' }, reconnects)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(updateMachineAgent(ctxFor(), { machine_id: 'mx' }, reconnects)).rejects.toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses while the newest verified release is unknown', async () => {
    online.set('m1', '0.19.0');
    setLatestAgentRelease(null);
    await expect(updateMachineAgent(ctxFor(), { machine_id: 'm1' }, reconnects)).rejects.toMatchObject({ code: 'AGENT_LATEST_UNKNOWN' });
  });
});
