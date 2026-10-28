import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { describeProjectAi, projectAiBody, requestAiScope, saveProjectAi } from '../setup/project-ai.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/**
 * The project's AI accounts and default models (TER-589), under `/projects` for the web and the phone
 * alike: its own endpoint, so the setup form and the phone never overwrite each other's edit.
 */
export async function projectAiRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/setup/ai', async (request) => {
    const { id } = idParam.parse(request.params);
    return describeProjectAi(repos, requestAiScope(repos, request), id);
  });

  app.put('/:id/setup/ai', async (request) => {
    const { id } = idParam.parse(request.params);
    const { ai } = projectAiBody.parse(request.body);
    return saveProjectAi(repos, requestAiScope(repos, request), id, ai);
  });
}
