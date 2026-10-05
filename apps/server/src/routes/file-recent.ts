import { fileRecentQuery } from '@termhub/mobile-api';
import type { FastifyInstance } from 'fastify';
import { scoped } from '../auth/scope.js';
import type { Repositories } from '../db/repositories/index.js';
import { recentFiles, type RecentDeps } from '../file-preview/recent.js';

/**
 * `GET /?project_id=` — a project's recent Markdown files (spec 2026-10-04 recent Markdown files D5). The
 * same plugin serves the web (`/api/file-recent`) and the app (`/api/m/v1/file-recent`), both under the
 * `terminals` resource. Only counts and machine ids are logged, never a path.
 */
export async function fileRecentRoutes(app: FastifyInstance, repos: Repositories, deps: RecentDeps = {}): Promise<void> {
  app.get('/', async (request) => {
    const q = fileRecentQuery.parse(request.query);
    const response = await recentFiles(repos, scoped(repos, request), q.project_id, deps, request.log);
    request.log.info(
      { project_id: q.project_id, items: response.items.length, cited: response.items.filter((i) => i.cited).length, skipped: response.skipped.map((s) => `${s.machine.id}:${s.reason}`) },
      'file recent',
    );
    return response;
  });
}
