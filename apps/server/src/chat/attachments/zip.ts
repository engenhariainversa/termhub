/**
 * A ZIP's own table of contents (the central directory), read without inflating a byte. Two
 * callers: `sniff` looks for `word/document.xml` / `xl/workbook.xml`, and `extract` refuses a file
 * whose entries claim more than 200 MB expanded before any parser touches it (spec 2026-09-26 §5.4).
 * Pure and defensive: anything malformed, truncated or ZIP64 answers null, never a throw.
 */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
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
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    if (compressedSize === ZIP64 || uncompressedSize === ZIP64) return null;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (p + 46 + nameLen > end) return null;
    entries.push({ name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)), compressedSize, uncompressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export const zipExpandedBytes = (entries: ZipEntry[]): number => entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
