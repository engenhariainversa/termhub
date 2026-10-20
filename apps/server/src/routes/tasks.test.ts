import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { TaskRuleError } from '../db/repositories/tasks.js';
import type { Task, TaskColumn } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { projectTaskRoutes, taskRoutes } from './tasks.js';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1',
  type: 'task',
  number: 1,
  ref: `P1-${over.number ?? 1}`,
  title: over.id,
  description: null,
  status: 'todo',
  position: 0,
  external_ref: null,
  external_key: null,
  tab_id: null,
  parent_id: null,
  epic_id: 'e1',
  column_id: 'c1',
  created_at: '',
  updated_at: '',
  ...over,
});
const column: TaskColumn = { id: 'c1', project_id: 'p1', name: 'A fazer', category: 'todo', position: 0, created_at: '' };
const projects = [
  { id: 'p1', key: 'P1', owner_id: 'u1', agent_column_id: 'c2' },
  { id: 'p2', key: 'OTR', owner_id: 'u2', agent_column_id: null },
];

/** Routes over stubbed repositories and a fixed request scope (ownerId null = admin "all"). */
function buildApp(tasks: Record<string, Task>, ownerId: string | null = null) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId, createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const tasksRepo = {
    findById: vi.fn(async (id: string) => tasks[id]),
    findByRef: vi.fn(async (projectId: string, n: number) => Object.values(tasks).find((t) => t.project_id === projectId && t.number === n)),
    listByProject: vi.fn(async () => Object.values(tasks)),
    create: vi.fn(async (_p: string, input: { title: string; parent_id?: string | null }) => task({ id: 'new', title: input.title, parent_id: input.parent_id ?? null })),
    createSubtasks: vi.fn(async (parentId: string, items: { title: string }[]) => items.map((it, i) => task({ id: `s${i}`, title: it.title, parent_id: parentId, position: i }))),
    reorder: vi.fn(async (id: string, position: number) => ({ ...tasks[id], position })),
    childIds: vi.fn(async (id: string) => Object.values(tasks).filter((t) => t.parent_id === id).map((t) => t.id)),
    update: vi.fn(async (id: string, patch: Partial<Task>) => ({ ...tasks[id], ...patch })),
    move: vi.fn(async (id: string) => tasks[id]),
    delete: vi.fn(async () => true),
  };
  const unlinkTask = vi.fn(async () => {});
  const taskPullRequests = {
    listByTasks: vi.fn(async (ids: string[]) =>
      ids.includes('t1')
        ? [{ number: 7, url: 'u', title: 'x', state: 'open', draft: false, ci_state: 'passed', ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null, head_sha: 'abc', task_id: 't1' }]
        : [],
    ),
  };
  const feed = vi.fn(async (_opts: { taskIds?: string[] }) => [
    {
      event: { id: 'v1', project_id: 'p1', task_id: 't1', run_id: 'r1', kind: 'pr_opened' as const, payload: { pr: 9, url: 'https://gh/pr/9', branch: 'b1' }, created_at: '2026-10-06T00:00:00.000Z' },
      ref: 'P1-1',
      epic: null,
      machine: 'jarvis',
      account: null,
      tab_id: 'tab1',
      branch: 'b1',
    },
  ]);
  const repos = {
    tasks: tasksRepo,
    progress: { feed },
    tickets: { unlinkTask },
    taskColumns: { list: vi.fn(async () => [column]) },
    taskPullRequests,
    projects: {
      findById: vi.fn(async (id: string) => projects.find((p) => p.id === id)),
      findByKey: vi.fn(async (key: string) => projects.find((p) => p.key === key)),
    },
  } as unknown as Repositories;
  app.register((a) => projectTaskRoutes(a, repos), { prefix: '/projects' });
  app.register((a) => taskRoutes(a, repos), { prefix: '/tasks' });
  return { app, tasksRepo, unlinkTask, feed };
}

let store: Record<string, Task>;
beforeEach(() => {
  store = {
    t1: task({ id: 't1' }),
    c1: task({ id: 'c1', parent_id: 't1', type: 'subtask', number: 2, epic_id: null, column_id: null }),
    c2: task({ id: 'c2', parent_id: 't1', type: 'subtask', number: 3, epic_id: null, column_id: null, position: 1 }),
    x9: task({ id: 'x9', project_id: 'p2', number: 1, ref: 'OTR-1' }),
  };
});

