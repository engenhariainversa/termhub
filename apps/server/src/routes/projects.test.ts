import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureDirectory, killTmuxSession, listTmuxSessions } = vi.hoisted(() => ({ ensureDirectory: vi.fn(), killTmuxSession: vi.fn(), listTmuxSessions: vi.fn() }));
vi.mock('../terminal/machine-fs.js', () => ({ ensureDirectory }));
vi.mock('../terminal/machine-exec.js', () => ({ killTmuxSession, listTmuxSessions }));
const { removeTabMcp } = vi.hoisted(() => ({ removeTabMcp: vi.fn(async () => undefined) }));
vi.mock('../terminal/tab-mcp.js', () => ({ removeTabMcp }));

import type { Repositories } from '../db/repositories/index.js';
import { ProjectRuleError } from '../db/repositories/projects.js';
import type { Machine, Project, ProjectMachine, Tab } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { monitorBus, type TabLifecycle } from '../monitor/bus.js';
import { projectRoutes } from './projects.js';

const machine = (over: Partial<Machine> & { id: string }): Machine => ({
  name: over.id, host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: null, capabilities: ['tmux'], checked_at: null,
  agent_version: null, agent_last_seen_at: null, agent_auto_update: false, is_local: false, owner_id: 'u1', owner_name: null, created_at: '', ...over,
});
const project = (over: Partial<Project> & { id: string }): Project => ({
  owner_id: 'u1', key: over.id.toUpperCase(), next_task_number: 1, name: over.id, status: 'active', description: null, last_terminal_at: null, created_at: '', ...over,
});
const link = (project_id: string, machine_id: string, cwd = `/src/${project_id}`): ProjectMachine => ({ id: `${project_id}-${machine_id}`, project_id, machine_id, cwd, position: 0, created_at: '' });
const tab = (over: Partial<Tab> & { id: string; project_id: string; machine_id: string }): Tab => ({
  name: over.id, kind: 'terminal', tmux_session: `th-${over.id}`, simulator_udid: null, created_by_token_id: null, position: 0,
  state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '', ...over,
});

/**
 * u1 owns m1, m2 and projects p1 (m1 only), p2 (m1 + m2), p3 (no machine), p4 (m1 + mx, a
 * cross-owner link — e.g. an admin's "view as" or a machine ownership transfer); u2 owns mx and px.
 */
