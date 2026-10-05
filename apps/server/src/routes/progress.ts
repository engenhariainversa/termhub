import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { progressResponse, progressScope } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import { canAccess } from '../auth/permissions.js';
import { scoped } from '../auth/scope.js';
import { aggregateEpic, feedOf, selectEpics } from '../progress/aggregate.js';
import { requestLocale } from '../i18n/index.js';
import { ciErrorOf } from '../ci/status.js';

/** The feed's length: the last 50 events (spec D25). */
export const FEED_LIMIT = 50;

const query = z.object({ project_id: z.string().min(1).max(64).optional(), scope: progressScope.default('active') });

/**
 * The progress panel (spec 2026-09-26 progress-panel §4.5), mounted at /api/progress and, for the
 * phone, /api/m/v1/progress. Guarded as `tasks`; agents (tab names and states) only with terminals:read.
 */
export async function progressRoutes(app: FastifyInstance, repos: Repositories, deps: { now?: () => Date } = {}) {
  app.get('/', async (request) => {
    const q = query.parse(request.query ?? {});
    if (q.project_id) await scoped(repos, request).project(q.project_id);
    const includeAgents = await canAccess(repos, request.user, 'terminals', 'read');
    const where = { owner: request.scope.ownerId, projectId: q.project_id ?? null };
    // someone who never ran automatic work pays for no automation query on the poll
    const automatic = await repos.progress.usesAutomation(where);
    const rows = await repos.progress.list({ ...where, automatic });
    const feed = automatic ? feedOf(await repos.progress.feed({ ...where, limit: FEED_LIMIT }), requestLocale(request), includeAgents) : [];
    const aggregated = rows.map((e) => ({ ...aggregateEpic(e, includeAgents), ci_error: ciErrorOf(e.project.id) }));
    const epics = selectEpics(aggregated, q.scope);
    return progressResponse.parse({ epics, feed, generated_at: (deps.now?.() ?? new Date()).toISOString() });
  });
}
