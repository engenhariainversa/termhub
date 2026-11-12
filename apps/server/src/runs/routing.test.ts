import { CAPABILITY_RUN_HEADLESS } from '@termhub/agent-protocol';
import { describe, expect, it } from 'vitest';
import type { AiAccount, Machine } from '../db/repositories/types.js';
import { routeRun, type RoutingDeps } from './routing.js';

export const NOW = new Date('2026-11-12T12:00:00.000Z');

export function machine(id: string, over: Partial<Machine> = {}): Machine {
  return { id, name: id, type: 'agent', owner_id: 'u1', ...over } as Machine;
}

export function account(id: string, machineId: string, over: Partial<AiAccount> = {}): AiAccount {
  return { id, label: `L-${id}`, provider: 'claude', machine_id: machineId, config_dir: null, exclusive_project: null, login_expires_at: null, created_at: NOW.toISOString(), ...over };
}

interface World {
  order: string[];
  accounts: AiAccount[];
  machines: Machine[];
  links: Array<{ machine_id: string; cwd: string }>;
  online?: string[];
  outdated?: string[];
  exhausted?: string[];
  peaks?: Record<string, number | null>;
}

export function fakeRoutingDeps(w: World): RoutingDeps {
  const machines = new Map(w.machines.map((m) => [m.id, m]));
  const online = new Set(w.online ?? w.machines.map((m) => m.id));
  return {
    repos: {
      projectSetup: { get: async () => ({ data: { ai: { accounts: w.order, models: { claude: null, chatgpt: null } } } }) },
      // Like the real list: only accounts on machines the owner holds.
      aiAccounts: { list: async (owner: string | null) => w.accounts.filter((a) => machines.get(a.machine_id)?.owner_id === owner) },
      aiAccountExhaustions: { activeIds: async () => new Set(w.exhausted ?? []) },
      machines: { findById: async (id: string) => machines.get(id) },
      projectMachines: { listByProject: async () => w.links.map((l, i) => ({ id: `pm${i}`, project_id: 'p1', position: i, created_at: '', ...l })) },
    } as unknown as RoutingDeps['repos'],
    agents: {
      isOnline: (id) => online.has(id),
      capabilities: (id) => (online.has(id) ? ((w.outdated ?? []).includes(id) ? ['worktree'] : [CAPABILITY_RUN_HEADLESS]) : null),
    },
    usage: async (a) => w.peaks?.[a.id] ?? null,
    now: () => NOW,
  };
}

const m1 = machine('m1');
const m2 = machine('m2');
const base = { userId: 'u1', projectId: 'p1' };

