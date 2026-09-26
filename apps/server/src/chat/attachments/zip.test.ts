import { describe, expect, it } from 'vitest';
import { buildZip, minimalDocx, withUnlistedEntry } from '../../../test/zip.js';
import { inflatedBytes, readZipDirectory, zipExpandedBytes } from './zip.js';

describe('readZipDirectory', () => {
  it('lists the entries with their sizes, method and local offset without inflating anything', () => {
    const zip = buildZip([['a.txt', 'hello'], ['dir/b.bin', Buffer.alloc(300)]]);
    expect(readZipDirectory(zip)).toEqual([
      { name: 'a.txt', method: 0, flags: 0, crc: expect.any(Number), compressedSize: 5, uncompressedSize: 5, offset: 0 },
      { name: 'dir/b.bin', method: 0, flags: 0, crc: expect.any(Number), compressedSize: 300, uncompressedSize: 300, offset: 30 + 5 + 5 },
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

  it('is null when the directory does not run up to the end record, or the end record\'s comment not up to the file\'s end', () => {
    const zip = buildZip([['a.txt', 'hello']]);
    expect(readZipDirectory(Buffer.concat([zip, Buffer.from('trailing bytes')]))).toBeNull();
    const short = Buffer.from(zip);
    short.writeUInt32LE(46 + 5 - 1, short.length - 22 + 12); // directory size one byte short of the end record
    expect(readZipDirectory(short)).toBeNull();
    const fewer = Buffer.from(buildZip([['a.txt', 'hello'], ['b.txt', 'x']]));
    fewer.writeUInt16LE(1, fewer.length - 22 + 10); // one entry listed, two directory headers
    expect(readZipDirectory(fewer)).toBeNull();
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
  const measure = (zip: Buffer, budget: number) => inflatedBytes(zip, budget);

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

  it('refuses an unsupported method, a directory offset the walk does not meet, a non-zip, and corrupt deflate data', async () => {
    const zip = buildZip([['a.txt', 'hello']], { deflate: true });
    const bzip2 = Buffer.from(zip);
    bzip2.writeUInt16LE(12, 8); // local header method
    bzip2.writeUInt16LE(12, bzip2.length - 22 - 46 - 5 + 10); // central directory method
    expect(await measure(bzip2, 1000)).toEqual({ ok: false, reason: 'unsupported method' });
    const entries = readZipDirectory(zip)!;
    const moved = Buffer.from(zip);
    moved.writeUInt32LE(zip.length - 4, moved.length - 22 - 46 - 5 + 42); // directory places the local header elsewhere than the walk finds it
    expect(await measure(moved, 1000)).toEqual({ ok: false, reason: 'directory mismatch' });
    expect(await measure(Buffer.from('not a zip at all, really'), 1000)).toEqual({ ok: false, reason: 'malformed' });
    const corrupt = Buffer.from(zip);
    for (let i = 30 + 5; i < 30 + 5 + entries[0].compressedSize; i++) corrupt[i] = 0xff;
    expect(await measure(corrupt, 1000)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('inflatedBytes walks the local headers the way a sequential reader does, and requires them to be the directory', () => {
  const measure = (zip: Buffer, budget: number) => inflatedBytes(zip, budget);

  it('accepts entries written with a data descriptor (bit 3, zero sizes in the local header)', async () => {
    const zip = buildZip([['a.txt', 'hello'], ['b.bin', Buffer.alloc(100_000)]], { deflate: true, dataDescriptor: true });
    expect(readZipDirectory(zip)![0]).toMatchObject({ flags: 8, method: 8 });
    expect(await measure(zip, 1_000_000)).toEqual({ ok: true, bytes: 100_005 });
    expect(await measure(zip, 100_004)).toEqual({ ok: false, reason: 'over budget' });
  });

  it('refuses a local entry the directory does not list, wherever it sits', async () => {
    const first = buildZip([['hidden.bin', Buffer.alloc(50_000)], ['a.txt', 'hello']], { deflate: true, unlisted: ['hidden.bin'] });
    expect(readZipDirectory(first)).toHaveLength(1);
    expect(await measure(first, 1_000_000)).toEqual({ ok: false, reason: 'directory mismatch' });
    const middle = buildZip([['a.txt', 'hello'], ['hidden.bin', Buffer.alloc(50_000)], ['b.txt', 'x']], { deflate: true, unlisted: ['hidden.bin'] });
    expect(await measure(middle, 1_000_000)).toEqual({ ok: false, reason: 'directory mismatch' });
    const last = buildZip([['a.txt', 'hello'], ['hidden.bin', Buffer.alloc(50_000)]], { deflate: true, unlisted: ['hidden.bin'] });
    expect(await measure(last, 1_000_000)).toEqual({ ok: false, reason: 'directory mismatch' });
    expect(await measure(withUnlistedEntry(buildZip([['a.txt', 'hello']], { deflate: true }), 'hidden.bin', Buffer.alloc(50_000)), 1_000_000)).toEqual({ ok: false, reason: 'directory mismatch' });
  });

  it('refuses bytes the directory does not account for: a gap before the directory, or between entries', async () => {
    expect(await measure(buildZip([['a.txt', 'hello']], { gapBeforeDirectory: 7 }), 1000)).toEqual({ ok: false, reason: 'malformed' });
    const zip = buildZip([['a.txt', 'hello'], ['b.txt', 'world']]);
    const spliced = Buffer.concat([zip.subarray(0, 40), Buffer.alloc(3), zip.subarray(40)]);
    const end = spliced.length - 22;
    spliced.writeUInt32LE(spliced.readUInt32LE(end + 16) + 3, end + 16);
    spliced.writeUInt32LE(40 + 3, end - 46 - 5 + 42); // b.txt's listed offset follows the gap
    expect(readZipDirectory(spliced)).toHaveLength(2);
    expect(await measure(spliced, 1000)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a local header that disagrees with its directory entry: name, method, sizes, crc', async () => {
    const zip = buildZip([['a.txt', 'hello']], { deflate: true });
    const cd = zip.length - 22 - 46 - 5;
    const renamed = Buffer.from(zip);
    renamed.write('b', 30, 1); // local name b.txt, directory name a.txt
    expect(await measure(renamed, 1000)).toEqual({ ok: false, reason: 'directory mismatch' });
    const stored = Buffer.from(zip);
    stored.writeUInt16LE(0, 8); // local says stored, directory says deflate
    expect(await measure(stored, 1000)).toEqual({ ok: false, reason: 'directory mismatch' });
    const smaller = Buffer.from(zip);
    smaller.writeUInt32LE(zip.readUInt32LE(cd + 20) - 1, 18); // local compressed size one byte short
    expect(await measure(smaller, 1000)).toEqual({ ok: false, reason: 'directory mismatch' });
    const bigger = Buffer.from(zip);
    bigger.writeUInt32LE(6, 22); // local uncompressed size
    expect(await measure(bigger, 1000)).toEqual({ ok: false, reason: 'directory mismatch' });
    const crc = Buffer.from(zip);
    crc.writeUInt32LE(1, 14);
    expect(await measure(crc, 1000)).toEqual({ ok: false, reason: 'directory mismatch' });
    const encrypted = Buffer.from(zip);
    encrypted.writeUInt16LE(1, 6);
    encrypted.writeUInt16LE(1, cd + 8);
    expect(await measure(encrypted, 1000)).toEqual({ ok: false, reason: 'encrypted' });
  });

  it('never throws on hostile input: truncations and byte flips of a real archive are measured or refused', async () => {
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const zip = minimalDocx(['fuzz', 'more'], { deflate: true, dataDescriptor: true });
    expect(await measure(zip, 1_000_000)).toMatchObject({ ok: true });
    for (let cut = 0; cut <= zip.length; cut += 7) await expect(measure(zip.subarray(0, cut), 1_000_000)).resolves.toBeDefined();
    for (let i = 0; i < 300; i++) {
      const mutated = Buffer.from(zip);
      for (let k = 0; k < 1 + rnd(4); k++) mutated[rnd(mutated.length)] = rnd(256);
      await expect(measure(mutated, 1_000_000)).resolves.toBeDefined();
    }
  });

  it('with a data descriptor, the descriptor must sit where the directory\'s compressed size ends and say what the directory says', async () => {
    const zip = buildZip([['a.txt', 'hello world hello world']], { deflate: true, dataDescriptor: true });
    const entry = readZipDirectory(zip)![0];
    const dataStart = 30 + 5;
    const descriptor = dataStart + entry.compressedSize;
    expect(zip.readUInt32LE(descriptor)).toBe(0x08074b50);
    const lying = Buffer.from(zip);
    lying.writeUInt32LE(entry.uncompressedSize + 1, descriptor + 12);
    expect(await measure(lying, 1000)).toEqual({ ok: false, reason: 'directory mismatch' });
    // A descriptor signature inside the data: the sequential reader would stop there, so the walk must not agree with the directory.
    const early = Buffer.concat([zip.subarray(0, dataStart), Buffer.from([0x50, 0x4b, 0x07, 0x08]), zip.subarray(dataStart)]);
    const end = early.length - 22;
    early.writeUInt32LE(early.readUInt32LE(end + 16) + 4, end + 16);
    early.writeUInt32LE(entry.compressedSize + 4, end - 46 - 5 + 20);
    expect(await measure(early, 1000)).toEqual({ ok: false, reason: 'directory mismatch' });
    // A local header with bit 3 and sizes filled in, followed by a descriptor: the reader reads the sizes and then meets a signature it cannot place.
    const filled = Buffer.from(zip);
    filled.writeUInt32LE(entry.compressedSize, 18);
    filled.writeUInt32LE(entry.uncompressedSize, 22);
    filled.writeUInt32LE(entry.crc, 14);
    expect(await measure(filled, 1000)).toEqual({ ok: false, reason: 'malformed' });
  });
});
