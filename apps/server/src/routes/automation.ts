import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { AUTOMATION_EVENTS_PAGE_MAX } from '../db/repositories/index.js';
import { requestLocale } from '../i18n/index.js';
import { controlContextForRequest } from '../control/context.js';
import { automationQueue } from '../automation/queue.js';
import { listAutomationEvents } from '../automation/events.js';
import { DEFAULT_FIXER_CI_TEXT, DEFAULT_FIXER_CONFLICT_TEXT, DEFAULT_IMPLEMENTER_TEXT, DEFAULT_INTEGRATOR_TEXT } from '../automation/prompts.js';
import { automationPauseState, pauseAutomation, resumeAutomation } from '../automation/pause.js';
import { projectUsage } from '../automation/usage.js';

const id = z.string().min(1).max(64);
const idParam = z.object({ id });

/** Mounted on /projects: the automatic-work queue of a project. */
export async function projectAutomationRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/automation/queue', async (request) => {
    const { id } = idParam.parse(request.params);
    return { items: await automationQueue(controlContextForRequest(repos, request), id, requestLocale(request)) };
  });
}

const eventsQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(AUTOMATION_EVENTS_PAGE_MAX).optional(),
});

/** A calendar day, `YYYY-MM-DD`, that exists (no 2026-02-30). */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const at = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === d;
  });
const usageQuery = z.object({ from: day.optional(), to: day.optional() });

/** Mounted on /projects (resource `projects`): what the automatic work did on a project, newest first. */
export async function projectAutomationEventRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/automation/events', async (request) => {
    const { id } = idParam.parse(request.params);
    const q = eventsQuery.parse(request.query);
    return { events: await listAutomationEvents(controlContextForRequest(repos, request), id, q) };
  });
  /** Tokens and the API-equivalent cost of the project's automatic tabs per card, epic and account (spec D23). */
  app.get('/:id/automation/usage', async (request) => {
    const { id } = idParam.parse(request.params);
    const q = usageQuery.parse(request.query);
    return projectUsage(controlContextForRequest(repos, request), id, q);
  });
}

/** `all` = every project of the person ("Pausar tudo"); otherwise a project id. */
const scope = z.union([z.literal('all'), id]);
const pauseBody = z.object({ scope, interrupt: z.boolean().optional() });
const resumeBody = z.object({ scope });

/** Mounted on /automation (resource `projects`, action `update`): the pause switch. */
export async function automationPauseRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/state', async (request) => automationPauseState(controlContextForRequest(repos, request)));
  /** The built-in middle paragraph of each role's prompt: the placeholder of the Setup textareas. */
  app.get('/prompt-defaults', async () => ({
    implementer: DEFAULT_IMPLEMENTER_TEXT,
    integrator: DEFAULT_INTEGRATOR_TEXT('a branch base'),
    fixer: `${DEFAULT_FIXER_CONFLICT_TEXT('a branch base')}\n${DEFAULT_FIXER_CI_TEXT}`,
  }));
  app.post('/pause', { config: { action: 'update' } }, async (request) => {
    return pauseAutomation(controlContextForRequest(repos, request), pauseBody.parse(request.body));
  });
  app.post('/resume', { config: { action: 'update' } }, async (request, reply) => {
    await resumeAutomation(controlContextForRequest(repos, request), resumeBody.parse(request.body));
    return reply.code(204).send();
  });
}
