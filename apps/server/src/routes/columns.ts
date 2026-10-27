import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { COLUMN_NAME_MAX, MAX_COLUMNS } from '../db/repositories/task-rules.js';
import type { TaskColumn } from '../db/repositories/types.js';
import { notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { taskRules } from './tasks.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const name = z.string().trim().min(1).max(COLUMN_NAME_MAX);
const category = z.enum(['todo', 'doing', 'done']);
const waiting = z.boolean();
const createBody = z.object({ name, category, waiting: waiting.optional() });
const patchBody = z
  .object({ name, category, waiting })
  .partial()
  .refine((b) => b.name !== undefined || b.category !== undefined || b.waiting !== undefined, { message: 'Informe name, category ou waiting' });
const moveBody = z.object({ position: z.number().int().min(0).max(MAX_COLUMNS) });
const agentBody = z.object({ column_id: z.string().min(1).max(64).nullable() });

/** Mounted at /projects: a project's board columns and its agent column (spec §5 "Columns"). */
export async function projectColumnRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/columns', async (request) => {
    const { id } = idParam.parse(request.params);
    const { project } = await scoped(repos, request).project(id);
    await repos.taskColumns.ensureDefaults(id);
    return { columns: await repos.taskColumns.list(id), agent_column_id: project.agent_column_id };
  });

  app.post('/:id/columns', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const body = createBody.parse(request.body);
    return reply.code(201).send({ column: await taskRules(() => repos.taskColumns.create(id, body)) });
  });

  app.put('/:id/agent-column', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const { column_id } = agentBody.parse(request.body ?? {});
    await taskRules(() => repos.taskColumns.setAgentColumn(id, column_id));
    return { agent_column_id: column_id };
  });
}

/** Mounted at /columns: one column by id. */
export async function columnRoutes(app: FastifyInstance, repos: Repositories) {
  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const body = patchBody.parse(request.body ?? {});
    let column: TaskColumn | undefined = (await scoped(repos, request).column(id)).column;
    const next = body.category;
    // category first: a refused re-categorization leaves the name untouched too
    if (next !== undefined) column = await taskRules(() => repos.taskColumns.setCategory(id, next));
    if (body.waiting !== undefined) column = await taskRules(() => repos.taskColumns.setWaiting(id, body.waiting as boolean));
    if (body.name !== undefined) column = await repos.taskColumns.rename(id, body.name);
    if (!column) throw notFound('Coluna não encontrada');
    return { column };
  });

  app.post('/:id/move', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = moveBody.parse(request.body ?? {});
    await scoped(repos, request).column(id);
    const columns = await repos.taskColumns.move(id, body.position);
    if (!columns) throw notFound('Coluna não encontrada');
    return { columns };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).column(id);
    const r = await taskRules(() => repos.taskColumns.delete(id));
    if (!r) throw notFound('Coluna não encontrada');
    return { ok: true, moved_tasks: r.moved_tasks };
  });
}
