import { createInflateRaw } from 'node:zlib';

/**
 * A ZIP's own table of contents (the central directory), read without inflating a byte. Two
 * callers: `sniff` looks for `word/document.xml` / `xl/workbook.xml`, and `extract` refuses a file
 * whose entries claim more than 200 MB expanded before any parser touches it (spec 2026-09-26 §5.4).
 * Pure and defensive: anything malformed, truncated or ZIP64 answers null, never a throw.
 *
 * The directory is what the file *says*; `inflatedBytes` is what it *is*: every entry is inflated
 * once, counted and thrown away, against one budget for the archive, before mammoth or exceljs
 * (both on JSZip, which inflates an entry whole before it compares sizes) get to see it.
 */
export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate; every other value is refused. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Where the entry's local header starts. */
  offset: number;
}

const LOCAL_SIG = [0x50, 0x4b, 0x03, 0x04];
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const END_MIN = 22;
const MAX_COMMENT = 0xffff;
const ZIP64 = 0xffffffff;

export function readZipDirectory(bytes: Uint8Array): ZipEntry[] | null {
  const n = bytes.length;
  if (n < END_MIN || LOCAL_SIG.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = n - END_MIN; i >= 0 && i >= n - END_MIN - MAX_COMMENT; i--) {
    if (view.getUint32(i, true) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (count === 0xffff || size === ZIP64 || offset === ZIP64 || offset + size > end) return null;
  const entries: ZipEntry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || view.getUint32(p, true) !== CENTRAL_SIG) return null;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    if (compressedSize === ZIP64 || uncompressedSize === ZIP64) return null;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > end || localOffset === ZIP64) return null;
    entries.push({ name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)), method, compressedSize, uncompressedSize, offset: localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export const zipExpandedBytes = (entries: ZipEntry[]): number => entries.reduce((sum, e) => sum + e.uncompressedSize, 0);

export type ZipRefusal = 'over budget' | 'size mismatch' | 'unsupported method' | 'malformed';
export type ZipMeasure = { ok: true; bytes: number } | { ok: false; reason: ZipRefusal };

const STORED = 0;
const DEFLATE = 8;

/** The compressed bytes of one entry, located through its local header; null when the header lies outside the file. */
function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  const at = entry.offset;
  if (at + 30 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!LOCAL_SIG.every((b, i) => bytes[at + i] === b)) return null;
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  if (start + entry.compressedSize > bytes.length) return null;
  return bytes.subarray(start, start + entry.compressedSize);
}

/**
 * Inflates one deflated entry chunk by chunk, counting and discarding, and gives up the moment the
 * count passes `limit` — so a bomb costs one chunk of memory and `limit` bytes of CPU, never its
 * full size. Null when the stream is not valid deflate data.
 */
async function inflatedLength(data: Uint8Array, limit: number): Promise<number | null> {
  const inflate = createInflateRaw();
  let bytes = 0;
  try {
    inflate.end(data);
    for await (const chunk of inflate as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > limit) break;
    }
    return bytes;
  } catch {
    return null;
  } finally {
    inflate.destroy();
  }
}

/**
 * What the entries really inflate to, or why the archive is refused: a total past `budget` (the
 * bomb), an entry whose real size is not the one its directory claims (the lie a bomb needs), a
 * method neither stored nor deflate, or a local header the directory points outside the file.
 */
export async function inflatedBytes(bytes: Uint8Array, entries: ZipEntry[], budget: number): Promise<ZipMeasure> {
  let total = 0;
  for (const entry of entries) {
    if (entry.method !== STORED && entry.method !== DEFLATE) return { ok: false, reason: 'unsupported method' };
    const data = entryData(bytes, entry);
    if (!data) return { ok: false, reason: 'malformed' };
    const remaining = budget - total;
    // Counting stops one byte past whichever is smaller: the claim (a lie is settled there) or the budget.
    const real = entry.method === STORED ? data.length : await inflatedLength(data, Math.min(remaining, entry.uncompressedSize));
    if (real === null) return { ok: false, reason: 'malformed' };
    if (real > remaining) return { ok: false, reason: 'over budget' };
    if (real !== entry.uncompressedSize) return { ok: false, reason: 'size mismatch' };
    total += real;
  }
  return { ok: true, bytes: total };
}
