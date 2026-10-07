import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Project, ProjectMachine } from '../db/repositories/types.js';
import { normalizeSetup } from '../setup/schema.js';
import { noteWaiting, placeRun, resetWaiting, WAITING_TTL_MS, waitingOf, waitingReasonOf } from './placement.js';
import { placeDetailText } from './waiting-text.js';

const reg = vi.hoisted(() => ({ online: new Map<string, string[]>() }));
vi.mock('../agent/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../agent/registry.js')>();
  return { ...real, agents: { isOnline: (id: string) => reg.online.has(id), capabilities: (id: string) => reg.online.get(id) ?? null } };
});

const project = { id: 'p1', owner_id: 'u1' } as Project;
const machine = (id: string, allowed = true): Machine => ({ id, name: `name-${id}`, type: 'agent', owner_id: 'u1', capabilities: ['claude'], agent_version: '0.18.0', automation_allowed: allowed }) as Machine;
const account = (id: string, machineId: string, provider: AiAccount['provider'] = 'claude'): AiAccount => ({ id, provider, label: `label-${id}`, machine_id: machineId, config_dir: null, created_at: '' });

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
    expect(await placeRun({ repos: off, now: () => new Date(), usage, room }, project, setup(['a1']))).toMatchObject({ waiting: 'automation_not_allowed' });
    expect(usage).not.toHaveBeenCalled();
    expect(room).not.toHaveBeenCalled();
  });

  it('TER-990: never an account exclusive to another project, even listed first; the card says why', async () => {
    reg.online.set('m1', ['worktree']);
    const drh = { ...account('a1', 'm1'), exclusive_project: { id: 'p9', name: 'DR Horton' } };
    const repos = fakeRepos({ machines: [machine('m1')], accounts: [drh, account('a2', 'm1')] });
    const usage = vi.fn(async () => 10);
    expect(await placeRun({ repos, now: () => new Date(), usage }, project, setup(['a1', 'a2']))).toMatchObject({ account: { id: 'a2' } });
    expect(usage).not.toHaveBeenCalledWith('a1');
    const alone = await placeRun({ repos, now: () => new Date(), usage }, project, setup(['a1']));
    expect(alone).toMatchObject({ waiting: 'no_account', detail: { accounts: expect.arrayContaining([expect.objectContaining({ id: 'a1', why: 'exclusive' })]) } });
    expect(placeDetailText('pt-BR', (alone as { detail: Parameters<typeof placeDetailText>[1] }).detail)).toContain('conta label-a1 (name-m1): exclusiva de outro projeto');
    // in its own project it is the account
    expect(await placeRun({ repos, now: () => new Date(), usage }, { ...project, id: 'p9' }, setup(['a1']))).toMatchObject({ account: { id: 'a1' } });
  });

  it('R6: 80 % is the automatic ceiling for an account', async () => {
    reg.online.set('m1', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1')], accounts: [account('a1', 'm1')] });
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 79 }, project, setup(['a1']))).toMatchObject({ account: { id: 'a1' } });
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 80 }, project, setup(['a1']))).toMatchObject({ waiting: 'no_account' });
  });

  it('R6: a machine without room is skipped for the next one; all crowded → no_room; the room is read once per machine', async () => {
    reg.online.set('m1', ['worktree']).set('m2', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1'), machine('m2')], accounts: [account('a1', 'm1'), account('a2', 'm1'), account('a3', 'm2')] });
    const room = vi.fn(async (m: Machine) => m.id === 'm2');
    const deps = { repos, now: () => new Date(), usage: async () => 10, room };
    expect(await placeRun(deps, project, setup(['a1', 'a2', 'a3']))).toMatchObject({ machine: { id: 'm2' }, account: { id: 'a3' } });
    expect(room.mock.calls.filter(([m]) => m.id === 'm1')).toHaveLength(1);
    expect(await placeRun({ ...deps, room: async () => false }, project, setup(['a1', 'a3']))).toMatchObject({ waiting: 'no_room' });
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
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 99 }, project, setup(['a1']))).toMatchObject({ waiting: 'no_account' });
  });

  it('only Claude accounts of the project list count', async () => {
    reg.online.set('m1', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1')], accounts: [account('c1', 'm1', 'chatgpt'), account('a9', 'm1')] });
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup(['c1']))).toMatchObject({ waiting: 'no_account' });
  });

  it('no online machine with the worktree capability → no_machine; a capable one that is offline → machine_offline', async () => {
    const old = { ...machine('m1'), agent_version: '0.17.0' };
    const repos = fakeRepos({ machines: [old], accounts: [account('a1', 'm1')] });
    reg.online.set('m1', ['other']);
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup(['a1']))).toMatchObject({ waiting: 'no_machine' });
    reg.online.clear();
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup(['a1']))).toMatchObject({ waiting: 'no_machine' });
    const current = fakeRepos({ machines: [machine('m1')], accounts: [account('a1', 'm1')] });
    expect(await placeRun({ repos: current, now: () => new Date(), usage: async () => 0 }, project, setup(['a1']))).toMatchObject({ waiting: 'machine_offline' });
  });

  it('ssh/local machines, machines of someone else and machines without Claude are never chosen', async () => {
    reg.online.set('s', ['worktree']).set('o', ['worktree']).set('n', ['worktree']);
    const repos = fakeRepos({
      machines: [{ ...machine('s'), type: 'ssh' }, { ...machine('o'), owner_id: 'u2' }, { ...machine('n'), capabilities: [] }],
      accounts: [account('a1', 's'), account('a2', 'o'), account('a3', 'n')],
    });
    expect(await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup(['a1', 'a2', 'a3']))).toMatchObject({ waiting: 'no_machine' });
  });
});

