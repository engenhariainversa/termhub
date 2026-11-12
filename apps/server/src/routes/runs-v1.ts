import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { API_RUN_STATUSES } from '../db/repositories/api-runs.js';
import { installV1Auth } from '../runs/v1-auth.js';
import { ownProject, toRunView } from '../runs/view.js';
import { notFound } from '../lib/errors.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const listQuery = z.object({
  project: z.string().trim().min(1).max(64).optional(),
  status: z.enum(API_RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * The personal runs API, `/api/v1` (TER-1176, spec "Contract"): bearer-only, the token owner's own
 * runs. This card ships the reads; creating, streaming and cancelling come with the execution card.
 */
export async function runsV1Routes(app: FastifyInstance, repos: Repositories) {
  installV1Auth(app, repos);

  app.get('/runs', async (request) => {
    const { user } = request.runsAuth!;
    const q = listQuery.parse(request.query);
    const project = q.project ? await ownProject(repos, user, q.project) : undefined;
    if (project) request.runsProjectId = project.id;
    const runs = await repos.apiRuns.listForUser(user.id, { projectId: project?.id, status: q.status, limit: q.limit });
    return { runs: runs.map(toRunView) };
  });

  app.get('/runs/:id', async (request) => {
    const { user } = request.runsAuth!;
    const { id } = idParam.parse(request.params);
    const run = await repos.apiRuns.findForUser(user.id, id);
    if (!run) throw notFound('Run não encontrada');
    request.runsProjectId = run.project_id;
    return toRunView(run);
  });
}
