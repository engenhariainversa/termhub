import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FILE_SHARE_CHUNK_BYTES, FILE_SHARE_MAX_BYTES } from '@termhub/agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shareWithin } from './file-share.js';

let base: string;
let home: string;
let proj: string;
let tmp: string;
let elsewhere: string;
let agentHomeBefore: string | undefined;

const share = (p: string, opts: { roots?: string[]; only_roots?: boolean; offset?: number; length?: number } = {}) =>
  shareWithin({ path: p, roots: opts.roots ?? [], only_roots: opts.only_roots ?? false, offset: opts.offset ?? 0, length: opts.length ?? FILE_SHARE_CHUNK_BYTES }, { home, tmp: [tmp] });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'th-file-share-'));
  home = path.join(base, 'home');
  proj = path.join(base, 'srv', 'proj');
  tmp = path.join(base, 'tmp');
  elsewhere = path.join(base, 'etc');
  for (const d of [home, proj, tmp, elsewhere, path.join(home, '.termhub'), path.join(home, 'out'), path.join(home, '.ssh')]) await mkdir(d, { recursive: true });
  agentHomeBefore = process.env.TERMHUB_AGENT_HOME;
  process.env.TERMHUB_AGENT_HOME = path.join(home, '.termhub');
});
afterEach(async () => {
  if (agentHomeBefore === undefined) delete process.env.TERMHUB_AGENT_HOME;
  else process.env.TERMHUB_AGENT_HOME = agentHomeBefore;
  await rm(base, { recursive: true, force: true });
});

describe('file.share', () => {
  it('sends a binary image under home, as ~/ too, with the whole size and the resolved path', async () => {
    await writeFile(path.join(home, 'out', 'a.png'), PNG);
    const r = await share('~/out/a.png');
    expect(r).toMatchObject({ status: 'ok', size: PNG.length, offset: 0 });
    if (r.status === 'ok') {
      expect(Buffer.from(r.content_b64, 'base64')).toEqual(PNG);
      expect(r.path.endsWith(path.join('home', 'out', 'a.png'))).toBe(true);
    }
  });

  it('reads the chunk asked for', async () => {
    await writeFile(path.join(tmp, 'b.png'), PNG);
    const r = await share(path.join(tmp, 'b.png'), { offset: 8, length: 2 });
    expect(r.status === 'ok' && Buffer.from(r.content_b64, 'base64')).toEqual(Buffer.from([1, 2]));
    const last = await share(path.join(tmp, 'b.png'), { offset: 10, length: 100 });
    expect(last.status === 'ok' && Buffer.from(last.content_b64, 'base64')).toEqual(Buffer.from([3, 4]));
  });

  it('answers missing, outside, hidden and type', async () => {
    await writeFile(path.join(elsewhere, 'x.png'), PNG);
    await mkdir(path.join(home, '.cache'), { recursive: true });
    await writeFile(path.join(home, '.cache', 'x.png'), PNG);
    await writeFile(path.join(home, 'out', 'run.sh'), '#!/bin/sh');
    expect(await share('~/out/nope.png')).toEqual({ status: 'missing' });
    expect(await share(path.join(elsewhere, 'x.png'))).toEqual({ status: 'outside' });
    expect(await share('~/.cache/x.png')).toEqual({ status: 'hidden' });
    expect(await share('~/out/run.sh')).toEqual({ status: 'type' });
  });

  it('refuses a secret by its path, before saying whether it exists, and through a link', async () => {
    await writeFile(path.join(home, '.ssh', 'id.png'), PNG);
    await writeFile(path.join(home, 'out', 'credentials.json'), '{}');
    await writeFile(path.join(home, '.ssh', 'k.txt'), 'key');
    await symlink(path.join(home, '.ssh', 'k.txt'), path.join(home, 'out', 'notes.txt'));
    expect(await share('~/.ssh/id.png')).toEqual({ status: 'secret' });
    expect(await share('~/.ssh/none.png')).toEqual({ status: 'secret' });
    expect(await share('~/out/credentials.json')).toEqual({ status: 'secret' });
    // The link's target is under a dot folder: refused before its name is even looked at.
    expect((await share('~/out/notes.txt')).status).toMatch(/^(secret|hidden)$/);
  });

  it('with only_roots, shares from the given folders and nowhere else', async () => {
    await writeFile(path.join(proj, 'shot.png'), PNG);
    await writeFile(path.join(home, 'out', 'a.png'), PNG);
    expect((await share(path.join(proj, 'shot.png'), { roots: [proj], only_roots: true })).status).toBe('ok');
    expect(await share('~/out/a.png', { roots: [proj], only_roots: true })).toEqual({ status: 'outside' });
  });

  it('refuses a directory and a file over the limit, with its size', async () => {
    await mkdir(path.join(home, 'out', 'dir.png'));
    expect(await share('~/out/dir.png')).toEqual({ status: 'not_file' });
    const big = path.join(home, 'out', 'big.mp4');
    await writeFile(big, '');
    const { truncate } = await import('node:fs/promises');
    await truncate(big, FILE_SHARE_MAX_BYTES + 1);
    expect(await share('~/out/big.mp4')).toEqual({ status: 'too_large', size: FILE_SHARE_MAX_BYTES + 1 });
  });

  it('answers changed for an offset past the end', async () => {
    await writeFile(path.join(home, 'out', 'a.png'), PNG);
    expect(await share('~/out/a.png', { offset: PNG.length + 1 })).toEqual({ status: 'changed' });
  });
});
