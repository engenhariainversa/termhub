import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { controlContextForRequest } from '../control/context.js';
import { automationQueue } from '../automation/queue.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** Mounted on /projects: the automatic-work queue of a project. */
export async function projectAutomationRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/automation/queue', async (request) => {
    const { id } = idParam.parse(request.params);
    return { items: await automationQueue(controlContextForRequest(repos, request), id) };
  });
}