function buildApp() {
  const machines: Record<string, Machine> = { m1: machine({ id: 'm1' }), m2: machine({ id: 'm2', type: 'local' }), mx: machine({ id: 'mx', owner_id: 'u2' }) };
  const projects: Record<string, Project> = { p1: project({ id: 'p1' }), p2: project({ id: 'p2' }), p3: project({ id: 'p3' }), p4: project({ id: 'p4' }), px: project({ id: 'px', owner_id: 'u2' }) };
  let links: ProjectMachine[] = [link('p1', 'm1'), link('p2', 'm1'), link('p2', 'm2', '/other'), link('p4', 'm1'), link('p4', 'mx'), link('px', 'mx')];
  let tabs: Tab[] = [
    tab({ id: 't1', project_id: 'p2', machine_id: 'm1' }),
    tab({ id: 't2', project_id: 'p2', machine_id: 'm2' }),
    tab({ id: 't3', project_id: 'p4', machine_id: 'm1' }),
    tab({ id: 't4', project_id: 'p4', machine_id: 'mx' }),
  ];
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const repos = {
    machines: { findById: vi.fn(async (id: string) => machines[id]) },
    projects: {
      list: vi.fn(async (f: { owner?: string | null }) => Object.values(projects).filter((p) => !f.owner || p.owner_id === f.owner)),
      findById: vi.fn(async (id: string) => projects[id]),
      isKeyAvailable: vi.fn(async (key: string) => /^[A-Z][A-Z0-9]{1,9}$/.test(key) && !Object.values(projects).some((p) => p.key === key)),
      create: vi.fn(async (input: { owner_id: string; key: string; name: string }) => {
        if (Object.values(projects).some((p) => p.key === input.key)) throw new ProjectRuleError('KEY_TAKEN', `A chave ${input.key} já está em uso`);
        return (projects.new = project({ id: 'new', ...input }));
      }),
      update: vi.fn(async (id: string, patch: Partial<Project>) => (projects[id] = { ...projects[id], ...patch })),
      delete: vi.fn(async (id: string) => delete projects[id]),
    },
    projectMachines: {
      listByProjects: vi.fn(async (ids: string[]) => links.filter((l) => ids.includes(l.project_id))),
      listByProject: vi.fn(async (id: string) => links.filter((l) => l.project_id === id)),
      find: vi.fn(async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m)),
      link: vi.fn(async (input: { project_id: string; machine_id: string; cwd: string }) => {
        if (links.some((l) => l.project_id === input.project_id && l.machine_id === input.machine_id)) throw new ProjectRuleError('MACHINE_ALREADY_LINKED', 'Esta máquina já está vinculada ao projeto');
        const l = link(input.project_id, input.machine_id, input.cwd);
        links.push(l);
        return l;
      }),
      updateCwd: vi.fn(async (p: string, m: string, cwd: string) => {
        const l = links.find((x) => x.project_id === p && x.machine_id === m);
        return l ? Object.assign(l, { cwd }) : undefined;
      }),
      unlink: vi.fn(async (p: string, m: string) => {
        const before = links.length;
        links = links.filter((l) => !(l.project_id === p && l.machine_id === m));
        return links.length < before;
      }),
    },
    tabs: {
      listByProject: vi.fn(async (id: string) => tabs.filter((t) => t.project_id === id)),
      listByProjectMachine: vi.fn(async (p: string, m: string) => tabs.filter((t) => t.project_id === p && t.machine_id === m)),
      create: vi.fn(async (project_id: string, machine_id: string, name: string, opts: { kind?: string }) => {
        const t = tab({ id: `t${tabs.length + 1}`, project_id, machine_id, name, kind: (opts.kind ?? 'terminal') as Tab['kind'] });
        tabs.push(t);
        return t;
      }),
      delete: vi.fn(async (id: string) => {
        tabs = tabs.filter((t) => t.id !== id);
        return true;
      }),
    },
    tasks: { openCountByProject: vi.fn(async () => ({ p1: 2 })) },
    memoryItems: {
      currentNotes: vi.fn(async () => [{ id: 'n1', title: 'Idioma dos PRs', text: 'Decisão: inglês\nMotivo: m\nFontes: ', project_id: 'p1', scope: 'project' }]),
      upsertMany: vi.fn(async (items: unknown[]) => items),
    },
    apiTokens: { revokeForTabs: vi.fn(async (ids: string[]) => ids.length) },
  };
  app.register((a) => projectRoutes(a, repos as unknown as Repositories, { simulators: { isReady: () => false } as never }), { prefix: '/projects' });
  return { app, repos, get links() { return links; }, get tabs() { return tabs; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureDirectory.mockImplementation(async (_m: Machine, path: string) => ({ path: path.replace(/\/$/, ''), created: false }));
  killTmuxSession.mockResolvedValue(true);
  listTmuxSessions.mockResolvedValue(new Set(['th-t1', 'th-t2']));
});

describe('GET /projects', () => {
  it('lists the owner\'s projects with their machine links and open task counts', async () => {
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/projects' })).json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(body.projects[0]).toMatchObject({ key: 'P1', open_tasks: 2, machines: [{ machine_id: 'm1', cwd: '/src/p1' }] });
    expect(body.projects[1].machines.map((l: { machine_id: string }) => l.machine_id)).toEqual(['m1', 'm2']);
    expect(body.projects[2]).toMatchObject({ open_tasks: 0, machines: [] });
    // p4's link to mx (u2's machine, a cross-owner link) is still listed here: the owner filter is on
    // the project itself, not on each of its links.
    expect(body.projects[3].machines.map((l: { machine_id: string }) => l.machine_id)).toEqual(['m1', 'mx']);
  });
});

describe('GET /projects/key-available', () => {
  it('answers available / taken / invalid', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/projects/key-available?key=NEW' })).json()).toEqual({ available: true });
    expect((await app.inject({ method: 'GET', url: '/projects/key-available?key=P1' })).json()).toEqual({ available: false, reason: 'taken' });
    expect((await app.inject({ method: 'GET', url: '/projects/key-available?key=p1' })).json()).toEqual({ available: false, reason: 'invalid' });
    expect((await app.inject({ method: 'GET', url: '/projects/key-available' })).statusCode).toBe(400);
  });
});

