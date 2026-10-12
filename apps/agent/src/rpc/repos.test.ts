import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_DESCRIPTION_MAX_CHARS, RPC } from '@termhub/agent-protocol';
import { RpcFailure } from '../exec.js';
import { SCAN_BUDGET_MS, originUrl, packageDescription, readmeHeading, scan } from './repos.js';

// A real git on temporary folders: `home` stands in for the user's home, `proj` for the project folder.
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', [...ID, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp: string;
let home: string;
let proj: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'th-repos-')));
  home = path.join(tmp, 'home');
  proj = path.join(home, 'code', 'proj');
  mkdirSync(proj, { recursive: true });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

interface RepoOptions {
  origin?: string;
  /** Sets `origin/HEAD` to this branch, as a clone does. */
  head?: string;
  commit?: boolean;
  files?: Record<string, string>;
}

/** A checkout at `dir`, with one commit unless `commit` is false. */
function makeRepo(dir: string, opts: RepoOptions = {}): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', [...ID, 'init', '-q', dir]);
  for (const [name, body] of Object.entries(opts.files ?? {})) writeFileSync(path.join(dir, name), body);
  if (opts.commit !== false) {
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'first');
  }
  if (opts.origin) git(dir, 'remote', 'add', 'origin', opts.origin);
  if (opts.head) {
    git(dir, 'update-ref', `refs/remotes/origin/${opts.head}`, 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${opts.head}`);
  }
  return dir;
}

const dirsOf = async (depth = 1, dir = proj) => (await scan({ dir, depth }, home)).repos.map((r) => r.dir);

async function failure(p: Promise<unknown>): Promise<RpcFailure> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RpcFailure);
  return err as RpcFailure;
}

describe('git.repos.scan: where it looks', () => {
  it('lists a checkout at the folder itself as "."', async () => {
    makeRepo(proj, { origin: 'git@github.com:acme/app.git', head: 'main' });
    expect(await scan({ dir: proj, depth: 1 }, home)).toEqual({
      repos: [{ dir: '.', origin: 'git@github.com:acme/app.git', default_branch: 'main', has_commits: true, description: null }],
      truncated: false,
    });
  });

  it('lists the checkouts in subfolders, sorted, and answers a result the protocol accepts', async () => {
    makeRepo(path.join(proj, 'web'), { origin: 'https://github.com/acme/web.git', head: 'develop' });
    makeRepo(path.join(proj, 'api'), { origin: 'git@github.com:acme/api.git', head: 'main' });
    mkdirSync(path.join(proj, 'notes'));
    const res = await scan({ dir: proj, depth: 1 }, home);
    expect(res.repos).toEqual([
      { dir: 'api', origin: 'git@github.com:acme/api.git', default_branch: 'main', has_commits: true, description: null },
      { dir: 'web', origin: 'https://github.com/acme/web.git', default_branch: 'develop', has_commits: true, description: null },
    ]);
    expect(RPC['git.repos.scan'].result.safeParse(res).success).toBe(true);
  });

  it('still walks the subfolders of a folder that is itself a checkout (spec §10)', async () => {
    makeRepo(proj);
    makeRepo(path.join(proj, 'api'));
    expect(await dirsOf()).toEqual(['.', 'api']);
  });

  it('goes as deep as `depth` and no deeper', async () => {
    makeRepo(path.join(proj, 'one'));
    makeRepo(path.join(proj, 'g', 'two'));
    makeRepo(path.join(proj, 'g', 'h', 'three'));
    makeRepo(path.join(proj, 'g', 'h', 'i', 'four'));
    expect(await dirsOf(1)).toEqual(['one']);
    expect(await dirsOf(2)).toEqual(['g/two', 'one']);
    expect(await dirsOf(3)).toEqual(['g/h/three', 'g/two', 'one']);
  });

  it('does not walk into a checkout', async () => {
    makeRepo(path.join(proj, 'api'));
    makeRepo(path.join(proj, 'api', 'vendor', 'lib'));
    makeRepo(path.join(proj, 'api', 'inner'));
    expect(await dirsOf(3)).toEqual(['api']);
  });

  it('skips hidden folders and node_modules', async () => {
    makeRepo(path.join(proj, '.cache'));
    makeRepo(path.join(proj, 'node_modules'));
    makeRepo(path.join(proj, 'node_modules', 'pkg'));
    makeRepo(path.join(proj, 'tools', '.hidden', 'x'));
    makeRepo(path.join(proj, 'tools', 'node_modules', 'y'));
    makeRepo(path.join(proj, 'tools', 'ok'));
    expect(await dirsOf(3)).toEqual(['tools/ok']);
  });

  it('skips a git worktree, and whatever is under it', async () => {
    const api = makeRepo(path.join(proj, 'api'));
    const wt = path.join(proj, 'worktrees', 'TER-1');
    git(api, 'worktree', 'add', '-q', '-b', 'TER-1', wt);
    makeRepo(path.join(wt, 'nested'));
    expect(await dirsOf(3)).toEqual(['api']);
  });

  it('skips a submodule', async () => {
    const lib = makeRepo(path.join(tmp, 'lib'));
    makeRepo(proj);
    execFileSync('git', [...ID, '-c', 'protocol.file.allow=always', '-C', proj, 'submodule', 'add', '-q', lib, 'lib'], { stdio: 'ignore' });
    expect(await dirsOf(2)).toEqual(['.']);
  });

  it('never follows a link to a folder', async () => {
    const outside = makeRepo(path.join(tmp, 'outside'));
    symlinkSync(outside, path.join(proj, 'linked'));
    makeRepo(path.join(proj, 'real'));
    expect(await dirsOf(2)).toEqual(['real']);
  });

  it('answers no checkouts for a plain folder', async () => {
    mkdirSync(path.join(proj, 'docs'));
    writeFileSync(path.join(proj, 'notes.txt'), 'x');
    expect(await scan({ dir: proj, depth: 3 }, home)).toEqual({ repos: [], truncated: false });
  });

  it('expands ~ against the home folder', async () => {
    makeRepo(path.join(proj, 'api'));
    expect(await dirsOf(1, '~/code/proj')).toEqual(['api']);
  });
});

describe('git.repos.scan: what it says about a checkout', () => {
  const one = async () => (await scan({ dir: proj, depth: 1 }, home)).repos[0];

  it('answers a null origin and default branch for a checkout with no remote', async () => {
    makeRepo(proj);
    expect(await one()).toMatchObject({ dir: '.', origin: null, default_branch: null, has_commits: true });
  });

  it('answers ssh and https origins as they are', async () => {
    makeRepo(path.join(proj, 'a'), { origin: 'git@github.com:acme/a.git' });
    makeRepo(path.join(proj, 'b'), { origin: 'https://github.com/acme/b' });
    makeRepo(path.join(proj, 'c'), { origin: 'ssh://git@github.com/acme/c.git' });
    expect((await scan({ dir: proj, depth: 1 }, home)).repos.map((r) => r.origin)).toEqual([
      'git@github.com:acme/a.git',
      'https://github.com/acme/b',
      'ssh://git@github.com/acme/c.git',
    ]);
  });

  it('never answers the credentials kept in an origin URL', async () => {
    makeRepo(proj, { origin: 'https://x-access-token:ghp_secret@github.com/acme/app.git' });
    const repo = await one();
    expect(repo.origin).toBe('https://github.com/acme/app.git');
    expect(JSON.stringify(repo)).not.toContain('ghp_secret');
    expect(originUrl('https://ghp_secret@github.com/acme/app')).toBe('https://github.com/acme/app');
    expect(originUrl('HTTP://u:p@host/acme/app')).toBe('HTTP://host/acme/app');
    expect(originUrl('ssh://git:hunter2@github.com:22/acme/app.git')).toBe('ssh://git@github.com:22/acme/app.git');
    expect(originUrl('git@github.com:acme/app.git')).toBe('git@github.com:acme/app.git');
    expect(originUrl('/srv/git/app.git')).toBe('/srv/git/app.git');
  });

  it('answers the default branch only when origin/HEAD is set', async () => {
    makeRepo(path.join(proj, 'set'), { origin: 'git@github.com:acme/set.git', head: 'release/2' });
    makeRepo(path.join(proj, 'unset'), { origin: 'git@github.com:acme/unset.git' });
    expect((await scan({ dir: proj, depth: 1 }, home)).repos.map((r) => r.default_branch)).toEqual(['release/2', null]);
  });

  it('says a fresh `git init` has no commits', async () => {
    makeRepo(proj, { commit: false });
    expect(await one()).toMatchObject({ dir: '.', has_commits: false });
  });

  it('takes the description from package.json', async () => {
    makeRepo(proj, { files: { 'package.json': JSON.stringify({ name: 'app', description: 'The  storefront\n of Acme' }), 'README.md': '# Other\n' } });
    expect((await one()).description).toBe('The storefront of Acme');
  });

  it('takes the first heading of README.md when package.json has no description', async () => {
    makeRepo(proj, { files: { 'package.json': JSON.stringify({ name: 'app' }), 'README.md': 'intro\n\n```\n# not a heading\n```\n\n## Acme BFF ##\n\n# Later\n' } });
    expect((await one()).description).toBe('Acme BFF');
  });

  it('finds the readme whatever the letter case of its name', async () => {
    makeRepo(proj, { files: { 'readme.md': '# lower case\n' } });
    expect((await one()).description).toBe('lower case');
  });

  it('reads the description of a package.json longer than 4 KiB', async () => {
    const pkg = JSON.stringify({ name: 'app', description: 'Big "quoted" manifest', scripts: { x: 'y'.repeat(8000) } });
    makeRepo(proj, { files: { 'package.json': pkg } });
    expect((await one()).description).toBe('Big "quoted" manifest');
  });

  it('reads only the first 4 KiB of a file', async () => {
    makeRepo(proj, { files: { 'README.md': `${'text\n'.repeat(1000)}# Too far\n` } });
    expect((await one()).description).toBeNull();
  });

  it('keeps the description to 200 characters', async () => {
    makeRepo(proj, { files: { 'README.md': `# ${'é'.repeat(300)}\n` } });
    expect((await one()).description).toBe('é'.repeat(REPO_DESCRIPTION_MAX_CHARS));
  });

  it('answers a null description when there is nothing to read, or only a link', async () => {
    writeFileSync(path.join(tmp, 'secret.md'), '# Secret heading\n');
    makeRepo(path.join(proj, 'bare'));
    makeRepo(path.join(proj, 'linked'));
    symlinkSync(path.join(tmp, 'secret.md'), path.join(proj, 'linked', 'README.md'));
    makeRepo(path.join(proj, 'broken'), { files: { 'package.json': '{ not json', 'README.md': 'no heading here\n' } });
    expect((await scan({ dir: proj, depth: 1 }, home)).repos.map((r) => r.description)).toEqual([null, null, null]);
  });
});

