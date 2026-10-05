import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcFailure } from '../exec.js';
import { ensure, remove } from './worktree.js';

// A real git: a bare repo stands in for `origin`, a clone for the project folder on the machine.
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', [...ID, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let tmp: string;
let origin: string;
let repo: string;
let root: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'th-worktree-')));
  origin = path.join(tmp, 'origin.git');
  repo = path.join(tmp, 'repo');
  root = path.join(tmp, 'worktrees');
  execFileSync('git', [...ID, 'init', '-q', '--bare', origin]);
  execFileSync('git', [...ID, 'clone', '-q', origin, repo], { stdio: 'ignore' });
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const params = (over: Partial<Parameters<typeof ensure>[0]> = {}) => ({ repo_dir: repo, root, path: path.join(root, 'p1', 'TER-1'), branch: 'TER-1-x', base: 'main', ...over });

async function failure(p: Promise<unknown>): Promise<RpcFailure> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RpcFailure);
  return err as RpcFailure;
}

describe('git.worktree.ensure', () => {
  it('creates the worktree on a new branch from origin/<base>, without tracking the base', async () => {
    const res = await ensure(params());
    expect(res.created).toBe(true);
    expect(res.path).toBe(path.join(root, 'p1', 'TER-1'));
    expect(res.head).toBe(git(repo, 'rev-parse', 'origin/main'));
    expect(git(res.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('TER-1-x');
    expect(() => git(res.path, 'rev-parse', '--abbrev-ref', 'TER-1-x@{upstream}')).toThrow();
  });

  it('answers created: false when called twice', async () => {
    const first = await ensure(params());
    const second = await ensure(params());
    expect(second).toEqual({ path: first.path, head: first.head, created: false });
  });

  it('refuses another branch at the same path with worktree_conflict', async () => {
    await ensure(params());
    expect((await failure(ensure(params({ branch: 'TER-2-y' })))).code).toBe('worktree_conflict');
  });

  it('refuses a folder in the way that is not a worktree', async () => {
    mkdirSync(path.join(root, 'p1', 'TER-1'), { recursive: true });
    writeFileSync(path.join(root, 'p1', 'TER-1', 'x'), 'x');
    expect((await failure(ensure(params()))).code).toBe('worktree_conflict');
  });

  it('refuses a branch already checked out in another worktree', async () => {
    await ensure(params());
    expect((await failure(ensure(params({ path: path.join(root, 'p1', 'other') })))).code).toBe('worktree_conflict');
  });

  it('refuses a path outside root', async () => {
    expect((await failure(ensure(params({ path: root + '/../x' })))).code).toBe('path_outside_root');
    expect((await failure(ensure(params({ path: root })))).code).toBe('path_outside_root');
    expect((await failure(ensure(params({ path: tmp + '/worktrees-evil/x' })))).code).toBe('path_outside_root');
    expect(existsSync(path.join(tmp, 'x'))).toBe(false);
  });

  it('refuses a link under root that points out of it', async () => {
    mkdirSync(root, { recursive: true });
    mkdirSync(path.join(tmp, 'elsewhere'));
    symlinkSync(path.join(tmp, 'elsewhere'), path.join(root, 'p1'));
    expect((await failure(ensure(params()))).code).toBe('path_outside_root');
    expect(existsSync(path.join(tmp, 'elsewhere', 'TER-1'))).toBe(false);
  });

  it('refuses option-looking branch names before running git', async () => {
    expect((await failure(ensure(params({ branch: '--upload-pack=x' })))).code).toBe('invalid');
    expect((await failure(ensure(params({ base: '-x' })))).code).toBe('invalid');
  });

  it('expands ~ in root, repo_dir and path', async () => {
    const res = await ensure({ repo_dir: '~/repo', root: '~/worktrees', path: '~/worktrees/p1/TER-1', branch: 'TER-1-x', base: 'main' }, tmp);
    expect(res.path).toBe(path.join(root, 'p1', 'TER-1'));
    expect(res.created).toBe(true);
  });

  it('starts from origin/<branch> when the branch was already pushed, never resetting it to the base', async () => {
    const first = await ensure(params());
    writeFileSync(path.join(first.path, 'b.txt'), 'b\n');
    git(first.path, 'add', 'b.txt');
    git(first.path, 'commit', '-q', '-m', 'work');
    git(first.path, 'push', '-q', 'origin', 'TER-1-x');
    const pushed = git(first.path, 'rev-parse', 'HEAD');
    await remove({ repo_dir: repo, root, path: first.path });
    git(repo, 'branch', '-D', 'TER-1-x');

    const again = await ensure(params());
    expect(again.created).toBe(true);
    expect(again.head).toBe(pushed);
  });

  it('keeps a local branch that differs from the remote as it is', async () => {
    const first = await ensure(params());
    writeFileSync(path.join(first.path, 'c.txt'), 'c\n');
    git(first.path, 'add', 'c.txt');
    git(first.path, 'commit', '-q', '-m', 'local only');
    const local = git(first.path, 'rev-parse', 'HEAD');
    await remove({ repo_dir: repo, root, path: first.path });

    const again = await ensure(params());
    expect(again.head).toBe(local);
  });

  it('fails with a message when the base does not exist on origin', async () => {
    const err = await failure(ensure(params({ base: 'nope' })));
    expect(err.code).toBe('failed');
  });
});

describe('git.worktree.remove', () => {
  it('removes a clean worktree and keeps the branch', async () => {
    const { path: wt } = await ensure(params());
    expect(await remove({ repo_dir: repo, root, path: wt })).toEqual({ removed: true, dirty: false });
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/TER-1-x')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('keeps a dirty worktree', async () => {
    const { path: wt } = await ensure(params());
    writeFileSync(path.join(wt, 'untracked.txt'), 'x');
    expect(await remove({ repo_dir: repo, root, path: wt })).toEqual({ removed: false, dirty: true });
    expect(existsSync(path.join(wt, 'untracked.txt'))).toBe(true);
  });

  it('answers removed: false for a path that is gone', async () => {
    expect(await remove({ repo_dir: repo, root, path: path.join(root, 'p1', 'gone') })).toEqual({ removed: false, dirty: false });
  });

  it('refuses a folder that is not a worktree of the repo, and a path outside root', async () => {
    mkdirSync(path.join(root, 'p1', 'plain'), { recursive: true });
    expect((await failure(remove({ repo_dir: repo, root, path: path.join(root, 'p1', 'plain') }))).code).toBe('invalid');
    expect(existsSync(path.join(root, 'p1', 'plain'))).toBe(true);
    expect((await failure(remove({ repo_dir: repo, root, path: repo }))).code).toBe('path_outside_root');
  });
});
