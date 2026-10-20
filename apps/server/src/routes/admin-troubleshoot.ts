import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { isAdmin } from '../auth/permissions.js';
import { ControlError } from '../control/context.js';
import { TROUBLESHOOT_REQUESTS_MAX, troubleshoot, troubleshootReason, troubleshootRoutePrefix, type TroubleshootActor, type TroubleshootInput } from '../control/user-troubleshoot.js';
import { forbidden, HttpError } from '../lib/errors.js';

const userEndpoint = z.enum(['requests', 'tabs', 'machines', 'errors', 'client']);

const searchQuery = z.object({ reason: troubleshootReason, q: z.string().trim().min(2).max(200) });

const userQuery = z.object({
  reason: troubleshootReason,
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  route_prefix: troubleshootRoutePrefix.optional(),
  limit: z.coerce.number().int().min(1).max(TROUBLESHOOT_REQUESTS_MAX).optional(),
});

const userParams = z.object({ id: z.string().min(1).max(64), endpoint: userEndpoint });

/**
 * Admin troubleshooting of one user (TER-1092), read only: `GET /users?q=&reason=` finds a user by name or
 * e-mail (answers ids and names, never the e-mail), `GET /users/:id/:endpoint?reason=` reads one view
 * (requests, tabs, machines, errors, client) in a window of 12 h by default, 7 days at most. Admins only —
 * not a grantable permission: a role an admin gives `users:read` still gets 403. Every call needs a reason
 * and lands on the security trail before anything is read (control/user-troubleshoot.ts).
 */
export async function adminTroubleshootRoutes(app: FastifyInstance, repos: Repositories) {
  app.addHook('preHandler', async (request) => {
    if (!(await isAdmin(repos, request.user))) throw forbidden('Só administradores podem consultar dados de suporte');
  });

  const actorOf = (request: { user?: { id: string; email: string } | null; ip: string }): TroubleshootActor => ({
    id: request.user!.id,
    email: request.user!.email,
    ip: request.ip || null,
    via: 'api',
  });

  const run = async (actor: TroubleshootActor, input: TroubleshootInput, log: FastifyInstance['log']) => {
    try {
      return await troubleshoot({ repos, log }, actor, input);
    } catch (e) {
      if (!(e instanceof ControlError)) throw e;
      throw new HttpError(e.code === 'USER_NOT_FOUND' ? 404 : 400, e.localized, e.code);
    }
  };

  app.get('/users', async (request) => {
    const q = searchQuery.parse(request.query);
    return run(actorOf(request), { endpoint: 'search', reason: q.reason, query: q.q }, request.log);
  });

  app.get('/users/:id/:endpoint', async (request) => {
    const p = userParams.parse(request.params);
    const q = userQuery.parse(request.query);
    return run(actorOf(request), { endpoint: p.endpoint, user_id: p.id, reason: q.reason, from: q.from, to: q.to, route_prefix: q.route_prefix, limit: q.limit }, request.log);
  });
}
