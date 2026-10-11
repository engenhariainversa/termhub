import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { FILE_LIST_MAX_ENTRIES, FILE_READ_MAX_BYTES, type RpcParams } from '@termhub/agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listWithin } from './file-list.js';

let base: string;
let home: string;
let proj: string;
let tmp: string;
let elsewhere: string;
let agentHomeBefore: string | undefined;

type Params = RpcParams<'file.list'>;
const list = (p: Partial<Params> = {}) => listWithin({ cwd: proj, dirs: ['docs'], paths: [], roots: [proj], ...p }, { home, tmp: [tmp] });
const names = async (p: Partial<Params> = {}) => (await list(p)).entries.map((e) => path.basename(e.path)).sort();
const docs = () => path.join(proj, 'docs');

/** Sets a file's mtime to `s` seconds after the epoch, so the order is not left to the clock. */
const age = (file: string, s: number) => utimes(file, s, s);

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'th-file-list-'));
  home = path.join(base, 'home');
  proj = path.join(base, 'srv', 'proj');
  tmp = path.join(base, 'tmp');
  elsewhere = path.join(base, 'etc');
  for (const d of [home, docs(), tmp, elsewhere, path.join(home, '.termhub')]) await mkdir(d, { recursive: true });
  agentHomeBefore = process.env.TERMHUB_AGENT_HOME;
  process.env.TERMHUB_AGENT_HOME = path.join(home, '.termhub');
});
afterEach(async () => {
  if (agentHomeBefore === undefined) delete process.env.TERMHUB_AGENT_HOME;
  else process.env.TERMHUB_AGENT_HOME = agentHomeBefore;
  await rm(base, { recursive: true, force: true });
});

describe('file.list: folders', () => {
  it('lists the .md files of a folder under the project, with path, asked, size and mtime', async () => {
    await writeFile(path.join(docs(), 'a.md'), 'abc');
    await age(path.join(docs(), 'a.md'), 1_000);
    const { entries } = await list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ asked: path.join(proj, 'docs', 'a.md'), size: 3, mtime_ms: 1_000_000, too_large: false });
    expect(entries[0].path.endsWith(path.join('srv', 'proj', 'docs', 'a.md'))).toBe(true);
  });

  it('lists several folders and does not recurse into subfolders', async () => {
    await mkdir(path.join(docs(), 'lessons', 'old'), { recursive: true });
    await writeFile(path.join(docs(), 'a.md'), 'x');
    await writeFile(path.join(docs(), 'lessons', 'l.md'), 'x');
    await writeFile(path.join(docs(), 'lessons', 'old', 'deep.md'), 'x');
    expect(await names({ dirs: ['docs', 'docs/lessons'] })).toEqual(['a.md', 'l.md']);
  });

  it('lists README.md too (leaving it out is the server\'s choice)', async () => {
    await writeFile(path.join(docs(), 'README.md'), 'x');
    expect(await names()).toEqual(['README.md']);
  });

  it('lists nothing for a missing folder, and still answers the rest', async () => {
    await writeFile(path.join(docs(), 'a.md'), 'x');
    expect(await names({ dirs: ['nope', 'docs'] })).toEqual(['a.md']);
  });

  it('ignores the folders when there is no cwd', async () => {
    await writeFile(path.join(docs(), 'a.md'), 'x');
    expect((await list({ cwd: null })).entries).toEqual([]);
  });

  it('takes a cwd written with ~/', async () => {
    const homeProj = path.join(home, 'p');
    await mkdir(path.join(homeProj, 'docs'), { recursive: true });
    await writeFile(path.join(homeProj, 'docs', 'a.md'), 'x');
    const { entries } = await list({ cwd: '~/p', roots: ['~/p'] });
    expect(entries.map((e) => e.asked)).toEqual(['~/p/docs/a.md']);
  });

  it('leaves out a folder outside every allowed folder (cwd not among the roots)', async () => {
    await mkdir(path.join(elsewhere, 'docs'));
    await writeFile(path.join(elsewhere, 'docs', 'x.md'), 'secret');
    expect((await list({ cwd: elsewhere })).entries).toEqual([]);
  });

  it('leaves out the project folder when the server did not send it as a root', async () => {
    await writeFile(path.join(docs(), 'a.md'), 'x');
    expect((await list({ roots: [] })).entries).toEqual([]);
  });
});

