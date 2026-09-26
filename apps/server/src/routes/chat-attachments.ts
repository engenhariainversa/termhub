import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { toPublicAttachment } from '../db/repositories/chat-attachments.js';
import type { ChatService } from '../chat/service.js';
import type { ExtractionQueue } from '../chat/attachments/queue.js';
import type { AttachmentStore } from '../chat/attachments/store.js';
import { UPLOAD_BODY_LIMIT, downloadHeaders, storeUpload, type UploadDeps } from '../chat/attachments/upload.js';
import { conflict, notFound } from '../lib/errors.js';

export interface ChatAttachmentDeps {
  service: Pick<ChatService, 'conversationFor'>;
  store: AttachmentStore;
  queue: Pick<ExtractionQueue, 'enqueue'>;
  quotaBytes: number;
}

export const uploadQuery = z.object({ name: z.string().min(1).max(200), project_id: z.string().min(1).max(64).optional() });
/** Id-shaped or nothing: this is also the guard that keeps a param out of any path. */
export const attachmentIdParam = z.object({ id: z.string().regex(/^[a-z0-9]{1,64}$/) });
const attachmentNotFound = () => notFound('Anexo não encontrado');

/**
 * Every content type becomes a Buffer, in this plugin only: an upload is bytes, whatever the client
 * labels them. Fastify's built-in `text/plain` parser would otherwise hand a `.txt` upload over as a
 * string, so it is dropped here (plugin-scoped); JSON keeps its parser, and `storeUpload` refuses
 * the object it yields.
 */
export function registerRawBody(app: FastifyInstance): void {
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT }, (_req, body, done) => done(null, body));
}

export function uploadDepsOf(repos: Repositories, deps: ChatAttachmentDeps): UploadDeps {
  return { repo: repos.chatAttachments, store: deps.store, queue: deps.queue, quotaBytes: deps.quotaBytes, conversationFor: (u, p) => deps.service.conversationFor(u, p) };
}

/**
 * Download, status and delete — shared by the web and the mobile plugin. Every lookup is by id and
 * the request's own user (spec §5.3): a miss, a stranger's row and another conversation's row all
 * answer the same 404.
 */
export function registerAttachmentReadRoutes(app: FastifyInstance, repos: Repositories, store: AttachmentStore): void {
  app.get('/:id', async (request, reply) => {
    const { id } = attachmentIdParam.parse(request.params);
    const row = await repos.chatAttachments.findForUser(id, request.scope.user.id);
    if (!row) throw attachmentNotFound();
    let file: Buffer;
    try {
      file = await store.read(row.user_id, row.id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('O arquivo deste anexo não está mais disponível');
      throw err;
    }
    return reply.headers(downloadHeaders(row)).send(file);
  });

  app.get('/:id/status', async (request) => {
    const { id } = attachmentIdParam.parse(request.params);
    const row = await repos.chatAttachments.findForUser(id, request.scope.user.id);
    if (!row) throw attachmentNotFound();
    return { attachment: toPublicAttachment(row) };
  });

  /** Only while unsent. `create`, the permission uploading needs: whoever can attach can remove the chip. */
  app.delete('/:id', { config: { action: 'create' } }, async (request) => {
    const { id } = attachmentIdParam.parse(request.params);
    const user = request.scope.user;
    const removed = await repos.chatAttachments.deleteUnsent(id, user.id);
    if (!removed) {
      const existing = await repos.chatAttachments.findForUser(id, user.id);
      throw existing ? conflict('Este anexo já foi enviado') : attachmentNotFound();
    }
    await store.remove(user.id, id);
    return { ok: true };
  });
}

/** `/api/chat/attachments` (spec 2026-09-26 §5.3), registered under the `chat` resource. */
export async function chatAttachmentRoutes(app: FastifyInstance, repos: Repositories, deps: ChatAttachmentDeps) {
  registerRawBody(app);
  const uploadDeps = uploadDepsOf(repos, deps);

  app.post('/', { bodyLimit: UPLOAD_BODY_LIMIT, config: { action: 'create' } }, async (request, reply) => {
    const { name, project_id } = uploadQuery.parse(request.query);
    const attachment = await storeUpload(uploadDeps, request.scope.user, { name, projectId: project_id ?? null, body: request.body, log: request.log });
    return reply.code(201).send({ attachment });
  });

  registerAttachmentReadRoutes(app, repos, deps.store);
}
