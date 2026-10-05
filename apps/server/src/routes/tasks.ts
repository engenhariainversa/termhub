import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { MAX_SUBTASKS_PER_CALL, TaskRuleError, type TaskRuleCode } from '../db/repositories/tasks.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const refParam = z.object({ ref: z.string().min(1).max(32) });
const rowId = z.string().min(1).max(64);
const statusSchema = z.enum(['backlog', 'todo', 'doing', 'done']);
const typeSchema = z.enum(['epic', 'story', 'task', 'subtask', 'bug', 'spike']);
const position = z.number().int().min(0).max(10_000);

const taskFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(5000).optional().nullable(),
  status: statusSchema.optional(),
};
const createBody = z.object({
  ...taskFields,
  type: typeSchema.optional(),
  epic_id: rowId.optional().nullable(),
  column_id: rowId.optional().nullable(),
  parent_id: rowId.optional().nullable(),
});
/** No parent_id and no column_id: a task is never reparented, and a column change is a move (zod strips both). */
const patchBody = z.object({ ...taskFields, type: typeSchema, epic_id: rowId.nullable() }).partial();
/** Exactly one target: strict objects make `{ column_id, status, … }` match neither branch. */
const moveBody = z.union([z.object({ column_id: rowId, position }).strict(), z.object({ status: statusSchema, position }).strict()]);
const subtasksBody = z.object({
  items: z
    .array(z.object({ title: taskFields.title, description: taskFields.description }))
    .min(1)
    .max(MAX_SUBTASKS_PER_CALL),
});
const reorderBody = z.object({ position });

/** Rules that conflict with what the board holds (spec §9): 409 instead of 400. */
const CONFLICTS = new Set<TaskRuleCode>(['EPIC_HAS_CHILDREN', 'COLUMN_LAST_OF_CATEGORY']);

/** Board rules live in the repositories; a broken one is the client's mistake (400) or a conflict (409). */
export async function taskRules<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof TaskRuleError) throw CONFLICTS.has(e.code) ? conflict(e.localized) : badRequest(e.localized);
    throw e;
  }
}

/** Mounted at /projects: a project's board (list) and new cards. */
export async function projectTaskRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/tasks', async (request) => {
    const { id } = idParam.parse(request.params);
    const { project } = await scoped(repos, request).project(id);
    // listByProject heals rows from the previous release first, columns included
    const tasks = await repos.tasks.listByProject(id);
    return { tasks, columns: await repos.taskColumns.list(id), agent_column_id: project.agent_column_id };
  });

  app.post('/:id/tasks', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const body = createBody.parse(request.body);
    return reply.code(201).send({ task: await taskRules(() => repos.tasks.create(id, body)) });
  });
}

/** Mounted at /tasks: one card by id (edit, move, subtasks, delete) or by ref. */
export async function taskRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/by-ref/:ref', async (request) => {
    const { ref } = refParam.parse(request.params);
    const { task, project } = await scoped(repos, request).taskByRef(ref);
    return { task, project_id: project.id };
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const body = patchBody.parse(request.body);
    await scoped(repos, request).task(id);
    const task = await taskRules(() => repos.tasks.update(id, body));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.post('/:id/move', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = moveBody.parse(request.body);
    await scoped(repos, request).task(id);
    const target = 'column_id' in body ? { column_id: body.column_id } : { status: body.status };
    const task = await taskRules(() => repos.tasks.move(id, target, body.position));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.post('/:id/subtasks', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = subtasksBody.parse(request.body ?? {});
    const { task } = await scoped(repos, request).task(id);
    return reply.code(201).send({ subtasks: await taskRules(() => repos.tasks.createSubtasks(id, body.items, task.project_id)) });
  });

  app.post('/:id/reorder', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = reorderBody.parse(request.body ?? {});
    await scoped(repos, request).task(id);
    const task = await taskRules(() => repos.tasks.reorder(id, body.position));
    if (!task) throw notFound('Task não encontrada');
    return { task };
  });

  app.get('/:id/pull-requests', async (request) => {
    const { id } = idParam.parse(request.params);
    const { task } = await scoped(repos, request).task(id);
    const rows = await repos.taskPullRequests.listByTasks([task.parent_id ?? task.id]);
    const pull_requests = rows.map(({ number, url, title, state, draft, ci_state, ci_summary, deploy_state, deploy_url }) => ({ number, url, title, state, draft, ci_state, ci_summary, deploy_state, deploy_url }));
    return { pull_requests };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).task(id);
    const children = await repos.tasks.childIds(id);
    // Delete first: an epic with cards is refused (409), and must leave its ticket (and any child's) linked.
    if (!(await taskRules(() => repos.tasks.delete(id)))) throw notFound('Task não encontrada');
    // tickets point at tasks by id with no FK: unlink the whole subtree so they show as "não importado" again
    for (const taskId of [id, ...children]) await repos.tickets.unlinkTask(taskId);
    return { ok: true, deleted_subtasks: children.length };
  });
}
