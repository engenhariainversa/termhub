import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Project, ProjectMachine } from '../db/repositories/types.js';
import { normalizeSetup } from '../setup/schema.js';
import { noteWaiting, placeRun, resetWaiting, WAITING_TTL_MS, waitingReasonOf } from './placement.js';

const reg = vi.hoisted(() => ({ online: new Map<string, string[]>() }));
vi.mock('../agent/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../agent/registry.js')>();
  return { ...real, agents: { isOnline: (id: string) => reg.online.has(id), capabilities: (id: string) => reg.online.get(id) ?? null } };
});

const project = { id: 'p1', owner_id: 'u1' } as Project;
const machine = (id: string, allowed = true): Machine => ({ id, type: 'agent', owner_id: 'u1', capabilities: ['claude'], agent_version: '0.18.0', automation_allowed: allowed }) as Machine;
const account = (id: string, machineId: string, provider: AiAccount['provider'] = 'claude'): AiAccount => ({ id, provider, label: id, machine_id: machineId, config_dir: null, created_at: '' });

function fakeRepos(i: { machines: Machine[]; accounts: AiAccount[]; exhausted?: string[] }) {
  const links: ProjectMachine[] = i.machines.map((m, n) => ({ id: `l${n}`, project_id: 'p1', machine_id: m.id, cwd: `/code/${m.id}`, position: n, created_at: '' }));
  return {
    projectMachines: { listByProject: async () => links },
    machines: { findById: async (id: string) => i.machines.find((m) => m.id === id) },
    aiAccounts: { list: async () => i.accounts },
    aiAccountExhaustions: { activeIds: async () => new Set(i.exhausted ?? []) },
  } as unknown as Repositories;
}

const setup = (accounts: string[]) => normalizeSetup({ ai: { accounts, models: {} } }, 2);