describe('POST /projects', () => {
  it('creates a project without a machine, owned by the scope', async () => {
    const { app, repos } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'Novo', key: 'NOVO' } });
    expect(r.statusCode).toBe(201);
    expect(repos.projects.create).toHaveBeenCalledWith({ owner_id: 'u1', key: 'NOVO', name: 'Novo', description: undefined, status: undefined });
    expect(r.json().project).toMatchObject({ key: 'NOVO', machines: [] });
    expect(repos.projectMachines.link).not.toHaveBeenCalled();
  });

  it('creates and links in one step when machine_id and cwd come together, resolving the directory on the machine', async () => {
    const { app, repos } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'Novo', key: 'NOVO', machine_id: 'm1', cwd: '/home/u/novo/', create_dir: true } });
    expect(r.statusCode).toBe(201);
    expect(ensureDirectory).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), '/home/u/novo/', true);
    expect(repos.projectMachines.link).toHaveBeenCalledWith({ project_id: 'new', machine_id: 'm1', cwd: '/home/u/novo' });
    expect(r.json().project.machines).toEqual([expect.objectContaining({ machine_id: 'm1', cwd: '/home/u/novo' })]);
  });

  it('starts with a copy of another project\'s rules, and refuses a project outside the scope (TER-1169)', async () => {
    const { app, repos } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'Novo', key: 'NOVO', inherit_rules_from: 'p1' } });
    expect(r.statusCode).toBe(201);
    expect(r.json().inherited_rules).toBe(1);
    expect(repos.memoryItems.upsertMany).toHaveBeenCalledWith([expect.objectContaining({ project_id: 'new', title: 'Idioma dos PRs', scope: 'project' })]);
    const foreign = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'Outro', key: 'OUTRO', inherit_rules_from: 'px' } });
    expect(foreign.statusCode).toBe(400);
    expect(repos.projects.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['machine_id without cwd', { name: 'x', key: 'X1', machine_id: 'm1' }],
    ['cwd without machine_id', { name: 'x', key: 'X1', cwd: '/x' }],
    ['a relative cwd', { name: 'x', key: 'X1', machine_id: 'm1', cwd: 'rel' }],
    ['a lowercase key', { name: 'x', key: 'x1' }],
    ['no key', { name: 'x' }],
  ])('rejects %s with 400', async (_n, payload) => {
    const { app, repos } = buildApp();
    expect((await app.inject({ method: 'POST', url: '/projects', payload })).statusCode).toBe(400);
    expect(repos.projects.create).not.toHaveBeenCalled();
  });

  it('answers 409 for a taken key and 400 for a machine outside the scope', async () => {
    const { app } = buildApp();
    const taken = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'x', key: 'P1' } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('A chave P1 já está em uso');
    expect(taken.json().code).toBe('KEY_TAKEN');
    const foreign = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'x', key: 'X1', machine_id: 'mx', cwd: '/x' } });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toBe('Máquina inexistente');
  });
});

