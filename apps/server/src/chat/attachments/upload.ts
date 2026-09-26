import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { ATTACHMENT_LIMITS, type AttachmentKind, type ChatAttachment } from '@termhub/mobile-api';
import { toPublicAttachment, type ChatAttachmentsRepo } from '../../db/repositories/chat-attachments.js';
import type { ChatConversation } from '../../db/repositories/chat.js';
import type { User } from '../../db/repositories/types.js';
import { HttpError, badRequest } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import type { ExtractionQueue } from './queue.js';
import { sniff } from './sniff.js';
import type { AttachmentStore } from './store.js';

/** The largest accepted kind (audio/video, 64 MB): the per-route body limit for both upload routes. */
export const UPLOAD_BODY_LIMIT = 64 * 1024 * 1024;

export interface UploadDeps {
  repo: Pick<ChatAttachmentsRepo, 'create' | 'usageBytes'>;
  store: Pick<AttachmentStore, 'write' | 'remove'>;
  queue: Pick<ExtractionQueue, 'enqueue'>;
  quotaBytes: number;
  /** `ChatService.conversationFor`: the project's conversation or the user's general one (404 for a project not theirs). */
  conversationFor(user: User, projectId: string | null): Promise<ChatConversation>;
}

export interface UploadInput {
  name: string;
  projectId: string | null;
  body: unknown;
  log: Pick<FastifyBaseLogger, 'info'>;
}

const KIND_LABEL: Record<AttachmentKind, string> = { image: 'imagem', pdf: 'PDF', docx: 'documento Word', xlsx: 'planilha Excel', audio: 'áudio', video: 'vídeo', text: 'texto' };
/** "10 MB", "2 GB": whole units, GB from 1024 MB up. */
const mb = (n: number): string => {
  const inMb = n / (1024 * 1024);
  return inMb >= 1024 ? `${Math.round(inMb / 1024)} GB` : `${Math.round(inMb)} MB`;
};

/** The original name, for display only: control characters and path separators become "_". Never part of a path. */
export function sanitiseFileName(name: string): string {
  const cleaned = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'arquivo';
}

/**
 * The upload, in the spec's order of checks (§5.3), stopping at the first failure: kind by magic
 * bytes, per-kind limit, quota, the file (temp + rename), the row, the queue. A row that cannot be
 * inserted takes its file with it. Logs metadata only.
 */
export async function storeUpload(deps: UploadDeps, user: User, input: UploadInput): Promise<ChatAttachment> {
  if (!Buffer.isBuffer(input.body)) throw badRequest('Envie o arquivo como corpo binário');
  const body = input.body;
  if (body.length === 0) throw badRequest('Arquivo vazio');
  const name = sanitiseFileName(input.name);
  const conversation = await deps.conversationFor(user, input.projectId);

  const sniffed = sniff(body, name);
  if (sniffed === null) throw new HttpError(415, 'Tipo de arquivo não suportado', 'ATTACHMENT_TYPE');
  if ('refused' in sniffed) throw new HttpError(415, 'Envie como .docx/.xlsx', 'ATTACHMENT_TYPE');
  const limit = ATTACHMENT_LIMITS[sniffed.kind];
  if (body.length > limit) throw new HttpError(413, `Arquivo maior que o limite de ${mb(limit)} para ${KIND_LABEL[sniffed.kind]}`, 'ATTACHMENT_TOO_LARGE');
  const used = await deps.repo.usageBytes(user.id);
  if (used + body.length > deps.quotaBytes) throw new HttpError(413, `Espaço de anexos esgotado (limite de ${mb(deps.quotaBytes)})`, 'ATTACHMENT_QUOTA');

  const id = newId();
  const sha256 = createHash('sha256').update(body).digest('hex');
  await deps.store.write(user.id, id, body);
  let row;
  try {
    row = await deps.repo.create({ id, user_id: user.id, conversation_id: conversation.id, name, mime: sniffed.mime, kind: sniffed.kind, bytes: body.length, sha256, meta: null });
  } catch (err) {
    // No row, no file: a file nobody can reach must not sit on the volume until the sweep finds it.
    await deps.store.remove(user.id, id).catch(() => undefined);
    throw err;
  }
  deps.queue.enqueue(id);
  input.log.info({ attachmentId: id, conversationId: conversation.id, kind: sniffed.kind, bytes: body.length }, 'chat attachment stored');
  return toPublicAttachment(row);
}

/**
 * Download headers (spec §3): images preview inline (they are the only kinds ever served inline),
 * everything else downloads; nothing is sniffed by the browser and nothing in it can run.
 */
export function downloadHeaders(row: { name: string; mime: string; kind: AttachmentKind }): Record<string, string> {
  const ascii = row.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const disposition = row.kind === 'image' ? 'inline' : 'attachment';
  return {
    'content-type': row.mime,
    'content-disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    'cache-control': 'private, max-age=3600',
  };
}
