/**
 * Property lists (TER-1167): an XML plist is text as it is; a binary one (`bplist00`) is turned into the
 * same XML here, by reading its object table. Pure TypeScript, bounded, no I/O and no external tool:
 * nothing in the file is ever run. Every offset is checked against the buffer, a reference back to an
 * object being written is refused (a cycle), and the output stops at a budget, because an object table
 * may point at the same object many times (a 1 MB file could otherwise expand to gigabytes).
 */

import { PLIST_EXTENSION } from '@termhub/mobile-api';

export const PLIST_MIME = 'application/x-plist';
const MAGIC = 'bplist00';
const TRAILER = 32;
const MAX_DEPTH = 256;
/** Objects written before the conversion stops (shared references count each time). */
const MAX_VISITS = 1_000_000;
/** Seconds between 1970-01-01 and 2001-01-01, the epoch of a plist date. */
const APPLE_EPOCH_S = 978_307_200;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n';
/** An XML plist: optional BOM, XML declaration, comments and doctype, then the `<plist>` root. */
const XML_PLIST = /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+plist[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<plist[\s>]/;

export class PlistError extends Error {}

export const hasPlistExtension = (name: string): boolean => name.toLowerCase().endsWith(PLIST_EXTENSION);
export const isBinaryPlist = (b: Uint8Array): boolean => b.length >= MAGIC.length && String.fromCharCode(...b.subarray(0, MAGIC.length)) === MAGIC;
/** Whether decoded text is an XML property list (by its root, not its name). */
export const isXmlPlist = (text: string): boolean => XML_PLIST.test(text.slice(0, 64 * 1024));

class Budget extends Error {}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The binary plist as XML text, at most `maxChars` long (then `truncated`). Throws `PlistError` on
 * anything malformed: a bad header or trailer, an offset out of the buffer, a cycle, a non-string key.
 */
export function binaryPlistToXml(bytes: Uint8Array, maxChars: number): { text: string; truncated: boolean } {
  if (!isBinaryPlist(bytes) || bytes.length < MAGIC.length + TRAILER + 1) throw new PlistError('not a binary plist');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const t = bytes.length - TRAILER;
  const offsetSize = bytes[t + 6];
  const refSize = bytes[t + 7];
  const big = (at: number): number => {
    const v = view.getBigUint64(at);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PlistError('trailer value too large');
    return Number(v);
  };
  const count = big(t + 8);
  const top = big(t + 16);
  const tableAt = big(t + 24);
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize)) throw new PlistError('bad trailer sizes');
  if (count === 0 || count > t || top >= count) throw new PlistError('bad object count');
  if (tableAt < MAGIC.length || tableAt + count * offsetSize > t) throw new PlistError('offset table out of range');

  const uint = (at: number, size: number): number => {
    if (at < 0 || at + size > t) throw new PlistError('read out of range');
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + bytes[at + i];
    if (!Number.isSafeInteger(v)) throw new PlistError('value too large');
    return v;
  };
  const offsetOf = (ref: number): number => {
    if (ref >= count) throw new PlistError('reference out of range');
    const at = uint(tableAt + ref * offsetSize, offsetSize);
    if (at < MAGIC.length || at >= tableAt) throw new PlistError('object out of range');
    return at;
  };

  let out = XML_HEAD;
  let visits = 0;
  const emit = (s: string) => {
    out += s;
    if (out.length > maxChars) throw new Budget();
  };
  /** The length in a marker's low nibble, or in the int object that follows it (0xF). Returns [length, first byte after]. */
  const lengthAt = (at: number, info: number): [number, number] => {
    if (info !== 0xf) return [info, at + 1];
    const marker = uint(at + 1, 1);
    if (marker >> 4 !== 0x1 || (marker & 0xf) > 3) throw new PlistError('bad length');
    const size = 1 << (marker & 0xf);
    return [uint(at + 2, size), at + 2 + size];
  };
  const stack = new Set<number>();

  const write = (ref: number, depth: number, indent: string): void => {
    if (++visits > MAX_VISITS) throw new Budget();
    if (depth > MAX_DEPTH) throw new PlistError('too deep');
    if (stack.has(ref)) throw new PlistError('cycle');
    const at = offsetOf(ref);
    const marker = uint(at, 1);
    const type = marker >> 4;
    const info = marker & 0xf;
    switch (type) {
      case 0x0:
        if (info === 0x8) return emit(`${indent}<false/>\n`);
        if (info === 0x9) return emit(`${indent}<true/>\n`);
        throw new PlistError('unsupported singleton');
      case 0x1: {
        if (info > 4) throw new PlistError('bad integer');
        const size = 1 << info;
        if (at + 1 + size > t) throw new PlistError('read out of range');
        // 8 and 16 bytes are signed (a 16-byte one keeps its low 8 bytes); shorter ones are unsigned.
        const v = size >= 8 ? view.getBigInt64(at + 1 + size - 8) : BigInt(uint(at + 1, size));
        return emit(`${indent}<integer>${v.toString()}</integer>\n`);
      }
      case 0x2: {
        if (info !== 2 && info !== 3) throw new PlistError('bad real');
        if (at + 1 + (1 << info) > t) throw new PlistError('read out of range');
        const v = info === 2 ? view.getFloat32(at + 1) : view.getFloat64(at + 1);
        return emit(`${indent}<real>${Number.isFinite(v) ? String(v) : 'nan'}</real>\n`);
      }
      case 0x3: {
        if (info !== 3 || at + 9 > t) throw new PlistError('bad date');
        const ms = (view.getFloat64(at + 1) + APPLE_EPOCH_S) * 1000;
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) throw new PlistError('bad date');
        return emit(`${indent}<date>${d.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>\n`);
      }
      case 0x4: {
        const [len, from] = lengthAt(at, info);
        if (from + len > t) throw new PlistError('read out of range');
        return emit(`${indent}<data>${Buffer.from(bytes.buffer, bytes.byteOffset + from, len).toString('base64')}</data>\n`);
      }
      case 0x5:
      case 0x6:
      case 0x7:
        return emit(`${indent}<string>${escapeXml(stringAt(at, type, info))}</string>\n`);
      case 0x8: {
        const v = uint(at + 1, info + 1);
        return emit(`${indent}<dict>\n${indent}\t<key>CF$UID</key>\n${indent}\t<integer>${v}</integer>\n${indent}</dict>\n`);
      }
      case 0xa:
      case 0xc: {
        const [n, from] = lengthAt(at, info);
        if (from + n * refSize > t) throw new PlistError('read out of range');
        if (n === 0) return emit(`${indent}<array/>\n`);
        emit(`${indent}<array>\n`);
        stack.add(ref);
        for (let i = 0; i < n; i++) write(uint(from + i * refSize, refSize), depth + 1, `${indent}\t`);
        stack.delete(ref);
        return emit(`${indent}</array>\n`);
      }
      case 0xd: {
        const [n, from] = lengthAt(at, info);
        if (from + 2 * n * refSize > t) throw new PlistError('read out of range');
        if (n === 0) return emit(`${indent}<dict/>\n`);
        emit(`${indent}<dict>\n`);
        stack.add(ref);
        for (let i = 0; i < n; i++) {
          const keyAt = offsetOf(uint(from + i * refSize, refSize));
          const keyMarker = uint(keyAt, 1);
          const keyType = keyMarker >> 4;
          if (keyType !== 0x5 && keyType !== 0x6 && keyType !== 0x7) throw new PlistError('dict key is not a string');
          emit(`${indent}\t<key>${escapeXml(stringAt(keyAt, keyType, keyMarker & 0xf))}</key>\n`);
          write(uint(from + (n + i) * refSize, refSize), depth + 1, `${indent}\t`);
        }
        stack.delete(ref);
        return emit(`${indent}</dict>\n`);
      }
      default:
        throw new PlistError('unknown object type');
    }
  };

  const stringAt = (at: number, type: number, info: number): string => {
    const [len, from] = lengthAt(at, info);
    const size = type === 0x6 ? len * 2 : len;
    if (from + size > t) throw new PlistError('read out of range');
    const raw = bytes.subarray(from, from + size);
    try {
      if (type === 0x5) return Buffer.from(raw).toString('latin1');
      if (type === 0x7) return new TextDecoder('utf-8', { fatal: true }).decode(raw);
      // UTF-16 big-endian: swap to the little-endian decoder Node ships.
      const le = Buffer.from(raw);
      le.swap16();
      return le.toString('utf16le');
    } catch {
      throw new PlistError('bad string');
    }
  };

  try {
    write(top, 0, '');
    emit('</plist>\n');
    return { text: out, truncated: false };
  } catch (err) {
    if (err instanceof Budget) return { text: out.slice(0, maxChars), truncated: true };
    if (err instanceof RangeError) throw new PlistError('read out of range');
    throw err;
  }
}
