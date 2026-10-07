import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { ACTIONS, RESOURCES, invalidatePermissionCache, isAction, isResource, isValidGrant } from '../auth/permissions.js';
import { audit } from '../auth/audit.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const roleBody = z.object({
  name: z.string().trim().min(2).max(40).regex(/^[A-Z][A-Z0-9_]*$/, 'use MAIÚSCULAS, dígitos e _'),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  is_admin: z.boolean().optional(),
});
const toggleBody = z.object({ resource: z.string(), action: z.string() });

/** Roles and their permission matrix. Guarded as resource "roles" (see app.ts). */
export async function roleRoutes(app: FastifyInstance, repos: Repositories) {
  /** Catalog for the matrix UI. */
  app.get('/resources', async () => ({ resources: RESOURCES, actions: ACTIONS }));

  app.get('/', async () => ({ roles: await repos.roles.list() }));

  app.post('/', async (request, reply) => {
    const body = roleBody.parse(request.body);
    if (await repos.roles.findByName(body.name)) throw conflict('Já existe uma role com esse nome');
    const role = await repos.roles.create(body);
    await audit(repos, request, 'role.create', { target: { type: 'role', id: role.id, label: role.name }, meta: { is_admin: role.is_admin } });
    return reply.code(201).send({ role });
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const patch = roleBody.omit({ name: true }).partial().parse(request.body);
    const role = await repos.roles.update(id, patch);
    if (!role) throw notFound('Role não encontrada');
    invalidatePermissionCache(id);
    await audit(repos, request, 'role.update', { target: { type: 'role', id: role.id, label: role.name }, meta: { fields: Object.keys(patch), is_admin: role.is_admin } });
    return { role };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const role = await repos.roles.findById(id);
    if (!role) throw notFound('Role não encontrada');
    if (role.is_system) throw badRequest('Roles do sistema não podem ser excluídas');
    if ((await repos.users.countByRole(id)) > 0) throw badRequest('Mova os usuários desta role antes de excluí-la');
    await repos.roles.delete(id);
    invalidatePermissionCache(id);
    await audit(repos, request, 'role.delete', { target: { type: 'role', id: role.id, label: role.name } });
    return { ok: true };
  });

  /** Matrix: one row per resource with its valid action flags (all four CRUD, plus 'write' only for terminals). */
  app.get('/:id/permissions', async (request) => {
    const { id } = idParam.parse(request.params);
    const role = await repos.roles.findById(id);
    if (!role) throw notFound('Role não encontrada');
    const set = new Set((await repos.roles.permissionsOf(id)).map((p) => `${p.resource}:${p.action}`));
    return {
      role,
      permissions: RESOURCES.map((r) => ({
        resource: r.key,
        label: r.label,
        ...Object.fromEntries(ACTIONS.filter((a) => isValidGrant(r.key, a)).map((a) => [a, role.is_admin || set.has(`${r.key}:${a}`)])),
      })),
    };
  });

  app.post('/:id/permissions/toggle', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { resource, action } = toggleBody.parse(request.body);
    if (!isResource(resource) || !isAction(action) || !isValidGrant(resource, action)) throw badRequest('Recurso ou ação inválidos');
    const role = await repos.roles.findById(id);
    if (!role) throw notFound('Role não encontrada');
    if (role.is_admin) throw badRequest('Roles de administrador têm acesso total');
    const granted = await repos.roles.toggle(id, resource, action);
    invalidatePermissionCache(id);
    await audit(repos, request, 'role.permission_toggle', { target: { type: 'role', id: role.id, label: role.name }, meta: { permission: `${resource}:${action}`, granted } });
    return { granted };
  });
}
