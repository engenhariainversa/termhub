import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { publicBus } from '../public/bus.js';
import { projectRoutes } from './projects.js';

const update = vi.fn();
const publish = vi.spyOn(publicBus, 'publish');

// Merge ruling 1: publishing belongs to the PROJECT's owner (projects.owner_id). p4 is u1's project
// linked to a machine somebody else owns: that does not stop u1 from publishing it (the city simply
// never shows that machine, see public/read.ts); p5 is somebody else's project.
const PROJECTS: Record<string, unknown> = {
  p1: { id: 'p1', owner_id: 'u1', key: 'ENG', name: 'Engage Easy', status: 'active', description: null, is_public: false },
  p2: { id: 'p2', owner_id: null, key: 'ORF', name: 'Órfão', status: 'active', description: null, is_public: false },
  p3: { id: 'p3', owner_id: 'u1', key: 'JAP', name: 'Já público', status: 'active', description: null, is_public: true },
  p4: { id: 'p4', owner_id: 'u1', key: 'ALH', name: 'Na máquina alheia', status: 'active', description: null, is_public: false },
  p5: { id: 'p5', owner_id: 'u9', key: 'OUT', name: 'De outra pessoa', status: 'active', description: null, is_public: false },
  p6: { id: 'p6', owner_id: 'u1', key: 'ARQ', name: 'Arquivado público', status: 'archived', description: null, is_public: true },
};
const MACHINES: Record<string, unknown> = {
  m1: { id: 'm1', name: 'Jarvis', owner_id: 'u1' },
  m9: { id: 'm9', name: 'Alheia', owner_id: 'u9' },
};
const LINKS = [
  { project_id: 'p1', machine_id: 'm1', cwd: '/w', position: 0 },
  { project_id: 'p3', machine_id: 'm1', cwd: '/w', position: 0 },
  { project_id: 'p4', machine_id: 'm9', cwd: '/w', position: 0 },
];
const projectMachines = {
  listByProjects: vi.fn(async (ids: string[]) => LINKS.filter((l) => ids.includes(l.project_id))),
  listByProject: vi.fn(async (id: string) => LINKS.filter((l) => l.project_id === id)),
  listAllWithOwner: vi.fn(async () => []),
};

/** `ownerId: null` mirrors an admin "view as all" scope: the only scope under which `scoped(...)`
 *  lets an orphan project, or somebody else's, through at all — see Scoped.owns in auth/scope.ts. */
function buildApp(user: { id: string; nickname: string | null }, ownerId: string | null = user.id) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    request.scope = { user, viewAs: ownerId === null ? { kind: 'all' } : { kind: 'self' }, ownerId, createAs: user.id } as never;
  });
  const repos = {
    projects: { findById: vi.fn(async (id: string) => PROJECTS[id]), update },
    machines: { findById: vi.fn(async (id: string) => MACHINES[id]) },
    projectMachines,
  } as unknown as Repositories;
  app.register((a) => projectRoutes(a, repos, { simulators: { isReady: () => false } as never }), { prefix: '/projects' });
  return app;
}

const owner = { id: 'u1', nickname: 'pedro' };
const ownerNoNick = { id: 'u1', nickname: null };
const stranger = { id: 'u2', nickname: 'outro' };
const patch = (user: { id: string; nickname: string | null }, id: string, body: unknown) =>
  buildApp(user).inject({ method: 'PATCH', url: `/projects/${id}`, payload: body });

