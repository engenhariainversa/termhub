import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { FILE_READ_MAX_BYTES } from '@termhub/agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placeIn, readWithin } from './file-read.js';

let base: string;
let home: string;
let proj: string;
let tmp: string;
let elsewhere: string;
let agentHomeBefore: string | undefined;

const read = (p: string, roots: string[] = [proj]) => readWithin({ path: p, roots }, { home, tmp: [tmp] });
const body = (r: Awaited<ReturnType<typeof read>>) => (r.status === 'ok' ? Buffer.from(r.content_b64, 'base64').toString('utf8') : null);

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'th-file-read-'));
  home = path.join(base, 'home');
  proj = path.join(base, 'srv', 'proj');
  tmp = path.join(base, 'tmp');
  elsewhere = path.join(base, 'etc');
  for (const d of [home, proj, tmp, elsewhere, path.join(home, '.termhub')]) await mkdir(d, { recursive: true });
  agentHomeBefore = process.env.TERMHUB_AGENT_HOME;
  process.env.TERMHUB_AGENT_HOME = path.join(home, '.termhub');
});
afterEach(async () => {
  if (agentHomeBefore === undefined) delete process.env.TERMHUB_AGENT_HOME;
  else process.env.TERMHUB_AGENT_HOME = agentHomeBefore;
  await rm(base, { recursive: true, force: true });
});

describe('file.read: allowed folders', () => {
  it('reads a .md in the project, in home (also as ~/) and in the temp dir', async () => {
    await writeFile(path.join(proj, 'a.md'), '# proj');
    await writeFile(path.join(home, 'r.md'), '# home');
    await writeFile(path.join(tmp, 't.md'), '# tmp');
    expect(body(await read(path.join(proj, 'a.md')))).toBe('# proj');
    expect(body(await read(path.join(home, 'r.md')))).toBe('# home');
    expect(body(await read(path.join(tmp, 't.md')))).toBe('# tmp');
    const viaTilde = await readWithin({ path: '~/r.md', roots: [] }, { home, tmp: [] });
    expect(body(viaTilde)).toBe('# home');
  });

  it('answers ok with the resolved path, size and mtime', async () => {
    await writeFile(path.join(proj, 'a.md'), 'abc');
    const r = await read(path.join(proj, 'a.md'));
    expect(r).toMatchObject({ status: 'ok', size: 3 });
    if (r.status === 'ok') {
      expect(r.path.endsWith(path.join('srv', 'proj', 'a.md'))).toBe(true);
      expect(r.mtime_ms).toBeGreaterThan(0);
    }
  });

  it('refuses a file outside every folder', async () => {
    await writeFile(path.join(elsewhere, 'x.md'), 'secret');
    expect(await read(path.join(elsewhere, 'x.md'))).toEqual({ status: 'outside' });
  });

  it('refuses the project folder when the server did not send it', async () => {
    await writeFile(path.join(proj, 'a.md'), 'x');
    expect(await read(path.join(proj, 'a.md'), [])).toEqual({ status: 'outside' });
  });

  it('refuses a dot-dot path that climbs out of a folder', async () => {
    await writeFile(path.join(elsewhere, 'x.md'), 'secret');
    expect(await read(`${proj}/../../etc/x.md`)).toEqual({ status: 'outside' });
  });

  it('never takes / as a folder, from the server or the config file', async () => {
    await writeFile(path.join(elsewhere, 'x.md'), 'secret');
    expect(await read(path.join(elsewhere, 'x.md'), ['/'])).toEqual({ status: 'outside' });
  });

  it('adds the folders listed in ~/.termhub/file-read-roots', async () => {
    await writeFile(path.join(elsewhere, 'x.md'), 'ok');
    await writeFile(path.join(home, '.termhub', 'file-read-roots'), `# extra\n\n${elsewhere}\n`);
    expect(body(await read(path.join(elsewhere, 'x.md')))).toBe('ok');
  });

  it('refuses a dot folder or dot file below the folder (~/.ssh, .git, .env.md)', async () => {
    await mkdir(path.join(home, '.ssh'));
    await writeFile(path.join(home, '.ssh', 'notes.md'), 'k');
    await mkdir(path.join(proj, '.git'));
    await writeFile(path.join(proj, '.git', 'x.md'), 'k');
    await writeFile(path.join(proj, '.env.md'), 'k');
    expect(await read(path.join(home, '.ssh', 'notes.md'))).toEqual({ status: 'hidden' });
    expect(await read(path.join(proj, '.git', 'x.md'))).toEqual({ status: 'hidden' });
    expect(await read(path.join(proj, '.env.md'))).toEqual({ status: 'hidden' });
  });

  it('allows a project that itself lives in a dot folder when the server names it', async () => {
    const hiddenProj = path.join(home, '.local', 'proj');
    await mkdir(hiddenProj, { recursive: true });
    await writeFile(path.join(hiddenProj, 'a.md'), 'ok');
    expect(body(await read(path.join(hiddenProj, 'a.md'), [hiddenProj]))).toBe('ok');
  });
});

