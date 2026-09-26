import { describe, expect, it } from 'vitest';
import { buildZip, minimalDocx } from '../../../test/zip.js';
import { readZipDirectory, zipExpandedBytes } from './zip.js';

describe('readZipDirectory', () => {
  it('lists the entries with their sizes without inflating anything', () => {
    const zip = buildZip([['a.txt', 'hello'], ['dir/b.bin', Buffer.alloc(300)]]);
    expect(readZipDirectory(zip)).toEqual([
      { name: 'a.txt', compressedSize: 5, uncompressedSize: 5 },
      { name: 'dir/b.bin', compressedSize: 300, uncompressedSize: 300 },
    ]);
    expect(zipExpandedBytes(readZipDirectory(minimalDocx(['x']))!)).toBeGreaterThan(0);
  });

  it('reads the claimed size, not the stored one: that claim is what the bomb guard judges', () => {
    const bomb = buildZip([['word/document.xml', 'x']], { claimUncompressed: { 'word/document.xml': 300 * 1024 * 1024 } });
    expect(zipExpandedBytes(readZipDirectory(bomb)!)).toBe(300 * 1024 * 1024);
  });

  it('is null for a non-zip, a truncated zip, and a zip whose directory points outside the file', () => {
    expect(readZipDirectory(Buffer.from('%PDF-1.4'))).toBeNull();
    const zip = buildZip([['a.txt', 'hello']]);
    expect(readZipDirectory(zip.subarray(0, zip.length - 10))).toBeNull();
    const bad = Buffer.from(zip);
    bad.writeUInt32LE(0xffffff, bad.length - 22 + 16); // central directory offset past the end
    expect(readZipDirectory(bad)).toBeNull();
    expect(readZipDirectory(Buffer.alloc(0))).toBeNull();
  });

  it('never throws on hostile input: every truncation and byte flip of a valid zip answers entries or null', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const zip = minimalDocx(['fuzz']);
    for (let cut = 0; cut <= zip.length; cut++) expect(() => readZipDirectory(zip.subarray(0, cut))).not.toThrow();
    for (let i = 0; i < 2000; i++) {
      const mutated = Buffer.from(zip);
      for (let k = 0; k < 1 + rnd(4); k++) mutated[rnd(mutated.length)] = rnd(256);
      expect(() => readZipDirectory(mutated)).not.toThrow();
      const random = Buffer.alloc(rnd(64));
      for (let k = 0; k < random.length; k++) random[k] = rnd(256);
      expect(() => readZipDirectory(random)).not.toThrow();
    }
  });
});
