import { ATTACHMENT_MIMES, hasTextExtension, type AttachmentKind } from '@termhub/mobile-api';
import { readZipDirectory } from './zip.js';

/** What the bytes are (spec 2026-09-26 §5.2), or why they are refused. Null = not accepted at all. */
export type Sniffed = { kind: AttachmentKind; mime: string } | { refused: 'legacy_office' } | null;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
/** ISO base-media brands that mean "audio only" (an .m4a); every other `ftyp` is a video container. */
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);
/** A Matroska/WebM track with one of these codec ids is video; without, the file is audio (opus/vorbis). */
const WEBM_VIDEO_CODECS = ['V_VP8', 'V_VP9', 'V_AV1', 'V_MPEG'];
/** How far into a WebM the track entries are looked for. */
const WEBM_SCAN = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const startsWith = (b: Uint8Array, sig: number[], at = 0): boolean => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, len: number): string => (b.length >= at + len ? String.fromCharCode(...b.subarray(at, at + len)) : '');

/**
 * The kind and MIME of an upload, from its bytes — never from its name, except for text, where the
 * name is the second half of the rule. Pure: no I/O, nothing logged.
 */
export function sniff(bytes: Uint8Array, name: string): Sniffed {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, PNG)) return { kind: 'image', mime: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  const head6 = ascii(bytes, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { kind: 'image', mime: 'image/gif' };
  const riff = ascii(bytes, 0, 4) === 'RIFF' ? ascii(bytes, 8, 4) : '';
  if (riff === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (ascii(bytes, 0, 5) === '%PDF-') return { kind: 'pdf', mime: ATTACHMENT_MIMES.pdf };
  if (startsWith(bytes, OLE)) return { refused: 'legacy_office' };
  if (startsWith(bytes, ZIP)) {
    const entries = readZipDirectory(bytes);
    if (!entries) return null;
    const names = new Set(entries.map((e) => e.name));
    if (names.has('word/document.xml')) return { kind: 'docx', mime: ATTACHMENT_MIMES.docx };
    if (names.has('xl/workbook.xml')) return { kind: 'xlsx', mime: ATTACHMENT_MIMES.xlsx };
    return null;
  }
  if (ascii(bytes, 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg' };
  if (riff === 'WAVE') return { kind: 'audio', mime: 'audio/wav' };
  // ID3 tag, or an MPEG audio frame sync (11 set bits) whose layer bits say layer III.
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) === 0x02)) return { kind: 'audio', mime: 'audio/mpeg' };
  if (startsWith(bytes, EBML)) {
    const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, WEBM_SCAN)).toString('latin1');
    return WEBM_VIDEO_CODECS.some((c) => head.includes(c)) ? { kind: 'video', mime: 'video/webm' } : { kind: 'audio', mime: 'audio/webm' };
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (AUDIO_BRANDS.has(brand)) return { kind: 'audio', mime: 'audio/mp4' };
    return { kind: 'video', mime: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4' };
  }
  if (hasTextExtension(name) && !bytes.includes(0)) {
    try {
      utf8.decode(bytes);
      return { kind: 'text', mime: ATTACHMENT_MIMES.text };
    } catch {
      return null;
    }
  }
  return null;
}