describe('placeRun detail (TER-985)', () => {
  beforeEach(() => {
    reg.online.clear();
  });

  it('an empty project list names the Claude accounts of the usable machines as not listed, and the machines left out', async () => {
    // production on 2026-10-05: hulk online and allowed with two Claude accounts, jarvis opted out, list empty
    reg.online.set('hulk', ['worktree']).set('jarvis', ['worktree']);
    const repos = fakeRepos({
      machines: [machine('jarvis', false), machine('hulk')],
      accounts: [account('j1', 'jarvis'), account('h1', 'hulk'), account('h2', 'hulk'), account('cx', 'hulk', 'chatgpt')],
    });
    const p = await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup([]));
    expect(p).toEqual({
      waiting: 'no_account',
      detail: {
        listed: 0,
        machines: [{ id: 'jarvis', name: 'name-jarvis', why: 'not_allowed' }],
        accounts: [
          { id: 'h1', label: 'label-h1', machine: 'name-hulk', why: 'not_listed' },
          { id: 'h2', label: 'label-h2', machine: 'name-hulk', why: 'not_listed' },
        ],
      },
    });
  });

  it('names the exhausted and the busy accounts, with the peak', async () => {
    reg.online.set('m1', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1')], accounts: [account('a1', 'm1'), account('a2', 'm1')], exhausted: ['a1'] });
    const p = await placeRun({ repos, now: () => new Date(), usage: async () => 91.6 }, project, setup(['a1', 'a2']));
    expect(p).toMatchObject({
      waiting: 'no_account',
      detail: { listed: 2, machines: [], accounts: [{ id: 'a1', why: 'exhausted' }, { id: 'a2', why: 'busy', peak: 92 }] },
    });
  });

  it('names offline, old, Claude-less and ssh machines', async () => {
    reg.online.set('old', ['other']).set('bare', ['worktree']);
    const repos = fakeRepos({
      machines: [machine('off'), { ...machine('old'), agent_version: '0.17.0' }, { ...machine('bare'), capabilities: [] }, { ...machine('s'), type: 'ssh' }, { ...machine('x'), owner_id: 'u2' }],
      accounts: [account('a1', 'off')],
    });
    const p = await placeRun({ repos, now: () => new Date(), usage: async () => 0 }, project, setup(['a1']));
    expect(p).toEqual({
      waiting: 'machine_offline',
      detail: {
        listed: 1,
        machines: [
          { id: 'off', name: 'name-off', why: 'offline' },
          { id: 'old', name: 'name-old', why: 'no_worktree' },
          { id: 'bare', name: 'name-bare', why: 'no_claude' },
          { id: 's', name: 'name-s', why: 'not_agent' },
        ],
        accounts: [],
      },
    });
  });

  it('a crowded machine is named once, with its accounts', async () => {
    reg.online.set('m1', ['worktree']);
    const repos = fakeRepos({ machines: [machine('m1')], accounts: [account('a1', 'm1'), account('a2', 'm1')] });
    const p = await placeRun({ repos, now: () => new Date(), usage: async () => 0, room: async () => false }, project, setup(['a1', 'a2']));
    expect(p).toMatchObject({
      waiting: 'no_room',
      detail: { machines: [{ id: 'm1', why: 'no_room' }], accounts: [{ id: 'a1', why: 'machine_no_room' }, { id: 'a2', why: 'machine_no_room' }] },
    });
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

  it('keep the placement detail with the reason', () => {
    const t0 = new Date('2026-10-05T10:00:00Z');
    const detail = { listed: 0, machines: [], accounts: [] };
    noteWaiting('t1', 'no_account', t0, detail);
    expect(waitingOf('t1', t0)).toEqual({ reason: 'no_account', detail });
    noteWaiting('t2', 'no_room', t0);
    expect(waitingOf('t2', t0)).toEqual({ reason: 'no_room', detail: null });
  });
});

describe('placeDetailText', () => {
  const detail = {
    listed: 0,
    machines: [{ id: 'j', name: 'jarvis', why: 'not_allowed' as const }],
    accounts: [
      { id: 'h1', label: 'Claude', machine: 'hulk', why: 'not_listed' as const },
      { id: 'h2', label: 'pessoal', machine: 'hulk', why: 'busy' as const, peak: 85 },
    ],
  };

  it('names each machine and account and why, in pt-BR', () => {
    expect(placeDetailText('pt-BR', detail)).toBe(
      'nenhuma conta escolhida em Setup → Contas de IA e modelo; máquina jarvis: não aceita trabalho automático; conta Claude (hulk): fora das contas do projeto no Setup; conta pessoal (hulk): uso em 85% (o automático para em 80%)',
    );
  });

  it('and in English', () => {
    expect(placeDetailText('en', detail)).toBe(
      "no account chosen in Setup → AI accounts and model; machine jarvis: does not accept automatic work; account Claude (hulk): not among the project's accounts in Setup; account pessoal (hulk): usage at 85% (automatic work stops at 80%)",
    );
  });
});
