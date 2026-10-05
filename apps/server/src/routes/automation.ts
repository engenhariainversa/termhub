import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { AUTOMATION_EVENTS_PAGE_MAX } from '../db/repositories/index.js';
import { controlContextForRequest } from '../control/context.js';
import { automationQueue } from '../automation/queue.js';
import { listAutomationEvents } from '../automation/events.js';
import { automationPauseState, pauseAutomation, resumeAutomation } from '../automation/pause.js';

const id = z.string().min(1).max(64);
const idParam = z.object({ id });

/** Mounted on /projects: the automatic-work queue of a project. */
export async function projectAutomationRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/automation/queue', async (request) => {
    const { id } = idParam.parse(request.params);
    return { items: await automationQueue(controlContextForRequest(repos, request), id) };
  });
}

const eventsQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(AUTOMATION_EVENTS_PAGE_MAX).optional(),
});

/** Mounted on /projects (resource `projects`): what the automatic work did on a project, newest first. */
export async function projectAutomationEventRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/automation/events', async (request) => {
    const { id } = idParam.parse(request.params);
    const q = eventsQuery.parse(request.query);
    return { events: await listAutomationEvents(controlContextForRequest(repos, request), id, q) };
  });
}

/** `all` = every project of the person ("Pausar tudo"); otherwise a project id. */
const scope = z.union([z.literal('all'), id]);
const pauseBody = z.object({ scope, interrupt: z.boolean().optional() });
const resumeBody = z.object({ scope });

/** Mounted on /automation (resource `projects`, action `update`): the pause switch. */
export async function automationPauseRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/state', async (request) => automationPauseState(controlContextForRequest(repos, request)));
  app.post('/pause', { config: { action: 'update' } }, async (request) => {
    return pauseAutomation(controlContextForRequest(repos, request), pauseBody.parse(request.body));
  });
  app.post('/resume', { config: { action: 'update' } }, async (request, reply) => {
    await resumeAutomation(controlContextForRequest(repos, request), resumeBody.parse(request.body));
    return reply.code(204).send();
  });
}
