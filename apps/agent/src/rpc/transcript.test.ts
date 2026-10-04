import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RpcParams } from '@termhub/agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { read, shrink, shrinkLine } from './transcript.js';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const line = (o: object) => JSON.stringify(o) + '\n';

let tmp: string;
let file: string;
const req = (over: Partial<RpcParams<'transcript.read'>> = {}): RpcParams<'transcript.read'> => ({
  transcript_path: file,
  session_id: SID,
  direction: 'forward',
  offset: 0,
  max_bytes: 262_144,
  types: ['user', 'assistant'],
  max_string: 256,
  ...over,
});

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'th-transcript-'));
  await mkdir(path.join(tmp, 'cfg/projects/-w'), { recursive: true });
  file = path.join(tmp, 'cfg/projects/-w', `${SID}.jsonl`);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('transcript.read', () => {
  it('reads forward whole lines and reports the range', async () => {
    await writeFile(file, line({ type: 'user', uuid: 'a' }) + line({ type: 'mode' }) + line({ type: 'assistant', uuid: 'b' }));
    const r = await read(req());
    expect(r.status).toBe('ok');
    expect(r.lines.map((l) => JSON.parse(l).uuid)).toEqual(['a', 'b']);
    expect(r.start).toBe(0);
    expect(r.end).toBe(r.size);
  });

  it('leaves a partial last line for the next call', async () => {
    const whole = line({ type: 'user', uuid: 'a' });
    await writeFile(file, whole + '{"type":"assistant","uu');
    const r = await read(req());
    expect(r.lines).toHaveLength(1);
    expect(r.end).toBe(Buffer.byteLength(whole));
  });

  it('stops a forward read at max_bytes on a line boundary', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => line({ type: 'user', uuid: `u${i}`, pad: 'x'.repeat(100) }));
    await writeFile(file, rows.join(''));
    const r = await read(req({ max_bytes: 1024 }));
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.length).toBeLessThan(20);
    expect(r.end).toBe(rows.slice(0, r.lines.length).join('').length);
    const next = await read(req({ offset: r.end, max_bytes: 1024 }));
    expect(JSON.parse(next.lines[0]).uuid).toBe(`u${r.lines.length}`);
  });

  it('reads backward from the end and stops at max_bytes on a line boundary', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => line({ type: 'user', uuid: `u${i}`, pad: 'x'.repeat(100) }));
    await writeFile(file, rows.join(''));
    const r = await read(req({ direction: 'backward', offset: null, max_bytes: 1024 }));
    const ids = r.lines.map((l) => JSON.parse(l).uuid);
    expect(ids.at(-1)).toBe('u49');
    expect(ids.length).toBeLessThan(50);
    expect(r.end).toBe(r.size);
    // the earlier page ends exactly where this one starts
    const prev = await read(req({ direction: 'backward', offset: r.start, max_bytes: 1024 }));
    expect(JSON.parse(prev.lines.at(-1)!).uuid).toBe(`u${49 - ids.length}`);
    expect(prev.end).toBe(r.start);
  });

  it('a backward read leaves out a line still being written', async () => {
    const whole = line({ type: 'user', uuid: 'a' });
    await writeFile(file, whole + '{"type":"assistant","uu');
    const r = await read(req({ direction: 'backward', offset: null }));
    expect(r.lines.map((l) => JSON.parse(l).uuid)).toEqual(['a']);
    expect(r.start).toBe(0);
    expect(r.end).toBe(Buffer.byteLength(whole));
  });

  it('truncates long strings and long arrays at any depth', () => {
    const out = shrink({ a: 'x'.repeat(300), b: { c: ['y'.repeat(300)] }, d: Array.from({ length: 250 }, (_, i) => i) }, 256) as {
      a: string;
      b: { c: string[] };
      d: number[];
    };
    expect(out.a).toBe('x'.repeat(256) + '…[+44]');
    expect(out.b.c[0]).toBe('y'.repeat(256) + '…[+44]');
    expect(out.d).toHaveLength(200);
  });

  it('replaces a line still over the limit by a stub', () => {
    const big = { type: 'user', uuid: 'a', timestamp: 't', message: { content: Array.from({ length: 200 }, () => ({ text: 'z'.repeat(16_000) })) } };
    expect(JSON.parse(shrinkLine(JSON.stringify(big), ['user'], 16_384)!)).toEqual({ type: 'user', uuid: 'a', timestamp: 't', termhub_dropped: true });
  });

  it('drops a line that is not JSON or not of an asked type', () => {
    expect(shrinkLine('not json', ['user'], 256)).toBeNull();
    expect(shrinkLine('{"type":"mode"}', ['user'], 256)).toBeNull();
    expect(shrinkLine('[1,2]', ['user'], 256)).toBeNull();
  });

  it('skips a line longer than the read window and still advances', async () => {
    await writeFile(file, line({ type: 'user', uuid: 'a' }) + line({ type: 'user', uuid: 'huge', pad: 'x'.repeat(5 * 1024 * 1024) }) + line({ type: 'user', uuid: 'c' }));
    const first = await read(req());
    const second = await read(req({ offset: first.end }));
    const third = await read(req({ offset: second.end }));
    const ids = [...first.lines, ...second.lines, ...third.lines].map((l) => JSON.parse(l).uuid);
    expect(ids).toEqual(['a', 'c']);
    expect(third.end).toBe(third.size);
  });

  it('a huge line is skipped going backward too', async () => {
    await writeFile(file, line({ type: 'user', uuid: 'a' }) + line({ type: 'user', uuid: 'huge', pad: 'x'.repeat(5 * 1024 * 1024) }) + line({ type: 'user', uuid: 'c' }));
    const ids: string[] = [];
    let offset: number | null = null;
    for (let i = 0; i < 5; i++) {
      const r = await read(req({ direction: 'backward', offset }));
      ids.unshift(...r.lines.map((l) => JSON.parse(l).uuid));
      if (r.start === 0) break;
      offset = r.start;
    }
    expect(ids).toEqual(['a', 'c']);
  });

  it('finds a transcript that moved to another project dir of the same account', async () => {
    await mkdir(path.join(tmp, 'cfg/projects/-other'), { recursive: true });
    await writeFile(path.join(tmp, 'cfg/projects/-other', `${SID}.jsonl`), line({ type: 'user', uuid: 'moved' }));
    const r = await read(req()); // `file` itself was never written
    expect(JSON.parse(r.lines[0]).uuid).toBe('moved');
  });

  it('answers missing when the transcript is nowhere', async () => {
    expect(await read(req())).toEqual({ status: 'missing', lines: [], start: 0, end: 0, size: 0 });
  });

  it.each([
    ['outside projects', (t: string) => path.join(t, `cfg/-w/${SID}.jsonl`)],
    ['another file name', (t: string) => path.join(t, 'cfg/projects/-w/notes.jsonl')],
    ['a dot-dot segment', (t: string) => path.join(t, 'cfg/projects/-w') + `/../-w/${SID}.jsonl`],
    ['a relative path', () => `cfg/projects/-w/${SID}.jsonl`],
  ])('refuses %s as invalid', async (_n, make) => {
    await expect(read(req({ transcript_path: make(tmp) }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses a link whose target leaves the transcript shape', async () => {
    await writeFile(path.join(tmp, 'secret.txt'), 'x\n');
    await symlink(path.join(tmp, 'secret.txt'), file);
    await expect(read(req())).rejects.toMatchObject({ code: 'invalid' });
  });

  it('follows a link into another account (the account swap)', async () => {
    const other = path.join(tmp, 'cfg2/projects/-w');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, `${SID}.jsonl`), line({ type: 'user', uuid: 'linked' }));
    await symlink(path.join(other, `${SID}.jsonl`), file);
    expect(JSON.parse((await read(req())).lines[0]).uuid).toBe('linked');
  });
});
