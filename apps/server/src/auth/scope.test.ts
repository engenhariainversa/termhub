import { beforeEach, describe, expect, it } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { invalidatePermissionCache } from './permissions.js';
import { resolveScope, Scoped, VIEW_AS_ALL, VIEW_AS_COOKIE } from './scope.js';

const user = (id: string, roleId: string): User => ({ id, email: `${id}@x.com`, name: id, avatar_url: null, password_hash: null, google_id: null, role: 'member', role_id: roleId, invited_at: null, last_login_at: null, created_at: '' });
const admin = user('adm', 'role_admin');
const alice = user('alice', 'role_auth');
const bob = user('bob', 'role_auth');

/** alice owns m1 and project p1 (linked to m1, tab t1 on m1, task k1); bob owns m2; m3 is an orphan; p2 is alice's project with two machines; p3 has none. */
function fakeRepos(): Repositories {
  const users = [admin, alice, bob];
  const roles = { role_admin: { id: 'role_admin', is_admin: true }, role_auth: { id: 'role_auth', is_admin: false } };
  const machines = [
    { id: 'm1', owner_id: 'alice' },
    { id: 'm2', owner_id: 'bob' },
    { id: 'm3', owner_id: null },
    { id: 'm4', owner_id: 'alice' },
  ];
  const projects = [
    { id: 'p1', owner_id: 'alice', key: 'ALI' },
    { id: 'p2', owner_id: 'alice' },
    { id: 'p3', owner_id: 'alice' },
    { id: 'p9', owner_id: null, key: 'ORF' },
  ];
  const links = [
    { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '/p1' },
    { id: 'l2', project_id: 'p2', machine_id: 'm1', cwd: '/p2-m1' },
    { id: 'l3', project_id: 'p2', machine_id: 'm4', cwd: '/p2-m4' },
    { id: 'l4', project_id: 'p1', machine_id: 'm2', cwd: '/bobs' }, // a link to a machine alice does not own
  ];
  const tabs = [{ id: 't1', project_id: 'p1', machine_id: 'm1' }, { id: 't2', project_id: 'p1', machine_id: 'm2' }];
  const tasks = [{ id: 'k1', project_id: 'p1', number: 7 }];
  const columns = [{ id: 'c1', project_id: 'p1' }];
  const integrations = [{ id: 'i1', owner_id: 'alice' }];
  const accounts = [{ id: 'a1', machine_id: 'm2' }];
  const find = <T extends { id: string }>(rows: T[]) => async (id: string) => rows.find((r) => r.id === id);
  return {
    users: { findById: find(users) },
    roles: { findById: async (id: string) => (roles as Record<string, unknown>)[id], permissionsOf: async () => [] },
    machines: { findById: find(machines) },
    projects: { findById: find(projects), findByKey: async (key: string) => projects.find((p) => p.key === key) },
    projectMachines: {
      find: async (p: string, m: string) => links.find((l) => l.project_id === p && l.machine_id === m),
      listByProject: async (p: string) => links.filter((l) => l.project_id === p),
    },
    tabs: { findById: find(tabs) },
    tasks: { findById: find(tasks), findByRef: async (projectId: string, n: number) => tasks.find((t) => t.project_id === projectId && t.number === n) },
    taskColumns: { findById: find(columns) },
    integrations: { findById: find(integrations) },
    aiAccounts: { findById: find(accounts) },
  } as unknown as Repositories;
}

describe('resolveScope', () => {
  beforeEach(() => invalidatePermissionCache());

  it('defaults to the user itself', async () => {
    const s = await resolveScope(fakeRepos(), alice, {});
    expect(s.ownerId).toBe('alice');
    expect(s.createAs).toBe('alice');
    expect(s.viewAs).toEqual({ kind: 'self' });
  });

  it('ignores the view-as cookie for non-admins', async () => {
    const repos = fakeRepos();
    expect((await resolveScope(repos, alice, { [VIEW_AS_COOKIE]: 'bob' })).ownerId).toBe('alice');
    expect((await resolveScope(repos, alice, { [VIEW_AS_COOKIE]: VIEW_AS_ALL })).ownerId).toBe('alice');
  });

  it('lets admins view as another user, as all, and falls back on unknown ids', async () => {
    const repos = fakeRepos();
    const asBob = await resolveScope(repos, admin, { [VIEW_AS_COOKIE]: 'bob' });
    expect(asBob.ownerId).toBe('bob');
    expect(asBob.createAs).toBe('bob');
    expect(asBob.viewAs).toMatchObject({ kind: 'user', user: { id: 'bob' } });
    const all = await resolveScope(repos, admin, { [VIEW_AS_COOKIE]: VIEW_AS_ALL });
    expect(all.ownerId).toBeNull();
    expect(all.createAs).toBe('adm');
    expect((await resolveScope(repos, admin, { [VIEW_AS_COOKIE]: 'ghost' })).ownerId).toBe('adm');
  });
});