describe('task routes: board', () => {
  it('lists the tasks with the columns and the agent column', async () => {
    const { app } = buildApp(store);
    const r = await app.inject({ method: 'GET', url: '/projects/p1/tasks' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ columns: [column], agent_column_id: 'c2' });
    expect(r.json().tasks).toHaveLength(4);
  });

  it('creates with type, epic and column', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/projects/p1/tasks', payload: { title: ' x ', type: 'story', epic_id: 'e1', column_id: 'c1' } });
    expect(r.statusCode).toBe(201);
    expect(tasksRepo.create).toHaveBeenCalledWith('p1', { title: 'x', type: 'story', epic_id: 'e1', column_id: 'c1' });
  });

  it('rejects an unknown type before calling the repository', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/projects/p1/tasks', payload: { title: 'x', type: 'feature' } });
    expect(r.statusCode).toBe(400);
    expect(tasksRepo.create).not.toHaveBeenCalled();
  });

  it('patches type and epic, and turns a broken rule into a 400 with its message', async () => {
    const { app, tasksRepo } = buildApp(store);
    expect((await app.inject({ method: 'PATCH', url: '/tasks/t1', payload: { type: 'bug', epic_id: 'e2' } })).statusCode).toBe(200);
    expect(tasksRepo.update).toHaveBeenCalledWith('t1', { type: 'bug', epic_id: 'e2' });
    tasksRepo.update.mockRejectedValueOnce(new TaskRuleError('HAS_SUBTASKS'));
    const r = await app.inject({ method: 'PATCH', url: '/tasks/t1', payload: { type: 'bug' } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'Tire as subtarefas antes de mudar para bug ou spike', code: 'BAD_REQUEST' });
  });

  it.each([
    [{ column_id: 'c2', position: 0 }, { column_id: 'c2' }, 0],
    [{ status: 'done', position: 2 }, { status: 'done' }, 2],
  ])('moves to %j', async (payload, target, position) => {
    const { app, tasksRepo } = buildApp(store);
    expect((await app.inject({ method: 'POST', url: '/tasks/t1/move', payload })).statusCode).toBe(200);
    expect(tasksRepo.move).toHaveBeenCalledWith('t1', target, position);
  });

  it.each([
    ['both targets', { column_id: 'c2', status: 'done', position: 0 }],
    ['no target', { position: 0 }],
    ['no position', { status: 'done' }],
    ['a negative position', { status: 'done', position: -1 }],
  ])('refuses a move with %s', async (_name, payload) => {
    const { app, tasksRepo } = buildApp(store);
    expect((await app.inject({ method: 'POST', url: '/tasks/t1/move', payload })).statusCode).toBe(400);
    expect(tasksRepo.move).not.toHaveBeenCalled();
  });

  it('answers 409 when deleting an epic that still has cards, and leaves its tickets linked', async () => {
    const { app, tasksRepo, unlinkTask } = buildApp(store);
    tasksRepo.delete.mockRejectedValueOnce(new TaskRuleError('EPIC_HAS_CHILDREN'));
    const r = await app.inject({ method: 'DELETE', url: '/tasks/t1' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'Este épico ainda tem cards', code: 'CONFLICT' });
    expect(unlinkTask).not.toHaveBeenCalled();
  });
});

describe('task routes: by ref', () => {
  it('finds a card by KEY-N, the key case-insensitive', async () => {
    const { app } = buildApp(store, 'u1');
    const r = await app.inject({ method: 'GET', url: '/tasks/by-ref/p1-2' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ project_id: 'p1', task: { id: 'c1', parent_id: 't1' } });
  });

  it.each(['OTR-1', 'P1-99', 'NOPE-1', 'garbage'])('answers 404 for %s (another owner, unknown number or key, not a ref)', async (ref) => {
    const { app } = buildApp(store, 'u1');
    const r = await app.inject({ method: 'GET', url: `/tasks/by-ref/${ref}` });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('Card não encontrado');
  });
});

