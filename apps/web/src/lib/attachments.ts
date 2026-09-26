// A copy of the contract's table (`packages/mobile-api/src/attachments.ts`, spec §5.2 and §5.6): the web
// depends on no workspace package, so it keeps its own. The server is the judge; a drift here only
// moves a refusal from the box to the server's 4xx.
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

/** The refusal the box shows before anything is uploaded, or the kind it will upload as. */
export function checkFile(name: string, mime: string, bytes: number): { kind: AttachmentKind } | { refused: string } {
  const ext = extensionOf(name);
  if (ext === '.doc' || ext === '.xls') return { refused: 'Envie como .docx/.xlsx' };
  const kind = kindFromNameAndMime(name, mime);
  if (!kind) return { refused: 'Tipo de arquivo não suportado' };
  if (bytes > ATTACHMENT_LIMITS[kind]) return { refused: `Arquivo acima de ${formatBytes(ATTACHMENT_LIMITS[kind])}` };
  return { kind };
}

const FAILURE_REASON: Record<string, string> = {
  ATTACHMENT_INVALID: 'arquivo inválido',
  TRANSCRIPTION_UNAVAILABLE: 'transcrição indisponível',
  TRANSCRIPTION_FAILED: 'transcrição falhou',
};

/** The line under a chip or a bubble's attachment while the server is still working on it, or after it gave up. */
export function attachmentStatusText(a: ChatAttachment): string | null {
  if (a.status === 'pending') return a.kind === 'audio' || a.kind === 'video' ? 'transcrevendo…' : 'processando…';
  if (a.status === 'failed') return `falhou: ${(a.error_code && FAILURE_REASON[a.error_code]) || 'erro'}`;
  return null;
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
