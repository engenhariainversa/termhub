import { z } from 'zod';

/**
 * What a chat message can carry (spec 2026-09-26 §5.2). The server is the judge — it recognises a
 * file by its magic bytes, never by its name — and this table only lets a client refuse early with
 * the same limits, so a drift moves a refusal from the client to the server and never the other way.
 */
export const ATTACHMENT_KINDS = ['image', 'pdf', 'docx', 'xlsx', 'audio', 'video', 'text'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

const MB = 1024 * 1024;
/** Max bytes per kind. */
export const ATTACHMENT_LIMITS: Record<AttachmentKind, number> = {
  image: 10 * MB,
  pdf: 20 * MB,
  docx: 20 * MB,
  xlsx: 20 * MB,
  audio: 64 * MB,
  video: 64 * MB,
  text: 1 * MB,
};
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
/** A text file must be valid UTF-8 *and* be named like one: a body of text alone is not enough. */
export const TEXT_EXTENSIONS: readonly string[] = ['.txt', '.md', '.csv', '.json', '.log', '.yaml', '.yml', '.ts', '.js', '.py'];
/** The stored MIME of the kinds with one fixed value; images, audio and video keep the sniffed one. */
export const ATTACHMENT_MIMES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  text: 'text/plain; charset=utf-8',
} as const;

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function hasTextExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A client-side guess from the picker's name and MIME — for the early refusal and the chip's icon only. */
export function kindFromNameAndMime(name: string, mime: string): AttachmentKind | null {
  const m = mime.split(';')[0].trim().toLowerCase();
  const lower = name.toLowerCase();
  if (IMAGE_MIMES.has(m)) return 'image';
  if (m === ATTACHMENT_MIMES.pdf || lower.endsWith('.pdf')) return 'pdf';
  if (m === ATTACHMENT_MIMES.docx || lower.endsWith('.docx')) return 'docx';
  if (m === ATTACHMENT_MIMES.xlsx || lower.endsWith('.xlsx')) return 'xlsx';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (hasTextExtension(name)) return 'text';
  return null;
}

export const attachmentStatus = z.enum(['pending', 'ready', 'failed']);

/** Mirrors `toPublicAttachment` in `apps/server/src/db/repositories/chat-attachments.ts`. */
export const chatAttachment = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  kind: z.enum(ATTACHMENT_KINDS),
  bytes: z.number().int(),
  status: attachmentStatus,
  error_code: z.string().nullable(),
  /** pages, duration_s, sheets, width, height, truncated — whatever the extractor learned */
  meta: z.record(z.unknown()).nullable(),
  created_at: z.string(),
});
export type ChatAttachment = z.infer<typeof chatAttachment>;
