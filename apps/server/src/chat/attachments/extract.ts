import type { AttachmentKind } from '@termhub/mobile-api';
import { whisperHeaders } from '../../lib/whisper.js';
import { ExtractError } from './errors.js';
import { type Extracted, ZIP_EXPANDED_MAX_BYTES, capText } from './parsers.js';
import { EXTRACT_WORKER_HEAP_MB, defaultWorkerUrl, runInWorker } from './worker-runner.js';

export { ExtractError, type ExtractErrorCode, type TranscriptionReason } from './errors.js';
export { type Extracted, TEXT_CAP, XLSX_MAX_COLS, XLSX_MAX_ROWS, ZIP_EXPANDED_MAX_BYTES } from './parsers.js';

/** A document parse's budget, counted from the worker's spawn; the worker is terminated when it runs out. */
export const EXTRACT_TIMEOUT_MS = 60_000;
/** Whisper's own budget (`terminal/transcription.ts`): a long clip on the CPU model takes minutes. */
export const WHISPER_TIMEOUT_MS = 10 * 60 * 1000;

export interface ExtractDeps {
  whisperUrl: string | null;
  language: string | null;
  /** Bearer secret of the whisper service (`WHISPER_SECRET`). */
  whisperSecret?: string | null;
  fetch?: typeof fetch;
  /** Tests only; production uses the two constants above. */
  timeoutMs?: number;
  /** Tests only; production uses `ZIP_EXPANDED_MAX_BYTES`. */
  zipExpandedMaxBytes?: number;
  /** Tests only; production uses `defaultWorkerUrl()`. */
  workerUrl?: URL;
  /** Tests only; production uses `EXTRACT_WORKER_HEAP_MB`. */
  heapMb?: number;
}

/** Width and height from the header alone; null when the header is not one we read. */
export function imageDimensions(b: Uint8Array, mime: string): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (at: number) => (b.length >= at + 4 ? String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]) : '');
  if (mime === 'image/png') return b.length >= 24 && tag(12) === 'IHDR' ? { width: v.getUint32(16), height: v.getUint32(20) } : null;
  if (mime === 'image/gif') return b.length >= 10 ? { width: v.getUint16(6, true), height: v.getUint16(8, true) } : null;
  if (mime === 'image/webp') {
    if (b.length < 30) return null;
    const chunk = tag(12);
    if (chunk === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
    return null;
  }
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
      i += 2 + v.getUint16(i + 2);
    }
    return null;
  }
  return null;
}

async function transcribe(file: Buffer, mime: string, deps: ExtractDeps): Promise<Extracted> {
  if (!deps.whisperUrl) throw new ExtractError('TRANSCRIPTION_UNAVAILABLE', 'whisper is not configured', { reason: 'not_configured' });
  const doFetch = deps.fetch ?? fetch;
  const url = `${deps.whisperUrl}/transcribe${deps.language ? `?language=${encodeURIComponent(deps.language)}` : ''}`;
  let res: Response;
  try {
    res = await doFetch(url, { method: 'POST', headers: whisperHeaders(mime, deps.whisperSecret), body: new Uint8Array(file), signal: AbortSignal.timeout(deps.timeoutMs ?? WHISPER_TIMEOUT_MS) });
  } catch {
    // Out of reach is the moment's too: a deploy recreating the whisper container (TER-1035).
    throw new ExtractError('TRANSCRIPTION_UNAVAILABLE', 'whisper unreachable or too slow', { retryable: true, reason: 'unreachable' });
  }
  if (res.status === 422) throw new ExtractError('TRANSCRIPTION_FAILED', 'audio could not be decoded');
  // 503 is whisper still loading its model (`terminal/transcription.ts` says the same): not this file's fault.
  if (res.status === 503) throw new ExtractError('TRANSCRIPTION_UNAVAILABLE', 'whisper is loading', { retryable: true, reason: 'unreachable' });
  // A secret the service does not share (WHISPER_SECRET differs, or is empty on its side): retrying will not help.
  if (res.status === 401 || res.status === 403) throw new ExtractError('TRANSCRIPTION_UNAVAILABLE', `whisper refused the secret (${res.status})`, { reason: 'refused' });
  if (!res.ok) throw new ExtractError('TRANSCRIPTION_UNAVAILABLE', `whisper answered ${res.status}`, { reason: 'error' });
  const body = (await res.json().catch(() => null)) as { text?: unknown; duration?: unknown; language?: unknown } | null;
  if (!body || typeof body.text !== 'string') throw new ExtractError('TRANSCRIPTION_FAILED', 'invalid whisper answer');
  const c = capText(body.text.trim());
  return { text: c.text, meta: { duration_s: typeof body.duration === 'number' ? body.duration : null, language: typeof body.language === 'string' ? body.language : null, truncated: c.truncated } };
}

/** The UTF-8 decode stays on this thread: linear and bounded by the upload size. A bad byte is an invalid attachment. */
function decodeText(file: Buffer): Extracted {
  try {
    const c = capText(new TextDecoder('utf-8', { fatal: true }).decode(file));
    return { text: c.text, meta: { truncated: c.truncated } };
  } catch {
    throw new ExtractError('ATTACHMENT_INVALID', 'not utf-8');
  }
}

export async function extract(kind: AttachmentKind, file: Buffer, mime: string, deps: ExtractDeps): Promise<Extracted> {
  const timeoutMs = deps.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const zipBudget = deps.zipExpandedMaxBytes ?? ZIP_EXPANDED_MAX_BYTES;
  switch (kind) {
    case 'image': {
      const dims = imageDimensions(file, mime);
      return { text: null, meta: dims ? { width: dims.width, height: dims.height } : {} };
    }
    case 'text':
      return decodeText(file);
    case 'pdf':
    case 'docx':
    case 'xlsx':
      // Off the event loop, in a worker with its own heap limit and a timeout that stops it (TER-196).
      return runInWorker(kind, file, zipBudget, { timeoutMs, heapMb: deps.heapMb ?? EXTRACT_WORKER_HEAP_MB, workerUrl: deps.workerUrl ?? defaultWorkerUrl() });
    case 'audio':
    case 'video':
      return transcribe(file, mime, deps);
  }
}
