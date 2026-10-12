// A copy of the contract's table (`packages/mobile-api/src/attachments.ts`, spec §5.2 and §5.6): the web
// depends on no workspace package, so it keeps its own. The server is the judge; a drift here only
// moves a refusal from the box to the server's 4xx.
import { i18n, tk } from '../i18n';
import { formatNumber } from './format';
import type { ChatAttachment, ChatMessage } from './types';

export type AttachmentKind = ChatAttachment['kind'];

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['image', 'pdf', 'docx', 'xlsx', 'audio', 'video', 'text'];

/** Bytes, per kind (Global Constraints). */
export const ATTACHMENT_LIMITS: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  docx: 20 * 1024 * 1024,
  xlsx: 20 * 1024 * 1024,
  audio: 64 * 1024 * 1024,
  video: 64 * 1024 * 1024,
  text: 1024 * 1024,
};

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export const TEXT_EXTENSIONS: readonly string[] = ['.txt', '.md', '.csv', '.json', '.log', '.yaml', '.yml', '.ts', '.js', '.py'];

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.opus', '.aac'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'];
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** What the file picker offers by default; anything else can still be dropped and is refused by `checkFile`. */
export const ACCEPT_ATTRIBUTE = ['image/*', 'video/*', 'audio/*', '.pdf', '.docx', '.xlsx', ...TEXT_EXTENSIONS].join(',');

function extensionOf(name: string): string {
  const m = /\.[a-z0-9]+$/i.exec(name);
  return m ? m[0].toLowerCase() : '';
}

/** A client-side guess only — the server sniffs magic bytes and has the last word. */
export function kindFromNameAndMime(name: string, mime: string): AttachmentKind | null {
  const ext = extensionOf(name);
  const m = mime.toLowerCase();
  if (IMAGE_MIMES.includes(m) || IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (m === DOCX_MIME || ext === '.docx') return 'docx';
  if (m === XLSX_MIME || ext === '.xlsx') return 'xlsx';
  if (m.startsWith('audio/') || AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (m.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (TEXT_EXTENSIONS.includes(ext)) return 'text';
  return null;
}

/** `512 B`, `1,2 KB` / `1.2 KB`, `10 MB` — the decimal separator of the language on screen. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const text = value >= 100 || Number.isInteger(value) ? String(Math.round(value)) : formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${text} ${units[i]}`;
}

/** The refusal the box shows before anything is uploaded, or the kind it will upload as. */
export function checkFile(name: string, mime: string, bytes: number): { kind: AttachmentKind } | { refused: string } {
  const ext = extensionOf(name);
  if (ext === '.doc' || ext === '.xls') return { refused: i18n.t('Envie como .docx/.xlsx') };
  const kind = kindFromNameAndMime(name, mime);
  if (!kind) return { refused: i18n.t('Tipo de arquivo não suportado') };
  if (bytes > ATTACHMENT_LIMITS[kind]) return { refused: i18n.t('Arquivo acima de {{size}}', { size: formatBytes(ATTACHMENT_LIMITS[kind]) }) };
  return { kind };
}

const FAILURE_REASON: Record<string, string> = {
  ATTACHMENT_INVALID: tk('arquivo inválido'),
  TRANSCRIPTION_UNAVAILABLE: tk('transcrição indisponível'),
  TRANSCRIPTION_FAILED: tk('transcrição falhou'),
};

/** TRANSCRIPTION_UNAVAILABLE by the server's `meta.reason` (TER-1035): what went wrong with whisper. */
const TRANSCRIPTION_REASON: Record<string, string> = {
  not_configured: tk('transcrição desligada neste servidor'),
  refused: tk('o serviço de transcrição recusou o acesso'),
  unreachable: tk('serviço de transcrição fora do ar'),
  error: tk('o serviço de transcrição deu erro'),
};

function failureReason(a: ChatAttachment): string {
  const reason = a.error_code === 'TRANSCRIPTION_UNAVAILABLE' && typeof a.meta?.reason === 'string' ? TRANSCRIPTION_REASON[a.meta.reason] : undefined;
  return reason ?? ((a.error_code && FAILURE_REASON[a.error_code]) || tk('erro'));
}

/** The line under a chip or a bubble's attachment while the server is still working on it, or after it gave up. */
export function attachmentStatusText(a: ChatAttachment): string | null {
  if (a.status === 'pending') return a.kind === 'audio' || a.kind === 'video' ? i18n.t('transcrevendo…') : i18n.t('processando…');
  if (a.status === 'failed') return i18n.t('falhou: {{reason}}', { reason: i18n.t(failureReason(a)) });
  return null;
}

/** A transcription whisper could not do can be asked again (`POST …/retry`); a file it could not decode cannot. */
export function canRetryAttachment(a: Pick<ChatAttachment, 'kind' | 'status' | 'error_code'>): boolean {
  return a.status === 'failed' && a.error_code === 'TRANSCRIPTION_UNAVAILABLE' && (a.kind === 'audio' || a.kind === 'video');
}

const isDimension = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * The size a thumbnail takes before its file loads (TER-197): the image's own proportion, scaled down
 * to fit `box`, each side at least `min` (the rest is cropped by object-cover). Null when the server has
 * not (or could not) read the dimensions; the caller then keeps its unsized layout. The app keeps a copy.
 */
export function thumbSize(meta: Record<string, unknown> | null, box: number, min: number): { width: number; height: number } | null {
  const width = meta?.width;
  const height = meta?.height;
  if (!isDimension(width) || !isDimension(height)) return null;
  const scale = Math.min(1, box / width, box / height);
  const fit = (v: number) => Math.min(box, Math.max(min, Math.round(v * scale)));
  return { width: fit(width), height: fit(height) };
}

/**
 * The messages with `attachment` replaced inside whichever message carries it, by id. Returns the same
 * array — and keeps every message object — when nothing changed, so memoised rows stay put.
 */
export function patchMessageAttachment(messages: readonly ChatMessage[], attachment: ChatAttachment): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    const list = m.attachments;
    if (!list) return m;
    const i = list.findIndex((a) => a.id === attachment.id);
    if (i < 0) return m;
    const current = list[i];
    if (current.status === attachment.status && current.error_code === attachment.error_code && JSON.stringify(current.meta) === JSON.stringify(attachment.meta)) return m;
    changed = true;
    return { ...m, attachments: list.map((a, j) => (j === i ? attachment : a)) };
  });
  return changed ? next : (messages as ChatMessage[]);
}
