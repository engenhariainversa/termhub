import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import { UPLOAD_BODY_LIMIT, storeUpload } from '../chat/attachments/upload.js';
import { HttpError, badRequest, unauthorized } from '../lib/errors.js';
import { SlidingWindow } from '../mobile/rate-limit.js';
import { registerAttachmentReadRoutes, registerRawBody, uploadDepsOf, uploadQuery, type ChatAttachmentDeps } from './chat-attachments.js';

export const MOBILE_ATTACHMENT_UPLOADS_PER_10MIN = 30;

/**
 * `/api/m/v1/chat/attachments`: the web's attachment routes behind device auth and DPoP (the
 * prefix's own hook), plus a per-device sliding window on uploads, like `m-transcriptions.ts`.
 */
export async function mobileChatAttachmentRoutes(app: FastifyInstance, repos: Repositories, deps: ChatAttachmentDeps) {
  const limiter = new SlidingWindow(10 * 60_000, MOBILE_ATTACHMENT_UPLOADS_PER_10MIN);
  registerRawBody(app);
  const uploadDeps = uploadDepsOf(repos, deps);

  app.post('/', { bodyLimit: UPLOAD_BODY_LIMIT, config: { action: 'create' } }, async (request, reply) => {
    const mobile = request.mobile;
    if (!mobile || !('device' in mobile)) throw unauthorized();
    const { name, project_id } = uploadQuery.parse(request.query);
    // Checked before the limiter, so an empty upload never spends one of the device's slots.
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw badRequest('Arquivo vazio');
    if (!limiter.take(mobile.device.id)) throw new HttpError(429, 'Muitos envios de arquivo; tente de novo em alguns minutos', 'RATE_LIMITED');
    const attachment = await storeUpload(uploadDeps, request.scope.user, { name, projectId: project_id ?? null, body: request.body, log: request.log });
    return reply.code(201).send({ attachment });
  });

  registerAttachmentReadRoutes(app, repos, deps.store);
}
