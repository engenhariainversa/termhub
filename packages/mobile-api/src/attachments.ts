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

// --- pt-BR copy both clients show (the web keeps its own copy in `apps/web/src/lib/attachments.ts`) ---

/** `512 B`, `1,2 KB`, `10 MB` — a decimal comma, as the product speaks. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const text = value >= 100 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1).replace('.', ',');
  return `${text} ${units[i]}`;
}

/** Why an extraction gave up, by the server's error code (`ExtractError`). */
export const ATTACHMENT_FAILURE_REASON: Record<string, string> = {
  ATTACHMENT_INVALID: 'arquivo inválido',
  TRANSCRIPTION_UNAVAILABLE: 'transcrição indisponível',
  TRANSCRIPTION_FAILED: 'transcrição falhou',
};

/** The line under a chip or a bubble's attachment while the server works on it, or after it gave up. */
export function attachmentStatusText(a: Pick<ChatAttachment, 'kind' | 'status' | 'error_code'>): string | null {
  if (a.status === 'pending') return a.kind === 'audio' || a.kind === 'video' ? 'transcrevendo…' : 'processando…';
  if (a.status === 'failed') return `falhou: ${(a.error_code && ATTACHMENT_FAILURE_REASON[a.error_code]) || 'erro'}`;
  return null;
}