describe('file.list: allowed folders for cited paths', () => {
  it('lists a cited file in the project, in home (also as ~/) and in the temp dir', async () => {
    await writeFile(path.join(proj, 'p.md'), 'x');
    await writeFile(path.join(home, 'h.md'), 'x');
    await writeFile(path.join(tmp, 't.md'), 'x');
    const { entries } = await list({ dirs: [], paths: [path.join(proj, 'p.md'), '~/h.md', path.join(tmp, 't.md')] });
    expect(entries.map((e) => e.asked).sort()).toEqual([path.join(proj, 'p.md'), path.join(tmp, 't.md'), '~/h.md'].sort());
  });

  it('lists a cited file in a folder of ~/.termhub/file-read-roots', async () => {
    await writeFile(path.join(elsewhere, 'x.md'), 'ok');
    expect((await list({ dirs: [], paths: [path.join(elsewhere, 'x.md')] })).entries).toEqual([]);
    await writeFile(path.join(home, '.termhub', 'file-read-roots'), `# extra\n${elsewhere}\n`);
    expect(await names({ dirs: [], paths: [path.join(elsewhere, 'x.md')] })).toEqual(['x.md']);
  });

  it('leaves out a cited file outside every folder, and one that climbs out with ..', async () => {
    await writeFile(path.join(elsewhere, 'x.md'), 'secret');
    const { entries } = await list({ dirs: [], paths: [path.join(elsewhere, 'x.md'), `${proj}/../../etc/x.md`] });
    expect(entries).toEqual([]);
  });

  it('never takes / as a folder', async () => {
    await writeFile(path.join(elsewhere, 'x.md'), 'secret');
    expect((await list({ dirs: [], paths: [path.join(elsewhere, 'x.md')], roots: ['/'] })).entries).toEqual([]);
  });

  it('leaves out a cited path that is not there', async () => {
    expect((await list({ dirs: [], paths: [path.join(proj, 'gone.md')] })).entries).toEqual([]);
  });

  it('answers the cited path exactly as the server sent it', async () => {
    await writeFile(path.join(proj, 'p.md'), 'x');
    const sent = `${proj}/docs/../p.md`;
    const { entries } = await list({ dirs: [], paths: [sent] });
    expect(entries.map((e) => e.asked)).toEqual([sent]);
    expect(entries[0].path.endsWith(path.join('proj', 'p.md'))).toBe(true);
  });
});

describe('file.list: dot folders and dot files', () => {
  it('leaves out a dot file in a listed folder', async () => {
    await writeFile(path.join(docs(), '.draft.md'), 'x');
    await writeFile(path.join(docs(), 'a.md'), 'x');
    expect(await names()).toEqual(['a.md']);
  });

  it('leaves out a cited file under a dot folder (~/.ssh, .git)', async () => {
    await mkdir(path.join(home, '.ssh'));
    await writeFile(path.join(home, '.ssh', 'notes.md'), 'k');
    await mkdir(path.join(proj, '.git'));
    await writeFile(path.join(proj, '.git', 'x.md'), 'k');
    const { entries } = await list({ dirs: [], paths: ['~/.ssh/notes.md', path.join(proj, '.git', 'x.md')] });
    expect(entries).toEqual([]);
  });

  it('lists a project that itself lives in a dot folder when the server names it', async () => {
    const hiddenProj = path.join(home, '.local', 'proj');
    await mkdir(path.join(hiddenProj, 'docs'), { recursive: true });
    await writeFile(path.join(hiddenProj, 'docs', 'a.md'), 'x');
    expect(await names({ cwd: hiddenProj, roots: [hiddenProj] })).toEqual(['a.md']);
  });
});

describe('file.list: symbolic links', () => {
  it('leaves out a link in a listed folder that points outside every folder', async () => {
    await writeFile(path.join(elsewhere, 'passwd.md'), 'secret');
    await symlink(path.join(elsewhere, 'passwd.md'), path.join(docs(), 'leak.md'));
    expect((await list()).entries).toEqual([]);
  });

  it('leaves out a link to a dot folder in home', async () => {
    await mkdir(path.join(home, '.ssh'));
    await writeFile(path.join(home, '.ssh', 'id.md'), 'k');
    await symlink(path.join(home, '.ssh', 'id.md'), path.join(docs(), 'id.md'));
    expect((await list()).entries).toEqual([]);
  });

  it('lists nothing from a listed folder that is a link leaving the folders', async () => {
    await writeFile(path.join(elsewhere, 'x.md'), 'secret');
    await symlink(elsewhere, path.join(proj, 'linked'));
    expect((await list({ dirs: ['linked'] })).entries).toEqual([]);
  });

  it('leaves out a .md link to a file of another type', async () => {
    await writeFile(path.join(proj, 'key.pem'), 'k');
    await symlink(path.join(proj, 'key.pem'), path.join(docs(), 'key.md'));
    expect((await list()).entries).toEqual([]);
  });

  it('follows a link that stays inside a folder, answering the resolved path', async () => {
    await writeFile(path.join(home, 'real.md'), 'ok');
    await symlink(path.join(home, 'real.md'), path.join(docs(), 'alias.md'));
    const { entries } = await list();
    expect(entries).toHaveLength(1);
    expect(entries[0].asked).toBe(path.join(docs(), 'alias.md'));
    expect(path.basename(entries[0].path)).toBe('real.md');
  });

  it('leaves out a dangling link', async () => {
    await symlink(path.join(docs(), 'gone.md'), path.join(docs(), 'dangling.md'));
    expect((await list()).entries).toEqual([]);
  });
});