describe('task routes: subtasks', () => {
  it('creates subtasks in bulk, scoped to the parent project', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/tasks/t1/subtasks', payload: { items: [{ title: ' a ' }, { title: 'b', description: 'd' }] } });
    expect(r.statusCode).toBe(201);
    expect(r.json().subtasks.map((s: Task) => s.title)).toEqual(['a', 'b']);
    expect(tasksRepo.createSubtasks).toHaveBeenCalledWith('t1', [{ title: 'a' }, { title: 'b', description: 'd' }], 'p1');
  });

  it.each([
    ['no items', { items: [] }],
    ['51 items', { items: Array.from({ length: 51 }, (_, i) => ({ title: `t${i}` })) }],
    ['a whitespace-only title', { items: [{ title: 'ok' }, { title: '   ' }] }],
    ['a missing body', undefined],
  ])('rejects %s with 400 and creates nothing', async (_name, payload) => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/tasks/t1/subtasks', payload });
    expect(r.statusCode).toBe(400);
    expect(tasksRepo.createSubtasks).not.toHaveBeenCalled();
  });

  it('answers 404 for a parent outside the scope, without calling the repository', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/tasks/missing/subtasks', payload: { items: [{ title: 'a' }] } });
    expect(r.statusCode).toBe(404);
    expect(tasksRepo.createSubtasks).not.toHaveBeenCalled();
  });

  it('turns a repository rule error into a 400 with its message', async () => {
    const { app, tasksRepo } = buildApp(store);
    tasksRepo.createSubtasks.mockRejectedValueOnce(new TaskRuleError('PARENT_IS_SUBTASK', 'Uma subtarefa não pode ter subtarefas'));
    const r = await app.inject({ method: 'POST', url: '/tasks/c1/subtasks', payload: { items: [{ title: 'a' }] } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'Uma subtarefa não pode ter subtarefas', code: 'BAD_REQUEST' });
  });

  it('passes parent_id through on the project create route', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'POST', url: '/projects/p1/tasks', payload: { title: 'child', parent_id: 't1' } });
    expect(r.statusCode).toBe(201);
    expect(tasksRepo.create).toHaveBeenCalledWith('p1', { title: 'child', parent_id: 't1' });
  });

  it('does not let PATCH reparent a task or set its column', async () => {
    const { app, tasksRepo } = buildApp(store);
    const r = await app.inject({ method: 'PATCH', url: '/tasks/c1', payload: { status: 'done', parent_id: 'other', column_id: 'c2' } });
    expect(r.statusCode).toBe(200);
    expect(tasksRepo.update).toHaveBeenCalledWith('c1', { status: 'done' });
  });

  it('reorders a subtask and validates the position', async () => {
    const { app, tasksRepo } = buildApp(store);
    expect((await app.inject({ method: 'POST', url: '/tasks/c2/reorder', payload: { position: 0 } })).statusCode).toBe(200);
    expect(tasksRepo.reorder).toHaveBeenCalledWith('c2', 0);
    expect((await app.inject({ method: 'POST', url: '/tasks/c2/reorder', payload: { position: -1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/tasks/c2/reorder', payload: { position: 1.5 } })).statusCode).toBe(400);
  });

  it('maps a move of a subtask to 400', async () => {
    const { app, tasksRepo } = buildApp(store);
    tasksRepo.move.mockRejectedValueOnce(new TaskRuleError('SUBTASK_CANNOT_MOVE'));
    const r = await app.inject({ method: 'POST', url: '/tasks/c1/move', payload: { status: 'done', position: 0 } });
    expect(r.statusCode).toBe(400);
  });

  it('unlinks the tickets of the parent and of every child after a successful delete', async () => {
    const { app, tasksRepo, unlinkTask } = buildApp(store);
    const r = await app.inject({ method: 'DELETE', url: '/tasks/t1' });
    expect(r.json()).toEqual({ ok: true, deleted_subtasks: 2 });
    expect(unlinkTask.mock.calls.map((c) => c[0]).sort()).toEqual(['c1', 'c2', 't1']);
    // unlink runs only once the delete has actually gone through — a refused delete must not touch tickets
    expect(unlinkTask.mock.invocationCallOrder.every((n) => n > tasksRepo.delete.mock.invocationCallOrder[0])).toBe(true);
  });
});

describe('task routes: pull requests', () => {
  it('lists the card PRs as badges, without internal fields', async () => {
    const { app } = buildApp(store);
    const r = await app.inject({ method: 'GET', url: '/tasks/t1/pull-requests' });
    expect(r.statusCode).toBe(200);
    expect(r.json().pull_requests).toEqual([{ number: 7, url: 'u', title: 'x', state: 'open', draft: false, ci_state: 'passed', ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null }]);
  });

  it('answers the parent PRs for a subtask', async () => {
    const { app } = buildApp(store);
    expect((await app.inject({ method: 'GET', url: '/tasks/c1/pull-requests' })).json().pull_requests).toHaveLength(1);
  });

  it('is 404 outside the scope', async () => {
    const { app } = buildApp(store, 'u1');
    expect((await app.inject({ method: 'GET', url: '/tasks/x9/pull-requests' })).statusCode).toBe(404);
  });
});

describe('task routes: activity (the card page)', () => {
  it('reads the automatic events of the card and its subtasks', async () => {
    const { app, feed } = buildApp(store, 'u1');
    const r = await app.inject({ method: 'GET', url: '/tasks/t1/activity' });
    expect(r.statusCode).toBe(200);
    expect(feed).toHaveBeenCalledWith(expect.objectContaining({ owner: 'u1', projectId: 'p1', taskIds: ['t1', 'c1', 'c2'] }));
    expect(r.json().events).toEqual([expect.objectContaining({ id: 'v1', kind: 'pr_opened', ref: 'P1-1', pr: 9, url: 'https://gh/pr/9' })]);
  });

  it('leaves the machine, the tab and the branch out without terminals:read', async () => {
    const { app } = buildApp(store, 'u1');
    expect((await app.inject({ method: 'GET', url: '/tasks/t1/activity' })).json().events[0]).toMatchObject({ machine: null, tab_id: null, branch: null });
  });

  it('is 404 outside the scope', async () => {
    const { app, feed } = buildApp(store, 'u1');
    expect((await app.inject({ method: 'GET', url: '/tasks/x9/activity' })).statusCode).toBe(404);
    expect(feed).not.toHaveBeenCalled();
  });
});