describe('Scoped', () => {
  const repos = fakeRepos();
  const as = (ownerId: string | null) => new Scoped(repos, { user: alice, viewAs: { kind: 'self' }, ownerId, createAs: ownerId ?? 'adm' });

  it('resolves rows of the owner: projects by owner_id, tabs through their machine link', async () => {
    const s = as('alice');
    expect((await s.machine('m1')).id).toBe('m1');
    expect((await s.project('p1')).project.owner_id).toBe('alice');
    const tab = await s.tab('t1');
    expect([tab.project.id, tab.machine.id, tab.cwd]).toEqual(['p1', 'm1', '/p1']);
    expect((await s.task('k1')).project.id).toBe('p1');
    expect((await s.integration('i1')).id).toBe('i1');
    expect((await s.projectMachine('p2', 'm4')).link.cwd).toBe('/p2-m4');
  });

  it('projectMachines lists only linked machines the owner can see', async () => {
    const r = await as('alice').projectMachines('p1');
    expect(r.machines.map((x) => x.machine.id)).toEqual(['m1']); // m2 is bob's: left out
    expect((await as(null).projectMachines('p1')).machines.map((x) => x.machine.id)).toEqual(['m1', 'm2']);
  });

  it('projectMachineFor picks the only machine, requires one when there are several, refuses when there are none', async () => {
    const s = as('alice');
    expect((await s.projectMachineFor('p1')).machine.id).toBe('m1');
    expect((await s.projectMachineFor('p2', 'm4')).link.cwd).toBe('/p2-m4');
    await expect(s.projectMachineFor('p2')).rejects.toMatchObject({ statusCode: 400, code: 'MACHINE_REQUIRED' });
    await expect(s.projectMachineFor('p3')).rejects.toMatchObject({ statusCode: 400, code: 'NO_MACHINE' });
    await expect(s.projectMachineFor('p1', 'm4')).rejects.toMatchObject({ statusCode: 404 }); // not linked
    await expect(s.projectMachineFor('p1', 'm2')).rejects.toMatchObject({ statusCode: 404 }); // linked, but bob's machine
  });

  it("answers 404 for another user's rows, orphans and missing ids alike", async () => {
    const s = as('bob');
    for (const p of [s.machine('m1'), s.machine('m3'), s.machine('nope'), s.project('p1'), s.project('p9'), s.tab('t1'), s.tab('t2'), s.task('k1'), s.integration('i1'), s.projectMachine('p1', 'm2')]) {
      await expect(p).rejects.toMatchObject({ statusCode: 404 });
    }
    expect((await s.aiAccount('a1')).machine.id).toBe('m2');
    await expect(as('alice').aiAccount('a1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(as('alice').tab('t2')).rejects.toMatchObject({ statusCode: 404 }); // alice's project, bob's machine
  });

  it("tab: a scope miss is the tab's own 404; any other failure loading it propagates unchanged", async () => {
    // An unlinked machine (an HttpError from the project–machine check) reads as the tab's 404.
    await expect(as('alice').tab('t2')).rejects.toMatchObject({ statusCode: 404, message: 'Tab não encontrada' });
    // A transient DB error is not a 404: a caller that expires a card on 404 must not see one.
    const dbError = Object.assign(new Error('connection reset'), { code: 'P1001' });
    const flaky = { ...repos, projectMachines: { ...repos.projectMachines, find: async () => Promise.reject(dbError) } } as unknown as Repositories;
    const s = new Scoped(flaky, { user: alice, viewAs: { kind: 'self' }, ownerId: 'alice', createAs: 'alice' });
    await expect(s.tab('t1')).rejects.toBe(dbError);
    // Nor does a failure reading the machine turn into "not linked".
    const flakyMachine = { ...repos, machines: { findById: async () => Promise.reject(dbError) } } as unknown as Repositories;
    await expect(new Scoped(flakyMachine, { user: alice, viewAs: { kind: 'self' }, ownerId: 'alice', createAs: 'alice' }).tab('t1')).rejects.toBe(dbError);
  });

  it('sees everything with a null owner filter (admin "all")', async () => {
    const s = as(null);
    expect((await s.machine('m1')).id).toBe('m1');
    expect((await s.machine('m3')).id).toBe('m3');
    expect((await s.project('p9')).project.id).toBe('p9');
    expect((await s.tab('t2')).machine.id).toBe('m2');
    expect((await s.aiAccount('a1')).account.id).toBe('a1');
  });

  it('resolves a card by its ref, key case-insensitive, and a column through its project', async () => {
    const s = as('alice');
    expect((await s.taskByRef('ali-7')).task.id).toBe('k1');
    expect((await s.taskByRef(' ALI-7 ')).project.id).toBe('p1');
    expect((await s.column('c1')).project.id).toBe('p1');
    expect((await as(null).taskByRef('ALI-7')).task.id).toBe('k1');
  });

  it('answers the same 404 for a malformed ref, an unknown key or number, and another owner\'s card or column', async () => {
    const alice = as('alice');
    const bob = as('bob');
    for (const p of [alice.taskByRef('ALI-8'), alice.taskByRef('NOPE-1'), alice.taskByRef('ali'), bob.taskByRef('ALI-7'), bob.column('c1'), alice.column('nope')]) {
      await expect(p).rejects.toMatchObject({ statusCode: 404 });
    }
  });
});
