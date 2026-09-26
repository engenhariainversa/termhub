import { createInflateRaw } from 'node:zlib';

/**
 * A ZIP's own table of contents (the central directory), read without inflating a byte. Two
 * callers: `sniff` looks for `word/document.xml` / `xl/workbook.xml`, and `extract` refuses a file
 * whose entries claim more than 200 MB expanded before any parser touches it (spec 2026-09-26 §5.4).
 * Pure and defensive: anything malformed, truncated or ZIP64 answers null, never a throw.
 *
 * The directory is what the file *says*; `inflatedBytes` is what it *is*. Two kinds of reader sit
 * behind the parsers: JSZip (mammoth) reads the directory and jumps to each listed local header;
 * unzipper (exceljs's streaming WorkbookReader) never reads the directory and walks the local
 * headers from offset 0 until it meets the directory. `inflatedBytes` therefore walks the file the
 * way unzipper does and requires that walk to be exactly the directory — same entries, same order,
 * same offsets, no bytes in between — so that both readers see the archive it measured, and
 * inflates every entry once, counting and discarding, against one budget for the archive.
 */
export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate; every other value is refused. */
  method: number;
  /** General-purpose bit flags: bit 0 = encrypted (refused), bit 3 = sizes in a data descriptor after the data. */
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Where the entry's local header starts. */
  offset: number;
}

interface ZipLayout {
  entries: ZipEntry[];
  /** Where the central directory starts: the local entries occupy [0, directoryOffset). */
  directoryOffset: number;
}

const LOCAL_SIG = [0x50, 0x4b, 0x03, 0x04];
const LOCAL_SIG_U32 = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const DESCRIPTOR_SIG = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
const END_MIN = 22;
const MAX_COMMENT = 0xffff;
const ZIP64 = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_DESCRIPTOR = 0x8;

/**
 * The directory, strictly laid out: the end record's comment runs to the end of the file, the
 * directory runs exactly up to the end record and holds exactly the entries the end record counts.
 * No room is left for bytes no reader accounts for.
 */
function readLayout(bytes: Uint8Array): ZipLayout | null {
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
  const commentLen = view.getUint16(end + 20, true);
  if (count === 0xffff || size === ZIP64 || offset === ZIP64 || offset + size !== end || end + END_MIN + commentLen !== n) return null;
  const entries: ZipEntry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || view.getUint32(p, true) !== CENTRAL_SIG) return null;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    if (compressedSize === ZIP64 || uncompressedSize === ZIP64) return null;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > end || localOffset === ZIP64) return null;
    entries.push({ name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)), method, flags, crc, compressedSize, uncompressedSize, offset: localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== end) return null;
  return { entries, directoryOffset: offset };
}

export const readZipDirectory = (bytes: Uint8Array): ZipEntry[] | null => readLayout(bytes)?.entries ?? null;

export const zipExpandedBytes = (entries: ZipEntry[]): number => entries.reduce((sum, e) => sum + e.uncompressedSize, 0);

export type ZipRefusal = 'over budget' | 'size mismatch' | 'directory mismatch' | 'unsupported method' | 'encrypted' | 'malformed';
export type ZipMeasure = { ok: true; bytes: number } | { ok: false; reason: ZipRefusal };

const STORED = 0;
const DEFLATE = 8;

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

/** One local entry as a sequential reader delimits it, or null where that reader would stop with an error. */
interface LocalEntry {
  name: string;
  method: number;
  flags: number;
  dataStart: number;
  dataEnd: number;
  /** The sizes and crc the reader takes for the entry: the local header's, or the data descriptor's. */
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Where the next record starts. */
  next: number;
}

/**
 * Reads the local header at `at` exactly as unzipper's `Parse` does: with bit 3 set and no compressed
 * size in the header, the data runs up to the first data-descriptor signature after it and the
 * descriptor's 16 bytes follow; otherwise the header's compressed size delimits the data.
 */
function readLocal(bytes: Uint8Array, view: DataView, at: number, limit: number): LocalEntry | null {
  if (at + 30 > limit || view.getUint32(at, true) !== LOCAL_SIG_U32) return null;
  const flags = view.getUint16(at + 6, true);
  const method = view.getUint16(at + 8, true);
  let crc = view.getUint32(at + 14, true);
  let compressedSize = view.getUint32(at + 18, true);
  let uncompressedSize = view.getUint32(at + 22, true);
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const dataStart = at + 30 + nameLen + extraLen;
  if (dataStart > limit) return null;
  const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
  if ((flags & FLAG_DESCRIPTOR) !== 0 && compressedSize === 0) {
    const descriptor = Buffer.from(bytes.buffer, bytes.byteOffset, limit).indexOf(DESCRIPTOR_SIG, dataStart);
    if (descriptor < 0 || descriptor + 16 > limit) return null;
    crc = view.getUint32(descriptor + 4, true);
    compressedSize = view.getUint32(descriptor + 8, true);
    uncompressedSize = view.getUint32(descriptor + 12, true);
    return { name, method, flags, dataStart, dataEnd: descriptor, crc, compressedSize, uncompressedSize, next: descriptor + 16 };
  }
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > limit) return null;
  return { name, method, flags, dataStart, dataEnd, crc, compressedSize, uncompressedSize, next: dataEnd };
}

/**
 * What the entries really inflate to, or why the archive is refused: a total past `budget` (the
 * bomb), an entry whose real size is not the one its directory claims (the lie a bomb needs), a
 * local walk that is not the directory (an entry the directory does not list, an entry out of
 * place, a header disagreeing with its directory record), bytes no record accounts for, an
 * encrypted entry, or a method neither stored nor deflate.
 */
export async function inflatedBytes(bytes: Uint8Array, budget: number): Promise<ZipMeasure> {
  const layout = readLayout(bytes);
  if (!layout) return { ok: false, reason: 'malformed' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { entries, directoryOffset } = layout;
  let total = 0;
  let p = 0;
  let i = 0;
  while (p < directoryOffset) {
    const local = readLocal(bytes, view, p, directoryOffset);
    if (!local) return { ok: false, reason: 'malformed' };
    const listed = entries[i];
    if (!listed || listed.offset !== p || listed.name !== local.name || listed.method !== local.method) return { ok: false, reason: 'directory mismatch' };
    if (local.dataEnd - local.dataStart !== listed.compressedSize) return { ok: false, reason: 'directory mismatch' };
    if (local.crc !== listed.crc || local.compressedSize !== listed.compressedSize || local.uncompressedSize !== listed.uncompressedSize) return { ok: false, reason: 'directory mismatch' };
    if ((local.flags & FLAG_ENCRYPTED) !== 0 || (listed.flags & FLAG_ENCRYPTED) !== 0) return { ok: false, reason: 'encrypted' };
    if (local.method !== STORED && local.method !== DEFLATE) return { ok: false, reason: 'unsupported method' };
    const data = bytes.subarray(local.dataStart, local.dataEnd);
    const remaining = budget - total;
    // Counting stops one byte past whichever is smaller: the claim (a lie is settled there) or the budget.
    const real = local.method === STORED ? data.length : await inflatedLength(data, Math.min(remaining, listed.uncompressedSize));
    if (real === null) return { ok: false, reason: 'malformed' };
    if (real > remaining) return { ok: false, reason: 'over budget' };
    if (real !== listed.uncompressedSize) return { ok: false, reason: 'size mismatch' };
    total += real;
    i++;
    p = local.next;
  }
  if (p !== directoryOffset || i !== entries.length) return { ok: false, reason: 'directory mismatch' };
  return { ok: true, bytes: total };
}