describe('PATCH / DELETE /projects/:id', () => {
  it('updates name/description/status and refuses key and cwd', async () => {
    const { app, repos } = buildApp();
    const ok = await app.inject({ method: 'PATCH', url: '/projects/p1', payload: { name: 'Renomeado', status: 'paused' } });
    expect(ok.statusCode).toBe(200);
    expect(repos.projects.update).toHaveBeenCalledWith('p1', { name: 'Renomeado', status: 'paused' });
    expect((await app.inject({ method: 'PATCH', url: '/projects/p1', payload: { key: 'ZZ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/projects/p1', payload: { cwd: '/x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/projects/px', payload: { name: 'x' } })).statusCode).toBe(404);
  });

  it('kills the tmux sessions on every linked machine before deleting', async () => {
    const { app, repos } = buildApp();
    const r = await app.inject({ method: 'DELETE', url: '/projects/p2' });
    expect(r.statusCode).toBe(200);
    expect(killTmuxSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'th-t1');
    expect(killTmuxSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }), 'th-t2');
    expect(repos.projects.delete).toHaveBeenCalledWith('p2');
    expect(removeTabMcp).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 't1');
    expect(removeTabMcp).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }), 't2');
  });

  it('deleting a project only touches tabs on machines in scope, leaving a cross-owner link\'s tab alone', async () => {
    const { app } = buildApp();
    // p4 is linked to m1 (u1's) and mx (u2's): the mx link is out of the caller's scope.
    const r = await app.inject({ method: 'DELETE', url: '/projects/p4' });
    expect(r.statusCode).toBe(200);
    expect(killTmuxSession).toHaveBeenCalledTimes(1);
    expect(killTmuxSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'th-t3');
    expect(removeTabMcp).toHaveBeenCalledTimes(1);
  });

  it('revokes the tokens of every tab the cascade removes, before the delete', async () => {
    const { app, repos } = buildApp();
    expect((await app.inject({ method: 'DELETE', url: '/projects/p4' })).statusCode).toBe(200);
    // the cross-owner link's tab goes with the project too, so its token dies with it
    expect(repos.apiTokens.revokeForTabs).toHaveBeenCalledWith(['t3', 't4']);
    expect(repos.apiTokens.revokeForTabs.mock.invocationCallOrder[0]).toBeLessThan(repos.projects.delete.mock.invocationCallOrder[0]!);
  });
});

describe('project machines', () => {
  it('lists links with the machine summary', async () => {
    const { app } = buildApp();
    const body = (await app.inject({ method: 'GET', url: '/projects/p2/machines' })).json();
    expect(body.machines).toEqual([
      expect.objectContaining({ machine_id: 'm1', cwd: '/src/p2', machine: { id: 'm1', name: 'm1', type: 'agent' } }),
      expect.objectContaining({ machine_id: 'm2', cwd: '/other', machine: { id: 'm2', name: 'm2', type: 'local' } }),
    ]);
  });

  it('links a machine (directory checked on it), 409 when already linked, 400 for a foreign machine', async () => {
    const { app, repos } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/projects/p3/machines', payload: { machine_id: 'm2', cwd: '/w/', create_dir: true } });
    expect(r.statusCode).toBe(201);
    expect(ensureDirectory).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }), '/w/', true);
    expect(repos.projectMachines.link).toHaveBeenCalledWith({ project_id: 'p3', machine_id: 'm2', cwd: '/w' });
    const alreadyLinked = await app.inject({ method: 'POST', url: '/projects/p1/machines', payload: { machine_id: 'm1', cwd: '/x' } });
    expect(alreadyLinked.statusCode).toBe(409);
    expect(alreadyLinked.json().code).toBe('MACHINE_ALREADY_LINKED');
    expect((await app.inject({ method: 'POST', url: '/projects/p1/machines', payload: { machine_id: 'mx', cwd: '/x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/projects/px/machines', payload: { machine_id: 'm1', cwd: '/x' } })).statusCode).toBe(404);
  });

  it('updates the cwd of a link and 404s an unlinked machine', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'PATCH', url: '/projects/p2/machines/m2', payload: { cwd: '/new' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().link).toMatchObject({ machine_id: 'm2', cwd: '/new' });
    expect((await app.inject({ method: 'PATCH', url: '/projects/p1/machines/m2', payload: { cwd: '/new' } })).statusCode).toBe(404);
  });

  it('unlinking closes that machine\'s tabs of the project and reports how many', async () => {
    const built = buildApp();
    const r = await built.app.inject({ method: 'DELETE', url: '/projects/p2/machines/m2' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, closed_tabs: 1 });
    expect(killTmuxSession).toHaveBeenCalledTimes(1);
    expect(killTmuxSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }), 'th-t2');
    expect(built.tabs.filter((t) => t.project_id === 'p2').map((t) => t.id)).toEqual(['t1']);
    expect(built.links.some((l) => l.project_id === 'p2' && l.machine_id === 'm2')).toBe(false);
  });
});