describe('routeRun', () => {
  it('keeps the Setup order', async () => {
    const deps = fakeRoutingDeps({ order: ['a2', 'a1'], accounts: [account('a1', 'm1'), account('a2', 'm2')], machines: [m1, m2], links: [{ machine_id: 'm1', cwd: '/p' }, { machine_id: 'm2', cwd: '/q' }] });
    const r = await routeRun(deps, base);
    expect(r.candidates.map((c) => [c.account.id, c.machine.id, c.cwd])).toEqual([
      ['a2', 'm2', '/q'],
      ['a1', 'm1', '/p'],
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("never uses an account on another person's machine", async () => {
    const theirs = machine('m9', { owner_id: 'u2' });
    const deps = fakeRoutingDeps({ order: ['a9', 'a1'], accounts: [account('a9', 'm9'), account('a1', 'm1')], machines: [m1, theirs], links: [{ machine_id: 'm1', cwd: '/p' }, { machine_id: 'm9', cwd: '/x' }] });
    const r = await routeRun(deps, base);
    expect(r.candidates.map((c) => c.account.id)).toEqual(['a1']);
    expect(r.skipped).toEqual([]);
  });

  it('skips with a reason: offline, outdated agent, not linked, exhausted, usage peak, not an agent machine', async () => {
    const ssh = machine('m6', { type: 'ssh' } as Partial<Machine>);
    const machines = [m1, m2, machine('m3'), machine('m4'), machine('m5'), ssh];
    const deps = fakeRoutingDeps({
      order: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
      accounts: [account('a1', 'm1'), account('a2', 'm2'), account('a3', 'm3'), account('a4', 'm4'), account('a5', 'm5'), account('a6', 'm6')],
      machines,
      links: ['m1', 'm2', 'm4', 'm5', 'm6'].map((id) => ({ machine_id: id, cwd: '/p' })),
      online: ['m2', 'm3', 'm4', 'm5', 'm6'],
      outdated: ['m2'],
      exhausted: ['a4'],
      peaks: { a5: 90 },
    });
    const r = await routeRun(deps, base);
    expect(r.candidates).toEqual([]);
    expect(r.skipped.map((s) => [s.account, s.reason])).toEqual([
      ['L-a1', 'machine_offline'],
      ['L-a2', 'agent_outdated'],
      ['L-a3', 'machine_not_linked'],
      ['L-a4', 'exhausted'],
      ['L-a5', 'usage_peak'],
      ['L-a6', 'machine_not_agent'],
    ]);
  });

  it('skips a link whose folder is not absolute (an old `~/` link)', async () => {
    const deps = fakeRoutingDeps({ order: ['a1'], accounts: [account('a1', 'm1')], machines: [m1], links: [{ machine_id: 'm1', cwd: '~/proj' }] });
    expect((await routeRun(deps, base)).skipped).toEqual([{ account: 'L-a1', machine: 'm1', reason: 'folder_not_absolute' }]);
  });

  it('keeps an account just under the peak, and one with unknown usage', async () => {
    const deps = fakeRoutingDeps({ order: ['a1', 'a2'], accounts: [account('a1', 'm1'), account('a2', 'm1')], machines: [m1], links: [{ machine_id: 'm1', cwd: '/p' }], peaks: { a1: 89, a2: null } });
    expect((await routeRun(deps, base)).candidates.map((c) => c.account.id)).toEqual(['a1', 'a2']);
  });

  it("provider 'codex' keeps only chatgpt accounts", async () => {
    const deps = fakeRoutingDeps({ order: ['a1', 'a2'], accounts: [account('a1', 'm1'), account('a2', 'm1', { provider: 'chatgpt' })], machines: [m1], links: [{ machine_id: 'm1', cwd: '/p' }] });
    const r = await routeRun(deps, { ...base, provider: 'codex' });
    expect(r.candidates.map((c) => [c.account.id, c.provider])).toEqual([['a2', 'codex']]);
  });

  it('an explicit model pins its provider', async () => {
    const deps = fakeRoutingDeps({ order: ['a1', 'a2'], accounts: [account('a1', 'm1'), account('a2', 'm1', { provider: 'chatgpt' })], machines: [m1], links: [{ machine_id: 'm1', cwd: '/p' }] });
    expect((await routeRun(deps, { ...base, model: 'gpt-5.5' })).candidates.map((c) => c.account.id)).toEqual(['a2']);
    expect((await routeRun(deps, { ...base, model: 'opus' })).candidates.map((c) => c.account.id)).toEqual(['a1']);
  });

  it('a pinned machine (id or name) keeps only its accounts', async () => {
    const named = machine('m2', { name: 'hulk' });
    const deps = fakeRoutingDeps({ order: ['a1', 'a2'], accounts: [account('a1', 'm1'), account('a2', 'm2')], machines: [m1, named], links: [{ machine_id: 'm1', cwd: '/p' }, { machine_id: 'm2', cwd: '/q' }] });
    expect((await routeRun(deps, { ...base, machine: 'hulk' })).candidates.map((c) => c.account.id)).toEqual(['a2']);
    expect((await routeRun(deps, { ...base, machine: 'm1' })).candidates.map((c) => c.account.id)).toEqual(['a1']);
  });

  it('leaves out Gemini accounts and accounts exclusive to another project', async () => {
    const deps = fakeRoutingDeps({
      order: ['a1', 'a2', 'a3'],
      accounts: [account('a1', 'm1', { provider: 'gemini' }), account('a2', 'm1', { exclusive_project: { id: 'p2', name: 'Outro' } }), account('a3', 'm1')],
      machines: [m1],
      links: [{ machine_id: 'm1', cwd: '/p' }],
    });
    const r = await routeRun(deps, base);
    expect(r.candidates.map((c) => c.account.id)).toEqual(['a3']);
    expect(r.skipped).toEqual([{ account: 'L-a2', machine: 'm1', reason: 'exclusive' }]);
  });

  it('a login about to expire goes last', async () => {
    const soon = new Date(NOW.getTime() + 24 * 3600_000).toISOString();
    const deps = fakeRoutingDeps({ order: ['a1', 'a2'], accounts: [account('a1', 'm1', { login_expires_at: soon }), account('a2', 'm1')], machines: [m1], links: [{ machine_id: 'm1', cwd: '/p' }] });
    expect((await routeRun(deps, base)).candidates.map((c) => c.account.id)).toEqual(['a2', 'a1']);
  });

  it('an empty Setup routes nowhere', async () => {
    const deps = fakeRoutingDeps({ order: [], accounts: [account('a1', 'm1')], machines: [m1], links: [{ machine_id: 'm1', cwd: '/p' }] });
    expect(await routeRun(deps, base)).toMatchObject({ candidates: [], skipped: [] });
  });
});