describe('git.repos.scan: what it refuses', () => {
  it('refuses / and the home folder', async () => {
    makeRepo(home);
    for (const dir of ['/', home, '~', `${home}/`, `${home}/code/..`]) {
      const err = await failure(scan({ dir, depth: 1 }, home));
      expect(err.code, dir).toBe('invalid');
    }
  });

  it('refuses a link that leads to the home folder', async () => {
    symlinkSync(home, path.join(proj, 'up'));
    expect((await failure(scan({ dir: path.join(proj, 'up'), depth: 1 }, home))).code).toBe('invalid');
  });

  it('refuses the home folder reached through a link in its own path', async () => {
    const alias = path.join(tmp, 'alias');
    symlinkSync(home, alias);
    expect((await failure(scan({ dir: alias, depth: 1 }, alias))).code).toBe('invalid');
    expect((await failure(scan({ dir: home, depth: 1 }, alias))).code).toBe('invalid');
  });

  it('answers notfound for a folder that is missing or is a file', async () => {
    writeFileSync(path.join(proj, 'file'), 'x');
    expect((await failure(scan({ dir: path.join(proj, 'gone'), depth: 1 }, home))).code).toBe('notfound');
    expect((await failure(scan({ dir: path.join(proj, 'file'), depth: 1 }, home))).code).toBe('notfound');
  });

  it('keeps its deadline under the timeout the server waits', () => {
    expect(SCAN_BUDGET_MS).toBeLessThan(RPC['git.repos.scan'].timeoutMs);
  });
});

describe('description parsers', () => {
  it('reads only the top-level description of a whole package.json', () => {
    expect(packageDescription('{"name":"a","description":"top"}')).toBe('top');
    expect(packageDescription('{"name":"a","config":{"description":"nested"}}')).toBeNull();
    expect(packageDescription('{"description":42}')).toBeNull();
    expect(packageDescription('[]')).toBeNull();
  });

  it('falls back to the first description field of a cut package.json', () => {
    expect(packageDescription('{"name":"a","description":"cut \\u00e9 \\"x\\"","scripts":{"a":"')).toBe('cut é "x"');
    expect(packageDescription('{"name":"a","description":"never clos')).toBeNull();
  });

  it('reads the first ATX heading outside a code fence', () => {
    expect(readmeHeading('# Title\n')).toBe('Title');
    expect(readmeHeading('text\n~~~\n# no\n~~~\n### Deep  title ###\n')).toBe('Deep  title');
    expect(readmeHeading('#hashtag\n\nTitle\n=====\n')).toBeNull();
    expect(readmeHeading('')).toBeNull();
  });
});