describe('tabs', () => {
  it('GET lists tabs across machines with alive per machine; a silent machine marks only its own tabs dead', async () => {
    const { app } = buildApp();
    listTmuxSessions.mockImplementation(async (m: Machine) => {
      if (m.id === 'm2') throw new Error('offline');
      return new Set(['th-t1']);
    });
    const body = (await app.inject({ method: 'GET', url: '/projects/p2/tabs' })).json();
    expect(body.reachable).toBe(false);
    expect(body.tabs.map((t: Tab & { alive: boolean }) => [t.id, t.machine_id, t.alive])).toEqual([['t1', 'm1', true], ['t2', 'm2', false]]);
  });

  it('leaves out a tab on a machine outside the scope (a cross-owner link)', async () => {
    const { app, repos } = buildApp();
    // p4 is linked to m1 (u1's, in scope) and mx (u2's, out of scope); t4 runs on mx.
    const body = (await app.inject({ method: 'GET', url: '/projects/p4/tabs' })).json();
    expect(body.tabs.map((t: Tab) => t.id)).toEqual(['t3']);
    // only m1 (the scoped machine with a terminal tab) is asked for its tmux sessions
    expect(repos.tabs.listByProject).toHaveBeenCalledWith('p4');
    expect(listTmuxSessions).toHaveBeenCalledTimes(1);
    expect(listTmuxSessions).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
  });

  it('POST opens on the only linked machine, needs machine_id with several, refuses with none', async () => {
    const { app, repos } = buildApp();
    const one = await app.inject({ method: 'POST', url: '/projects/p1/tabs', payload: {} });
    expect(one.statusCode).toBe(201);
    expect(repos.tabs.create).toHaveBeenCalledWith('p1', 'm1', expect.any(String), { kind: 'terminal', simulator_udid: null }); // nextTerminalName picks a random teammate name
    expect(one.json().tab).toMatchObject({ machine_id: 'm1', alive: false });

    const several = await app.inject({ method: 'POST', url: '/projects/p2/tabs', payload: {} });
    expect(several.statusCode).toBe(400);
    expect(several.json().code).toBe('MACHINE_REQUIRED');
    const chosen = await app.inject({ method: 'POST', url: '/projects/p2/tabs', payload: { machine_id: 'm2' } });
    expect(chosen.statusCode).toBe(201);
    expect(chosen.json().tab.machine_id).toBe('m2');

    const none = await app.inject({ method: 'POST', url: '/projects/p3/tabs', payload: {} });
    expect(none.statusCode).toBe(400);
    expect(none.json().code).toBe('NO_MACHINE');
    expect((await app.inject({ method: 'POST', url: '/projects/p1/tabs', payload: { machine_id: 'm2' } })).statusCode).toBe(404);
  });
});

describe('tab lifecycle on the monitor bus', () => {
  async function lifecycleDuring(work: () => Promise<unknown>): Promise<TabLifecycle[]> {
    const events: TabLifecycle[] = [];
    const off = monitorBus.subscribeLifecycle((e) => events.push(e));
    try {
      await work();
    } finally {
      off();
    }
    return events;
  }

  it('opening a tab publishes it, scoped by its machine owner', async () => {
    const { app } = buildApp();
    const events = await lifecycleDuring(() => app.inject({ method: 'POST', url: '/projects/p1/tabs', payload: {} }));
    expect(events).toEqual([{ kind: 'upsert', tab: expect.objectContaining({ project_id: 'p1', machine_id: 'm1' }), project_id: 'p1', machine_id: 'm1', owner_id: 'u1' }]);
  });

  it('unlinking a machine publishes the removal of each of its tabs', async () => {
    const { app } = buildApp();
    const events = await lifecycleDuring(() => app.inject({ method: 'DELETE', url: '/projects/p2/machines/m2' }));
    expect(events).toEqual([{ kind: 'removed', tab_id: 't2', project_id: 'p2', machine_id: 'm2', owner_id: 'u1' }]);
  });

  it('deleting a project publishes the removal of every tab the cascade takes, the cross-owner one under its own owner', async () => {
    const { app } = buildApp();
    const events = await lifecycleDuring(() => app.inject({ method: 'DELETE', url: '/projects/p4' }));
    expect(events).toEqual([
      { kind: 'removed', tab_id: 't3', project_id: 'p4', machine_id: 'm1', owner_id: 'u1' },
      { kind: 'removed', tab_id: 't4', project_id: 'p4', machine_id: 'mx', owner_id: 'u2' },
    ]);
  });
});
