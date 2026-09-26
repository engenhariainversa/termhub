import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText as pdfExtractText } from 'unpdf';
import type { AttachmentKind } from '@termhub/mobile-api';
import { readZipDirectory, zipExpandedBytes } from './zip.js';

/**
 * What the concierge will be able to read of a file (spec 2026-09-26 §5.4). Every parser treats
 * its input as hostile: a ZIP is measured before it is opened, a throw or a hang is an invalid
 * attachment, and the output is capped. Nothing here logs: the caller logs metadata.
 */
export const TEXT_CAP = 200_000;
export const EXTRACT_TIMEOUT_MS = 60_000;
/** Whisper's own budget (`terminal/transcription.ts`): a long clip on the CPU model takes minutes. */
export const WHISPER_TIMEOUT_MS = 10 * 60 * 1000;
export const ZIP_EXPANDED_MAX_BYTES = 200 * 1024 * 1024;
export const XLSX_MAX_ROWS = 500;
export const XLSX_MAX_COLS = 50;

export interface Extracted {
  text: string | null;
  meta: Record<string, unknown>;
}
export type ExtractErrorCode = 'ATTACHMENT_INVALID' | 'TRANSCRIPTION_UNAVAILABLE' | 'TRANSCRIPTION_FAILED';
export class ExtractError extends Error {
  constructor(
    public code: ExtractErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'ExtractError';
  }
}
export interface ExtractDeps {
  whisperUrl: string | null;
  language: string | null;
  fetch?: typeof fetch;
  /** Tests only; production uses the two constants above. */
  timeoutMs?: number;
}

/** mammoth's typings stopped declaring convertToMarkdown; the runtime (1.12.x) still has it. */
const convertToMarkdown = (mammoth as unknown as { convertToMarkdown: typeof mammoth.convertToHtml }).convertToMarkdown;
/** Images inside a document are dropped: an empty `src`, and the leftover `![]()` is stripped. */
const NO_IMAGES = mammoth.images.imgElement(async () => ({ src: '' }));
/** exceljs declares its own `Buffer extends ArrayBuffer`; a Node Buffer is what it reads at runtime. */
type XlsxInput = Parameters<ExcelJS.Workbook['xlsx']['load']>[0];

const capText = (text: string): { text: string; truncated: boolean } => (text.length > TEXT_CAP ? { text: text.slice(0, TEXT_CAP), truncated: true } : { text, truncated: false });

export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExtractError('ATTACHMENT_INVALID', 'extraction timed out')), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
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

function guardZip(file: Buffer): void {
  const entries = readZipDirectory(file);
  if (!entries) throw new ExtractError('ATTACHMENT_INVALID', 'not a zip');
  if (zipExpandedBytes(entries) > ZIP_EXPANDED_MAX_BYTES) throw new ExtractError('ATTACHMENT_INVALID', 'zip too large when expanded');
}

async function fromPdf(file: Buffer): Promise<Extracted> {
  const r = await pdfExtractText(new Uint8Array(file), { mergePages: false });
  const joined = r.text.map((page, i) => (i === 0 ? page.trim() : `--- página ${i + 1} ---\n\n${page.trim()}`)).join('\n\n');
  const c = capText(joined);
  return { text: c.text, meta: { pages: r.totalPages, truncated: c.truncated } };
}

async function fromDocx(file: Buffer): Promise<Extracted> {
  guardZip(file);
  const r = await convertToMarkdown({ buffer: file }, { convertImage: NO_IMAGES, externalFileAccess: false });
  const c = capText(r.value.replace(/!\[[^\]]*\]\(\)/g, '').trim());
  return { text: c.text, meta: { truncated: c.truncated } };
}

/** A cell as text: a formula gives its cached result, never the formula; rich text and links give their text. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const o = value as { result?: unknown; richText?: { text: string }[]; text?: unknown; error?: unknown };
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('');
    if ('text' in o) return typeof o.text === 'string' ? o.text : cellText(o.text as ExcelJS.CellValue);
    if ('error' in o) return String(o.error);
    return '';
  }
  return String(value);
}
const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

async function fromXlsx(file: Buffer): Promise<Extracted> {
  guardZip(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file as unknown as XlsxInput);
  const sheets: { name: string; rows: number; cols: number }[] = [];
  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const rows = Math.min(ws.rowCount, XLSX_MAX_ROWS);
    const cols = Math.min(ws.columnCount, XLSX_MAX_COLS);
    sheets.push({ name: ws.name, rows, cols });
    const lines = [`## ${ws.name}`];
    for (let r = 1; r <= rows; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= cols; c++) cells.push(escapeCell(cellText(row.getCell(c).value)));
      lines.push(`| ${cells.join(' | ')} |`);
      if (r === 1) lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
    }
    parts.push(lines.join('\n'));
  });
  const c = capText(parts.join('\n\n'));
  return { text: c.text, meta: { sheets, truncated: c.truncated } };
}

async function transcribe(file: Buffer, mime: string, deps: ExtractDeps): Promise<Extracted> {
  if (!deps.whisperUrl) throw new ExtractError('TRANSCRIPTION_UNAVAILABLE', 'whisper is not configured');
  const doFetch = deps.fetch ?? fetch;
  const url = `${deps.whisperUrl}/transcribe${deps.language ? `?language=${encodeURIComponent(deps.language)}` : ''}`;
  let res: Response;
  try {
    res = await doFetch(url, { method: 'POST', headers: { 'content-type': mime }, body: new Uint8Array(file), signal: AbortSignal.timeout(deps.timeoutMs ?? WHISPER_TIMEOUT_MS) });
  } catch {
    throw new ExtractError('TRANSCRIPTION_UNAVAILABLE', 'whisper unreachable or too slow');
  }
  if (res.status === 422) throw new ExtractError('TRANSCRIPTION_FAILED', 'audio could not be decoded');
  if (!res.ok) throw new ExtractError('TRANSCRIPTION_UNAVAILABLE', `whisper answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { text?: unknown; duration?: unknown; language?: unknown } | null;
  if (!body || typeof body.text !== 'string') throw new ExtractError('TRANSCRIPTION_FAILED', 'invalid whisper answer');
  const c = capText(body.text.trim());
  return { text: c.text, meta: { duration_s: typeof body.duration === 'number' ? body.duration : null, language: typeof body.language === 'string' ? body.language : null, truncated: c.truncated } };
}

/** A parser that throws, hangs or chokes is an invalid attachment: never a crash, never a stuck queue. */
async function parsed(work: () => Promise<Extracted>, timeoutMs: number): Promise<Extracted> {
  try {
    return await withTimeout(work(), timeoutMs);
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError('ATTACHMENT_INVALID', err instanceof Error ? err.name : 'parse failed');
  }
}

export async function extract(kind: AttachmentKind, file: Buffer, mime: string, deps: ExtractDeps): Promise<Extracted> {
  const timeoutMs = deps.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  switch (kind) {
    case 'image': {
      const dims = imageDimensions(file, mime);
      return { text: null, meta: dims ? { width: dims.width, height: dims.height } : {} };
    }
    case 'text':
      return parsed(async () => {
        const c = capText(new TextDecoder('utf-8', { fatal: true }).decode(file));
        return { text: c.text, meta: { truncated: c.truncated } };
      }, timeoutMs);
    case 'pdf':
      return parsed(() => fromPdf(file), timeoutMs);
    case 'docx':
      return parsed(() => fromDocx(file), timeoutMs);
    case 'xlsx':
      return parsed(() => fromXlsx(file), timeoutMs);
    case 'audio':
    case 'video':
      return transcribe(file, mime, deps);
  }
}