describe('file.read: symbolic links', () => {
  it('refuses a link inside the project that points outside every folder', async () => {
    await writeFile(path.join(elsewhere, 'passwd.md'), 'secret');
    await symlink(path.join(elsewhere, 'passwd.md'), path.join(proj, 'leak.md'));
    expect(await read(path.join(proj, 'leak.md'))).toEqual({ status: 'outside' });
  });

  it('refuses a link to a dot folder in home', async () => {
    await mkdir(path.join(home, '.ssh'));
    await writeFile(path.join(home, '.ssh', 'id.md'), 'k');
    await symlink(path.join(home, '.ssh', 'id.md'), path.join(proj, 'id.md'));
    expect(await read(path.join(proj, 'id.md'))).toEqual({ status: 'hidden' });
  });

  it('refuses a linked folder that leaves the folders', async () => {
    await writeFile(path.join(elsewhere, 'x.md'), 'secret');
    await symlink(elsewhere, path.join(proj, 'docs'));
    expect(await read(path.join(proj, 'docs', 'x.md'))).toEqual({ status: 'outside' });
  });

  it('refuses a .md link to a file of another type', async () => {
    await writeFile(path.join(proj, 'key.pem'), 'k');
    await symlink(path.join(proj, 'key.pem'), path.join(proj, 'key.md'));
    expect(await read(path.join(proj, 'key.md'))).toEqual({ status: 'type' });
  });

  it('follows a link that stays inside a folder', async () => {
    await writeFile(path.join(home, 'real.md'), 'ok');
    await symlink(path.join(home, 'real.md'), path.join(proj, 'alias.md'));
    expect(body(await read(path.join(proj, 'alias.md')))).toBe('ok');
  });

  it('accepts a project folder that is itself a link', async () => {
    const linked = path.join(home, 'proj-link');
    await symlink(proj, linked);
    await writeFile(path.join(proj, 'a.md'), 'ok');
    expect(body(await read(path.join(linked, 'a.md'), [linked]))).toBe('ok');
  });

  it('answers missing for a dangling link', async () => {
    await symlink(path.join(proj, 'gone.md'), path.join(proj, 'dangling.md'));
    expect(await read(path.join(proj, 'dangling.md'))).toEqual({ status: 'missing' });
  });
});

describe('file.read: types and size', () => {
  it.each(['a.md', 'b.markdown', 'c.txt', 'D.MD'])('reads %s', async (name) => {
    await writeFile(path.join(proj, name), 'ok');
    expect(body(await read(path.join(proj, name)))).toBe('ok');
  });

  it.each(['id_rsa', 'a.json', 'b.html', 'c.md.sh', 'd.env'])('refuses %s as type', async (name) => {
    await writeFile(path.join(proj, name), 'k');
    expect(await read(path.join(proj, name))).toEqual({ status: 'type' });
  });

  it('refuses a directory named like a document', async () => {
    await mkdir(path.join(proj, 'dir.md'));
    expect(await read(path.join(proj, 'dir.md'))).toEqual({ status: 'not_file' });
  });

  it('refuses a FIFO without blocking on it', async () => {
    const fifo = path.join(proj, 'pipe.md');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo here
    }
    expect(await read(fifo)).toEqual({ status: 'not_file' });
  });

  it('reads a file of exactly the limit and refuses one byte more, with its size', async () => {
    await writeFile(path.join(proj, 'max.md'), 'x'.repeat(FILE_READ_MAX_BYTES));
    await writeFile(path.join(proj, 'big.md'), 'x'.repeat(FILE_READ_MAX_BYTES + 1));
    expect((await read(path.join(proj, 'max.md'))).status).toBe('ok');
    expect(await read(path.join(proj, 'big.md'))).toEqual({ status: 'too_large', size: FILE_READ_MAX_BYTES + 1 });
  });

  it('refuses a binary file (NUL byte or invalid UTF-8) and keeps UTF-8 text intact', async () => {
    await writeFile(path.join(proj, 'nul.md'), Buffer.from([0x23, 0x00, 0x41]));
    await writeFile(path.join(proj, 'latin1.md'), Buffer.from([0x63, 0x61, 0xe7, 0x61]));
    await writeFile(path.join(proj, 'pt.md'), '# Relatório: ação ✓');
    expect(await read(path.join(proj, 'nul.md'))).toEqual({ status: 'binary' });
    expect(await read(path.join(proj, 'latin1.md'))).toEqual({ status: 'binary' });
    expect(body(await read(path.join(proj, 'pt.md')))).toBe('# Relatório: ação ✓');
  });

  it('answers missing for a file that is not there', async () => {
    expect(await read(path.join(proj, 'nope.md'))).toEqual({ status: 'missing' });
  });

  it('answers eperm for a file its user cannot read', async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    await writeFile(path.join(proj, 'locked.md'), 'x');
    await chmod(path.join(proj, 'locked.md'), 0o000);
    expect(await read(path.join(proj, 'locked.md'))).toEqual({ status: 'eperm' });
  });
});

describe('placeIn', () => {
  it('says ok, hidden or outside', () => {
    expect(placeIn('/h/p/a.md', ['/h/p'])).toBe('ok');
    expect(placeIn('/h/.p/a.md', ['/h'])).toBe('hidden');
    expect(placeIn('/h/.p/a.md', ['/h', '/h/.p'])).toBe('ok');
    expect(placeIn('/x/a.md', ['/h'])).toBe('outside');
    expect(placeIn('/hx/a.md', ['/h'])).toBe('outside');
    expect(placeIn('/h', ['/h'])).toBe('outside');
  });
});
