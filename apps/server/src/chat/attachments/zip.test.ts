import { describe, expect, it } from 'vitest';
import { buildZip, minimalDocx } from '../../../test/zip.js';
import { inflatedBytes, readZipDirectory, zipExpandedBytes } from './zip.js';

describe('readZipDirectory', () => {
  it('lists the entries with their sizes, method and local offset without inflating anything', () => {
    const zip = buildZip([['a.txt', 'hello'], ['dir/b.bin', Buffer.alloc(300)]]);
    expect(readZipDirectory(zip)).toEqual([
      { name: 'a.txt', method: 0, compressedSize: 5, uncompressedSize: 5, offset: 0 },
      { name: 'dir/b.bin', method: 0, compressedSize: 300, uncompressedSize: 300, offset: 30 + 5 + 5 },
    ]);
    const deflated = readZipDirectory(buildZip([['z.bin', Buffer.alloc(100_000)]], { deflate: true }))!;
    expect(deflated[0]).toMatchObject({ name: 'z.bin', method: 8, uncompressedSize: 100_000 });
    expect(deflated[0].compressedSize).toBeLessThan(1000);
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

describe('inflatedBytes', () => {
  const measure = (zip: Buffer, budget: number) => inflatedBytes(zip, readZipDirectory(zip)!, budget);

  it('counts the real bytes of stored and deflated entries, against one budget for the whole archive', async () => {
    const stored = buildZip([['a.txt', 'hello'], ['b.bin', Buffer.alloc(300)]]);
    expect(await measure(stored, 1000)).toEqual({ ok: true, bytes: 305 });
    const deflated = buildZip([['a.txt', 'hello'], ['b.bin', Buffer.alloc(100_000)]], { deflate: true });
    expect(await measure(deflated, 1_000_000)).toEqual({ ok: true, bytes: 100_005 });
    expect(await measure(deflated, 100_004)).toEqual({ ok: false, reason: 'over budget' });
    expect(await measure(buildZip([['a.bin', Buffer.alloc(600)], ['b.bin', Buffer.alloc(600)]], { deflate: true }), 1000)).toEqual({ ok: false, reason: 'over budget' });
  });

  it('never trusts the directory: an entry that inflates to more than it claims is refused, and so is one that inflates to less', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024);
    const lying = buildZip([['x.bin', big]], { deflate: true, claimUncompressed: { 'x.bin': 100 } });
    expect(readZipDirectory(lying)![0].uncompressedSize).toBe(100);
    expect(await measure(lying, 100 * 1024 * 1024)).toEqual({ ok: false, reason: 'size mismatch' });
    const short = buildZip([['x.bin', 'abc']], { deflate: true, claimUncompressed: { 'x.bin': 5000 } });
    expect(await measure(short, 100 * 1024 * 1024)).toEqual({ ok: false, reason: 'size mismatch' });
    const storedLie = buildZip([['x.bin', 'abc']], { claimUncompressed: { 'x.bin': 5000 } });
    expect(await measure(storedLie, 100 * 1024 * 1024)).toEqual({ ok: false, reason: 'size mismatch' });
  });

  it('refuses an unsupported method, a local header outside the file, and corrupt deflate data', async () => {
    const zip = buildZip([['a.txt', 'hello']], { deflate: true });
    const bzip2 = Buffer.from(zip);
    bzip2.writeUInt16LE(12, 8); // local header method
    bzip2.writeUInt16LE(12, bzip2.length - 22 - 46 - 5 + 10); // central directory method
    expect(await measure(bzip2, 1000)).toEqual({ ok: false, reason: 'unsupported method' });
    const entries = readZipDirectory(zip)!;
    expect(await inflatedBytes(zip, [{ ...entries[0], offset: zip.length - 4 }], 1000)).toEqual({ ok: false, reason: 'malformed' });
    const corrupt = Buffer.from(zip);
    for (let i = 30 + 5; i < 30 + 5 + entries[0].compressedSize; i++) corrupt[i] = 0xff;
    expect(await measure(corrupt, 1000)).toEqual({ ok: false, reason: 'malformed' });
  });
});
