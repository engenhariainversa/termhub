import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { requireFeature } from '../features/flags.js';
import { ownProject, toRunView } from '../runs/view.js';

const listQuery = z.object({
  project: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * "Runs da API" in Progresso (TER-1176): the signed-in person's own API runs, newest first. Always
 * `request.user`, never `request.scope`: an admin "viewing as" someone does not get their runs, the
 * same rule as the tokens that create them. 404 while the `runs_api` flag is off for the person.
 */
export async function runsWebRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', { preHandler: requireFeature('runs_api', repos) }, async (request) => {
    const user = request.user!;
    const q = listQuery.parse(request.query);
    const project = q.project ? await ownProject(repos, user, q.project) : undefined;
    const runs = await repos.apiRuns.listForUser(user.id, { projectId: project?.id, limit: q.limit });
    return { runs: runs.map(toRunView) };
  });
}