describe('file.list: types', () => {
  it('lists .md and .markdown in any case, and nothing else (not even .txt)', async () => {
    for (const n of ['a.md', 'b.markdown', 'C.MD', 'd.txt', 'e.json', 'id_rsa', 'f.md.sh', 'g.html']) await writeFile(path.join(docs(), n), 'x');
    expect(await names()).toEqual(['C.MD', 'a.md', 'b.markdown']);
  });

  it('leaves out a cited .txt', async () => {
    await writeFile(path.join(proj, 'r.txt'), 'x');
    expect((await list({ dirs: [], paths: [path.join(proj, 'r.txt')] })).entries).toEqual([]);
  });

  it('leaves out a directory named like a document', async () => {
    await mkdir(path.join(docs(), 'dir.md'));
    expect((await list({ paths: [path.join(docs(), 'dir.md')] })).entries).toEqual([]);
  });

  it('leaves out a FIFO without blocking on it, listed or cited', async () => {
    const fifo = path.join(docs(), 'pipe.md');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo here
    }
    await writeFile(path.join(docs(), 'a.md'), 'x');
    expect(await names({ paths: [fifo] })).toEqual(['a.md']);
  });
});

describe('file.list: size, duplicates, order and limit', () => {
  it('lists a file over the read limit as too_large, with its size', async () => {
    await writeFile(path.join(docs(), 'max.md'), 'x'.repeat(FILE_READ_MAX_BYTES));
    await writeFile(path.join(docs(), 'big.md'), 'x'.repeat(FILE_READ_MAX_BYTES + 1));
    const byName = Object.fromEntries((await list()).entries.map((e) => [path.basename(e.path), e]));
    expect(byName['max.md']).toMatchObject({ size: FILE_READ_MAX_BYTES, too_large: false });
    expect(byName['big.md']).toMatchObject({ size: FILE_READ_MAX_BYTES + 1, too_large: true });
  });

  it('answers a file once when listed, cited and linked, keeping the cited path as asked', async () => {
    await writeFile(path.join(docs(), 'a.md'), 'x');
    await symlink(path.join(docs(), 'a.md'), path.join(docs(), 'same.md'));
    const cited = '~/../' + path.relative(path.dirname(home), path.join(docs(), 'a.md'));
    const { entries } = await list({ paths: [path.join(docs(), 'a.md'), path.join(docs(), 'a.md'), cited] });
    expect(entries).toHaveLength(1);
    expect(entries[0].asked).toBe(path.join(docs(), 'a.md'));
  });

  it('sorts newest first', async () => {
    await writeFile(path.join(docs(), 'old.md'), 'x');
    await writeFile(path.join(docs(), 'new.md'), 'x');
    await writeFile(path.join(home, 'mid.md'), 'x');
    await age(path.join(docs(), 'old.md'), 1_000);
    await age(path.join(docs(), 'new.md'), 3_000);
    await age(path.join(home, 'mid.md'), 2_000);
    const { entries } = await list({ paths: ['~/mid.md'] });
    expect(entries.map((e) => path.basename(e.path))).toEqual(['new.md', 'mid.md', 'old.md']);
  });

  it(`answers at most ${FILE_LIST_MAX_ENTRIES} entries, the newest ones`, async () => {
    const n = FILE_LIST_MAX_ENTRIES + 20;
    for (let i = 0; i < n; i++) {
      const f = path.join(docs(), `f${String(i).padStart(4, '0')}.md`);
      await writeFile(f, 'x');
      await age(f, 1_000 + i);
    }
    const { entries } = await list();
    expect(entries).toHaveLength(FILE_LIST_MAX_ENTRIES);
    expect(path.basename(entries[0].path)).toBe(`f${String(n - 1).padStart(4, '0')}.md`);
    expect(path.basename(entries.at(-1)!.path)).toBe('f0020.md');
  });
});
