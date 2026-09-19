import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../terminal/machine-exec.js', () => ({ listTmuxSessions: vi.fn() }));
vi.mock('../agent/registry.js', () => ({ agents: { isOnline: vi.fn() } }));

import { agents } from '../agent/registry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, Project, Tab } from '../db/repositories/types.js';
import { listTmuxSessions } from '../terminal/machine-exec.js';
import { Scoped } from '../auth/scope.js';
import type { ControlContext } from './context.js';
import { find, listAiAccounts, listMachines, listProjects, listTabs, normalizeName } from './inventory.js';

const machine = (over: Partial<Machine> & { id: string }): Machine => ({
  name: over.id, host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'macos', capabilities: ['tmux', 'claude'], checked_at: null,
  agent_version: '0.2.0', agent_last_seen_at: null, is_local: false, owner_id: 'u1', owner_name: null, created_at: '', ...over,
});
const project = (over: Partial<Project> & { id: string; machine_id: string }): Project => ({
  name: over.id, cwd: '/src/' + over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});
const tab = (over: Partial<Tab> & { id: string; project_id: string }): Tab => ({
  name: over.id, kind: 'terminal', tmux_session: 'th-' + over.id, simulator_udid: null, position: 0,
  state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', ...over,
});
const account = (over: Partial<AiAccount> & { id: string; machine_id: string }): AiAccount => ({
  provider: 'claude', label: over.id, config_dir: '/home/x/.claude-secret', created_at: '', ...over,
});

/** Data of two users; u1 is the token's user. */
const machines = [machine({ id: 'm1', name: 'MacBook Pro M4' }), machine({ id: 'm2', name: 'jarvis', type: 'local' }), machine({ id: 'mx', name: 'MacBook do Outro', owner_id: 'u2' })];
const projects = [
  project({ id: 'p1', name: 'Hub Community', machine_id: 'm1' }),
  project({ id: 'p2', name: 'termhub', machine_id: 'm2' }),
  project({ id: 'p3', name: 'Velho', machine_id: 'm1', status: 'archived' }),
  project({ id: 'px', name: 'Hub Community', machine_id: 'mx' }),
];
const tabs = [tab({ id: 't1', project_id: 'p1', state: 'waiting_input', state_text: 'Posso seguir?', state_at: '2026-09-19T10:00:00.000Z' }), tab({ id: 't2', project_id: 'p1' }), tab({ id: 'ts', project_id: 'p1', kind: 'simulator', tmux_session: null })];
const accounts = [account({ id: 'a1', label: 'pedrogoiania', machine_id: 'm1' }), account({ id: 'ax', label: 'pedrogoiania', machine_id: 'mx' })];

function ctx(grants: string[] = ['machines:read', 'projects:read', 'terminals:read', 'ai_accounts:read']): ControlContext {
  const owned = (ownerId: string | null) => ownerId === 'u1';
  const repos = {
    machines: {
      list: vi.fn(async (owner: string | null) => machines.filter((m) => owner === null || m.owner_id === owner)),
      findById: vi.fn(async (id: string) => machines.find((m) => m.id === id)),
    },
    projects: {
      list: vi.fn(async (f: { machine_id?: string; owner?: string | null }) =>
        projects.filter((p) => (!f.machine_id || p.machine_id === f.machine_id) && (f.owner == null || owned(machines.find((m) => m.id === p.machine_id)!.owner_id))),
      ),
      findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)),
    },
    tabs: { listByProject: vi.fn(async (pid: string) => tabs.filter((t) => t.project_id === pid)), findById: vi.fn(async (id: string) => tabs.find((t) => t.id === id)) },
    aiAccounts: { list: vi.fn(async (owner: string | null) => accounts.filter((a) => owner === null || machines.find((m) => m.id === a.machine_id)!.owner_id === owner)) },
    tasks: { listByProject: vi.fn(async (pid: string) => (pid === 'p1' ? [{ id: 'k1', title: 'XPTO', status: 'doing', tab_id: 't1', subtasks: [] }] : [])) },
  } as unknown as Repositories;
  const scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' } as const, ownerId: 'u1', createAs: 'u1' };
  return { repos, scope, scoped: new Scoped(repos, scope), can: async (r, a) => grants.includes(`${r}:${a}`) };
}

beforeEach(() => {
  vi.mocked(agents.isOnline).mockImplementation((id: string) => id === 'm1');
  vi.mocked(listTmuxSessions).mockClear().mockResolvedValue(new Set(['th-t1']));
});

describe('normalizeName', () => {
  it('lowercases and strips diacritics and extra spaces', () => {
    expect(normalizeName('  Hub   Comunicação ')).toBe('hub comunicacao');
  });
});