describe('placeRun', () => {
  beforeEach(() => {
    reg.online.clear();
  });

  it('takes the first account of the project list, in its order, on an online machine with worktree', async () => {
    reg.online.set('m1', ['worktree']).set('m2', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1'), machine('m2')], accounts: [account('a1', 'm1'), account('a2', 'm2')] });
    const p = await placeRun({ repos, now: () => new Date(), usage: async () => 10 }, project, setup(['a2', 'a1']));
    expect(p).toMatchObject({ machine: { id: 'm2' }, account: { id: 'a2' }, link: { cwd: '/code/m2' } });
  });

  it('skips exhausted accounts and those at or above the swap threshold; unknown usage is room', async () => {
    reg.online.set('m1', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1')], accounts: [account('a1', 'm1'), account('a2', 'm1'), account('a3', 'm1')], exhausted: ['a1'] });
    const usage = vi.fn(async (id: string) => (id === 'a2' ? 80 : null));
    const p = await placeRun({ repos, now: () => new Date(), usage }, project, setup(['a1', 'a2', 'a3']));
    expect(p).toMatchObject({ account: { id: 'a3' } });
    expect(usage).not.toHaveBeenCalledWith('a1');
  });

  it('R6: only machines that accept automatic work; none → automation_not_allowed (nothing read)', async () => {
    reg.online.set('m1', ['worktree']).set('m2', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1', false), machine('m2')], accounts: [account('a1', 'm1'), account('a2', 'm2')] });
    const usage = vi.fn(async () => 10);
    expect(await placeRun({ repos, now: () => new Date(), usage }, project, setup(['a1', 'a2']))).toMatchObject({ machine: { id: 'm2' } });
    const off = fakeRepos({ machines: [machine('m1', false)], accounts: [account('a1', 'm1')] });
    const room = vi.fn(async () => true);
    usage.mockClear();
    expect(await placeRun({ repos: off, now: () => new Date(), usage, room }, project, setup(['a1']))).toEqual({ waiting: 'automation_not_allowed' });
    expect(usage).not.toHaveBeenCalled();
    expect(room).not.toHaveBeenCalled();
  });

  it('R6: 80 % is the automatic ceiling for an account', async () => {
    reg.online.set('m1', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1')], accounts: [account('a1', 'm1')] });
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 79 }, project, setup(['a1']))).toMatchObject({ account: { id: 'a1' } });
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 80 }, project, setup(['a1']))).toEqual({ waiting: 'no_account' });
  });

  it('R6: a machine without room is skipped for the next one; all crowded → no_room; the room is read once per machine', async () => {
    reg.online.set('m1', ['worktree']).set('m2', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1'), machine('m2')], accounts: [account('a1', 'm1'), account('a2', 'm1'), account('a3', 'm2')] });
    const room = vi.fn(async (m: Machine) => m.id === 'm2');
    const deps = { repos, now: () => new Date(), usage: async () => 10, room };
    expect(await placeRun(deps, project, setup(['a1', 'a2', 'a3']))).toMatchObject({ machine: { id: 'm2' }, account: { id: 'a3' } });
    expect(room.mock.calls.filter(([m]) => m.id === 'm1')).toHaveLength(1);
    expect(await placeRun({ ...deps, room: async () => false }, project, setup(['a1', 'a3']))).toEqual({ waiting: 'no_room' });
  });

  it('R6: one start per machine and per account per tick; all taken → later', async () => {
    reg.online.set('m1', ['worktree']).set('m2', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1'), machine('m2')], accounts: [account('a1', 'm1'), account('a2', 'm2')] });
    const deps = { repos, now: () => new Date(), usage: async () => 10 };
    const tick = { machines: new Set(['m1']), accounts: new Set<string>() };
    expect(await placeRun(deps, project, setup(['a1', 'a2']), tick)).toMatchObject({ account: { id: 'a2' } });
    expect(await placeRun(deps, project, setup(['a1']), tick)).toEqual({ waiting: 'later' });
    expect(await placeRun(deps, project, setup(['a2']), { machines: new Set(), accounts: new Set(['a2']) })).toEqual({ waiting: 'later' });
  });

  it('never starts on a full account: all full → no_account', async () => {
    reg.online.set('m1', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1')], accounts: [account('a1', 'm1')] });
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 99 }, project, setup(['a1']))).toEqual({ waiting: 'no_account' });
  });

  it('only Claude accounts of the project list count', async () => {
    reg.online.set('m1', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1')], accounts: [account('c1', 'm1', 'chatgpt'), account('a9', 'm1')] });
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup(['c1']))).toEqual({ waiting: 'no_account' });
  });

  it('no online machine with the worktree capability → no_machine; a capable one that is offline → machine_offline', async () => {
    const old = { ...machine('m1'), agent_version: '0.17.0' };
    const repos = fakeRepos({ machines: [old], accounts: [account('a1', 'm1')] });
    reg.online.set('m1', ['other']);
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup(['a1']))).toEqual({ waiting: 'no_machine' });
    reg.online.clear();
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup(['a1']))).toEqual({ waiting: 'no_machine' });
    const current = fakeRepos({ machines: [machine('m1')], accounts: [account('a1', 'm1')] });
    expect(await placeRun({ repos: current, now: () => new Date(), usage: async () => 0 }, project, setup(['a1']))).toEqual({ waiting: 'machine_offline' });
  });

  it('ssh/local machines, machines of someone else and machines without Claude are never chosen', async () => {
    reg.online.set('s', ['worktree']).set('o', ['worktree']).set('n', ['worktree']);
    const repos = fakeRepos({
      machines: [{ ...machine('s'), type: 'ssh' }, { ...machine('o'), owner_id: 'u2' }, { ...machine('n'), capabilities: [] }],
      accounts: [account('a1', 's'), account('a2', 'o'), account('a3', 'n')],
    });
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup(['a1', 'a2', 'a3']))).toEqual({ waiting: 'no_machine' });
  });
});

describe('waiting reasons', () => {
  beforeEach(() => resetWaiting());

  it('are kept for a while, then forgotten', () => {
    const t0 = new Date('2026-10-05T10:00:00Z');
    noteWaiting('t1', 'no_account', t0);
    expect(waitingReasonOf('t1', new Date(t0.getTime() + WAITING_TTL_MS))).toBe('no_account');
    expect(waitingReasonOf('t1', new Date(t0.getTime() + WAITING_TTL_MS + 1))).toBeNull();
    expect(waitingReasonOf('t1', t0)).toBeNull();
  });
});