describe('PATCH /projects/:id is_public', () => {
  beforeEach(() => {
    update.mockReset().mockImplementation(async (id: string, p: Record<string, unknown>) => ({ ...(PROJECTS[id] as object), ...p }));
    publish.mockClear();
  });

  it('publishes when the caller owns the project and has a nickname', async () => {
    const res = await patch(owner, 'p1', { is_public: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.is_public).toBe(true);
    expect(update).toHaveBeenCalledWith('p1', expect.objectContaining({ is_public: true }));
    expect(publish).toHaveBeenCalledWith({ project_id: 'p1', is_public: true });
  });

  it('publishes a project the caller owns even when its machine belongs to somebody else', async () => {
    const res = await patch(owner, 'p4', { is_public: true });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith('p4', expect.objectContaining({ is_public: true }));
  });

  // scoped(...).project(id) hides a project the caller does not own behind a 404 before the
  // publish guard is ever reached, so the stranger sees "not found", not "forbidden".
  it('refuses a caller who does not own the project', async () => {
    const res = await patch(stranger, 'p1', { is_public: true });
    expect(res.statusCode).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when the owner has no nickname yet', async () => {
    const res = await patch(ownerNoNick, 'p1', { is_public: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_REQUIRED');
    expect(update).not.toHaveBeenCalled();
  });

  // A self-scoped caller can never reach these branches: an orphan project, or somebody else's,
  // answers 404 before the guard runs (scoped() hides them from non-admins), same as the stranger
  // case. Only "view as all" lets scoped() through to the project, so that is the scope exercised.
  it('refuses on a project with no owner', async () => {
    const res = await buildApp(owner, null).inject({ method: 'PATCH', url: '/projects/p2', payload: { is_public: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PROJECT_UNOWNED');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an admin publishing somebody else\'s project', async () => {
    const res = await buildApp(owner, null).inject({ method: 'PATCH', url: '/projects/p5', payload: { is_public: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_OWNER');
    expect(update).not.toHaveBeenCalled();
  });

  it('unpublishing needs none of that', async () => {
    const res = await patch(ownerNoNick, 'p3', { is_public: false });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith('p3', expect.objectContaining({ is_public: false }));
    expect(publish).toHaveBeenCalledWith({ project_id: 'p3', is_public: false });
  });

  // The snapshot's filter excludes an archived project regardless of is_public (public/read.ts),
  // so archiving must tell the public bus the room is gone too — otherwise a socket opened before
  // the archive keeps streaming a room the snapshot has already dropped.
  it('tells the public bus a project is no longer visible when it is archived', async () => {
    const res = await patch(owner, 'p3', { status: 'archived' });
    expect(res.statusCode).toBe(200);
    expect(publish).toHaveBeenCalledWith({ project_id: 'p3', is_public: false });
  });

  // Unarchiving a published project brings its rooms back to the snapshot: the memoised city must
  // be dropped at once, as it is for a publish.
  it('tells the public bus when a published project is unarchived', async () => {
    const res = await patch(owner, 'p6', { status: 'active' });
    expect(res.statusCode).toBe(200);
    expect(publish).toHaveBeenCalledWith({ project_id: 'p6', is_public: true });
  });

  it('does not touch the public bus for a status change that is not archiving', async () => {
    const res = await patch(owner, 'p3', { status: 'paused' });
    expect(res.statusCode).toBe(200);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('DELETE /projects/:id', () => {
  const del = vi.fn();

  function buildDeleteApp(user: { id: string; nickname: string | null }) {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = user as never;
      request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
    });
    const repos = {
      projects: { findById: vi.fn(async (id: string) => PROJECTS[id]), delete: del },
      machines: { findById: vi.fn(async (id: string) => MACHINES[id]) },
      tabs: { listByProject: vi.fn(async () => []) },
      apiTokens: { revokeForTabs: vi.fn(async () => 0) },
      projectMachines,
    } as unknown as Repositories;
    app.register((a) => projectRoutes(a, repos, { simulators: { isReady: () => false } as never }), { prefix: '/projects' });
    return app;
  }

  beforeEach(() => {
    del.mockReset().mockResolvedValue(undefined);
    publish.mockClear();
  });

  // A deleted room can never be publicly visible again either — a socket already streaming it
  // (or one that connects between the delete and its own next reconnect) must still be told.
  it('tells the public bus a project is no longer visible when it is deleted', async () => {
    const res = await buildDeleteApp(owner).inject({ method: 'DELETE', url: '/projects/p3' });
    expect(res.statusCode).toBe(200);
    expect(del).toHaveBeenCalledWith('p3');
    expect(publish).toHaveBeenCalledWith({ project_id: 'p3', is_public: false });
  });

  it('tells the public bus even for a project that was never public', async () => {
    const res = await buildDeleteApp(owner).inject({ method: 'DELETE', url: '/projects/p1' });
    expect(res.statusCode).toBe(200);
    expect(publish).toHaveBeenCalledWith({ project_id: 'p1', is_public: false });
  });
});

describe('machine links of a published project', () => {
  const gone = vi.spyOn(publicBus, 'publishRobotsGone');

  function buildLinkApp() {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = owner as never;
      request.scope = { user: owner, viewAs: { kind: 'self' }, ownerId: owner.id, createAs: owner.id } as never;
    });
    const repos = {
      projects: { findById: vi.fn(async (id: string) => PROJECTS[id]) },
      machines: { findById: vi.fn(async (id: string) => MACHINES[id] ?? { id, name: id, owner_id: 'u1' }) },
      projectMachines: {
        ...projectMachines,
        find: vi.fn(async (projectId: string, machineId: string) => LINKS.find((l) => l.project_id === projectId && l.machine_id === machineId)),
        link: vi.fn(async (l: { project_id: string; machine_id: string; cwd: string }) => ({ ...l, id: 'l', position: 1, created_at: '' })),
        unlink: vi.fn(async () => true),
      },
      tabs: { listByProjectMachine: vi.fn(async () => []), delete: vi.fn() },
    } as unknown as Repositories;
    app.register((a) => projectRoutes(a, repos, { simulators: { isReady: () => false } as never }), { prefix: '/projects' });
    return app;
  }

  beforeEach(() => {
    publish.mockClear();
    gone.mockClear();
  });

  // Merge ruling 2: a room is (published project, machine); unlinking takes that one room off the
  // street at once, without unpublishing the project (it keeps its rooms on its other machines).
  it("unlinking a machine drops that project's robots on it from open public pages, and unpublishes nothing", async () => {
    const res = await buildLinkApp().inject({ method: 'DELETE', url: '/projects/p3/machines/m1' });
    expect(res.statusCode).toBe(200);
    expect(gone).toHaveBeenCalledWith({ machine_id: 'm1', project_id: 'p3' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('linking a machine to a published project refreshes the public read', async () => {
    const res = await buildLinkApp().inject({ method: 'POST', url: '/projects/p3/machines', payload: { machine_id: 'm2', cwd: 'C:\\w' } });
    expect(res.statusCode).toBe(201);
    expect(publish).toHaveBeenCalledWith({ project_id: 'p3', is_public: true });
  });

  it('linking a machine to a private project tells the public bus nothing', async () => {
    const res = await buildLinkApp().inject({ method: 'POST', url: '/projects/p1/machines', payload: { machine_id: 'm2', cwd: 'C:\\w' } });
    expect(res.statusCode).toBe(201);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('PATCH /projects/:id ai_memory_lessons (TER-1021)', () => {
  beforeEach(() => {
    update.mockReset().mockImplementation(async (id: string, p: Record<string, unknown>) => ({ ...(PROJECTS[id] as object), ...p }));
    projectMachines.listAllWithOwner.mockClear();
  });

  it('saves the option and imports the project’s ai-memory pages right away when it is turned on', async () => {
    const res = await patch(owner, 'p1', { ai_memory_lessons: true });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith('p1', { ai_memory_lessons: true });
    await vi.waitFor(() => expect(projectMachines.listAllWithOwner).toHaveBeenCalledTimes(1));
  });

  it('turning it off imports nothing', async () => {
    const res = await patch(owner, 'p1', { ai_memory_lessons: false });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith('p1', { ai_memory_lessons: false });
    expect(projectMachines.listAllWithOwner).not.toHaveBeenCalled();
  });

  it('refuses a non-boolean value', async () => {
    const res = await patch(owner, 'p1', { ai_memory_lessons: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