describe('listMachines', () => {
  it('lists only the owner\'s machines with online status per transport', async () => {
    const r = await listMachines(ctx());
    expect(r.machines.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(r.machines[0]).toMatchObject({ id: 'm1', name: 'MacBook Pro M4', type: 'agent', online: true, os: 'macos', capabilities: ['tmux', 'claude'] });
    expect(r.machines[1]).toMatchObject({ id: 'm2', type: 'local', online: true });
  });

  it('reports an offline agent and an unchecked ssh machine', async () => {
    vi.mocked(agents.isOnline).mockReturnValue(false);
    const c = ctx();
    vi.mocked(c.repos.machines.list).mockResolvedValue([machine({ id: 'm1' }), machine({ id: 'm3', type: 'ssh', host: 'box' })]);
    const r = await listMachines(c);
    expect(r.machines.map((m) => m.online)).toEqual([false, null]);
  });
});

describe('listProjects', () => {
  it('hides archived projects unless asked, and names the machine', async () => {
    const r = await listProjects(ctx(), {});
    expect(r.projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(r.projects[0]).toMatchObject({ id: 'p1', name: 'Hub Community', cwd: '/src/p1', machine_id: 'm1', machine_name: 'MacBook Pro M4' });
    expect((await listProjects(ctx(), { include_archived: true })).projects.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('filters by a machine of the owner and refuses a foreign one', async () => {
    expect((await listProjects(ctx(), { machine_id: 'm1' })).projects.map((p) => p.id)).toEqual(['p1']);
    await expect(listProjects(ctx(), { machine_id: 'mx' })).rejects.toThrow('Máquina não encontrada');
  });
});

describe('listTabs', () => {
  it('lists a project\'s tabs with liveness, monitor state and the linked task', async () => {
    const r = await listTabs(ctx(), { project_id: 'p1' });
    expect(r.tabs.map((t) => t.id)).toEqual(['t1', 't2', 'ts']);
    expect(r.tabs[0]).toMatchObject({ id: 't1', kind: 'terminal', alive: true, state: 'waiting_input', state_text: 'Posso seguir?', task: { id: 'k1', title: 'XPTO', status: 'doing' } });
    expect(r.tabs[1]).toMatchObject({ id: 't2', alive: false, state: null, task: null });
    expect(r.tabs[2]).toMatchObject({ id: 'ts', kind: 'simulator', alive: null });
  });

  it('says liveness is unknown when the agent machine is offline, without asking it', async () => {
    // listTmuxSessions answers an empty Set (not a rejection) for an offline agent: asking would read every tab as dead
    vi.mocked(agents.isOnline).mockReturnValue(false);
    vi.mocked(listTmuxSessions).mockResolvedValue(new Set());
    const r = await listTabs(ctx(), { project_id: 'p1' });
    expect(r.tabs.map((t) => t.alive)).toEqual([null, null, null]);
    expect(listTmuxSessions).not.toHaveBeenCalled();
  });

  it('says liveness is unknown when listing the sessions fails', async () => {
    vi.mocked(listTmuxSessions).mockRejectedValueOnce(new Error('ssh: connect timed out'));
    const r = await listTabs(ctx(), { project_id: 'p1' });
    expect(r.tabs[0].alive).toBeNull();
  });

  it('lists every project of a machine, requires a filter and refuses foreign ids', async () => {
    expect((await listTabs(ctx(), { machine_id: 'm1' })).tabs.map((t) => t.id)).toEqual(['t1', 't2', 'ts']);
    await expect(listTabs(ctx(), {})).rejects.toThrow('Informe project_id ou machine_id');
    await expect(listTabs(ctx(), { project_id: 'px' })).rejects.toThrow('Projeto não encontrado');
  });
});

describe('listAiAccounts', () => {
  it('lists the owner\'s accounts without the config dir', async () => {
    const r = await listAiAccounts(ctx(), {});
    expect(r.accounts).toEqual([{ id: 'a1', provider: 'claude', label: 'pedrogoiania', machine_id: 'm1', machine_name: 'MacBook Pro M4' }]);
    expect(JSON.stringify(r)).not.toContain('claude-secret');
  });
});

describe('find', () => {
  it('resolves names across kinds, ignoring case and accents, only in the owner\'s data', async () => {
    const r = await find(ctx(), { query: 'hub community' });
    expect(r.matches).toEqual([{ kind: 'project', id: 'p1', name: 'Hub Community', machine_id: 'm1', machine_name: 'MacBook Pro M4', score: 3 }]);

    const mac = await find(ctx(), { query: 'macbook' });
    expect(mac.matches.map((m) => m.id)).toEqual(['m1']);

    const acc = await find(ctx(), { query: 'PEDROGOIANIA', kinds: ['ai_account'] });
    expect(acc.matches.map((m) => `${m.kind}:${m.id}`)).toEqual(['ai_account:a1']);
  });

  it('ranks exact > prefix > contains > all words', async () => {
    const c = ctx();
    vi.mocked(c.repos.machines.list).mockResolvedValue([
      machine({ id: 'a', name: 'Pro M4 MacBook' }),
      machine({ id: 'b', name: 'MacBook Pro M4 (casa)' }),
      machine({ id: 'c', name: 'macbook pro m4' }),
      machine({ id: 'd', name: 'Meu MacBook Pro M4' }),
    ]);
    const r = await find(c, { query: 'MacBook Pro M4', kinds: ['machine'] });
    expect(r.matches.map((m) => [m.id, m.score])).toEqual([['c', 3], ['b', 2], ['d', 1.5], ['a', 1]]);
  });

  it('skips kinds the token cannot read', async () => {
    const r = await find(ctx(['machines:read', 'projects:read']), { query: 'pedrogoiania' });
    expect(r.matches).toEqual([]);
  });
});
