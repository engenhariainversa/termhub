import { filePreviewQuery } from '@termhub/mobile-api';
import type { FastifyInstance } from 'fastify';
import { scoped } from '../auth/scope.js';
import type { Repositories } from '../db/repositories/index.js';
import { previewFile, type PreviewDeps } from '../file-preview/core.js';

/**
 * `GET /` — a text file previewed from a path an answer named (spec 2026-10-04 file preview §4). The same
 * plugin serves the web (`/api/file-preview`) and the app (`/api/m/v1/file-preview`), both under the
 * `terminals` resource. Only metadata is logged: the machine, the status and the size, never the body.
 */
export async function filePreviewRoutes(app: FastifyInstance, repos: Repositories, deps: PreviewDeps = {}): Promise<void> {
  app.get('/', async (request) => {
    const q = filePreviewQuery.parse(request.query);
    const { response, machineId } = await previewFile(repos, scoped(repos, request), q, deps);
    request.log.info({ machine_id: machineId, status: response.status, size: 'size' in response ? response.size : undefined }, 'file preview');
    return response;
  });
}
