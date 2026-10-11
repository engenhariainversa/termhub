import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { ProjectGroupRuleError, type ProjectGroup } from '../db/repositories/project-groups.js';
import { HttpError } from '../lib/errors.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const nameBody = z.object({ name: z.string().trim().min(1).max(40) });
const orderBody = z.object({ ids: z.array(z.string().min(1).max(64)).max(100) });
const membershipsBody = z.object({
  groups: z.array(z.object({ id: z.string().min(1).max(64), project_ids: z.array(z.string().min(1).max(64)).max(500) })).min(1).max(100),
});

/** A group is a personal view: every route only needs to read projects. */
const READ = { config: { action: 'read' } };

async function rule<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ProjectGroupRuleError) {
      const status = e.code === 'SYSTEM_GROUP' ? 409 : e.code === 'NOT_FOUND' ? 404 : 400;
      throw new HttpError(status, e.localized, e.code);
    }
    throw e;
  }
}

/** Sidebar groups of the signed-in user (never the view-as owner); members shown are the ones the current scope can see. */
export async function projectGroupRoutes(app: FastifyInstance, repos: Repositories) {
  const visibleIds = async (request: FastifyRequest) => new Set((await repos.projects.list({ owner: request.scope.ownerId })).map((p) => p.id));
  const filtered = (groups: ProjectGroup[], visible: Set<string>) => groups.map((g) => ({ ...g, project_ids: g.project_ids.filter((id) => visible.has(id)) }));

  app.get('/', READ, async (request) => {
    const [groups, visible] = await Promise.all([repos.projectGroups.list(request.user!.id), visibleIds(request)]);
    return { groups: filtered(groups, visible) };
  });

  app.post('/', READ, async (request, reply) => {
    const { name } = nameBody.parse(request.body);
    const group = await rule(() => repos.projectGroups.create(request.user!.id, name));
    return reply.code(201).send({ group });
  });

  app.patch('/:id', READ, async (request) => {
    const { id } = idParam.parse(request.params);
    const { name } = nameBody.parse(request.body);
    const group = await rule(() => repos.projectGroups.rename(request.user!.id, id, name));
    return { group: filtered([group], await visibleIds(request))[0] };
  });

  app.delete('/:id', READ, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await rule(() => repos.projectGroups.delete(request.user!.id, id));
    return reply.code(204).send();
  });

  app.put('/order', READ, async (request) => {
    const { ids } = orderBody.parse(request.body);
    const groups = await rule(() => repos.projectGroups.reorder(request.user!.id, ids));
    return { groups: filtered(groups, await visibleIds(request)) };
  });

  app.put('/memberships', READ, async (request) => {
    const { groups: changes } = membershipsBody.parse(request.body);
    const visible = await visibleIds(request);
    if (changes.some((c) => c.project_ids.some((id) => !visible.has(id)))) throw new HttpError(404, 'Projeto não encontrado', 'PROJECT_NOT_FOUND');
    const groups = await rule(() => repos.projectGroups.setMemberships(request.user!.id, changes, (id) => visible.has(id)));
    return { groups: filtered(groups, visible) };
  });
}
