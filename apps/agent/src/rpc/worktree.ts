import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GIT_BRANCH_RE, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { expandHome } from '@termhub/machine-ops';
import { RpcFailure, agentEnv, run, type RunResult } from '../exec.js';

/**
 * Git worktrees for automatic work (spec 2026-10-04 agentic board, §7). Every git call takes an argv
 * array (`run` → `execFile`), never a shell string, and `path` is held under the expanded `root`.
 * `home` is only ever overridden by tests (production always uses os.homedir()).
 */

const FETCH_TIMEOUT_MS = 90_000;
const GIT_TIMEOUT_MS = 20_000;

/** git with no prompt for credentials: a fetch that would ask hangs no RPC, it fails. */
function git(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<RunResult> {
  return run('git', args, { timeoutMs, env: agentEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' }) });
}

function gitFailure(what: string, r: RunResult): RpcFailure {
  if (r.error === 'enoent') return new RpcFailure('failed', 'git não encontrado nesta máquina');
  if (r.timedOut) return new RpcFailure('timeout', `${what} timed out`);
  const why = r.stderr.trim().split('\n').slice(-3).join('\n').slice(0, 1500);
  return new RpcFailure('failed', `${what} falhou${why ? `: ${why}` : ''}`);
}

async function gitOk(what: string, args: string[], timeoutMs?: number): Promise<string> {
  const r = await git(args, timeoutMs);
  if (r.code !== 0) throw gitFailure(what, r);
  return r.stdout.trim();
}

function checkBranch(name: string): void {
  if (!GIT_BRANCH_RE.test(name)) throw new RpcFailure('invalid', 'invalid branch name');
}

function absolute(p: string, home: string): string {
  const out = expandHome(p, home);
  if (!path.isAbsolute(out)) throw new RpcFailure('invalid', 'path must be absolute');
  return path.resolve(out);
}

const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The worktree path, checked against `root`: lexically first (no `..` out, never `root` itself), then
 * through the links of whatever part of it already exists, so a link under `root` cannot lead out.
 * Returns the real path (the parent resolved, the last missing segments appended).
 */
async function guardPath(rootParam: string, pathParam: string, home: string): Promise<string> {
  const root = absolute(rootParam, home);
  const target = absolute(pathParam, home);
  if (!inside(root, target)) throw new RpcFailure('path_outside_root', 'path is outside the worktrees folder', pathParam);
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  let existing = target;
  const missing: string[] = [];
  while (!(await exists(existing))) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  let real: string;
  try {
    real = await realpath(existing);
  } catch {
    // A dangling link: it points somewhere that does not exist, never under root by construction.
    throw new RpcFailure('path_outside_root', 'path is outside the worktrees folder', pathParam);
  }
  const resolved = path.join(real, ...missing);
  if (!inside(realRoot, resolved)) throw new RpcFailure('path_outside_root', 'path is outside the worktrees folder', pathParam);
  return resolved;
}

interface WorktreeEntry {
  path: string;
  /** `refs/heads/<name>` stripped to `<name>`; null when detached. */
  branch: string | null;
}

/** `git worktree list --porcelain`, the main worktree first. */
async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const out = await gitOk('git worktree list', ['-C', repoDir, 'worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  for (const block of out.split(/\n\n+/)) {
    let p: string | null = null;
    let branch: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) p = line.slice('worktree '.length);
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
    }
    if (p !== null) entries.push({ path: p, branch });
  }
  return entries;
}

/** The registered worktree at `target` (compared by real path), never the repo's main worktree. */
async function findWorktree(repoDir: string, target: string): Promise<WorktreeEntry | null> {
  const entries = await listWorktrees(repoDir);
  for (const e of entries.slice(1)) {
    const real = await realpath(e.path).catch(() => e.path);
    if (real === target) return e;
  }
  return null;
}

async function repoOf(repoDirParam: string, home: string): Promise<string> {
  const repoDir = absolute(repoDirParam, home);
  const r = await git(['-C', repoDir, 'rev-parse', '--git-dir']);
  if (r.code !== 0) throw new RpcFailure('failed', `${repoDirParam} não é um repositório git`, repoDirParam);
  return repoDir;
}

/** The commit `ref` points at, or null when it does not exist. */
async function commitOf(repoDir: string, ref: string): Promise<string | null> {
  const r = await git(['-C', repoDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Whether `origin` has `branch`: `ls-remote --exit-code` answers 2 when it does not. */
async function remoteHas(repoDir: string, branch: string): Promise<boolean> {
  const r = await git(['-C', repoDir, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], FETCH_TIMEOUT_MS);
  if (r.code === 0) return true;
  if (r.code === 2) return false;
  throw gitFailure('git ls-remote', r);
}

const conflict = (message: string, p: string) => new RpcFailure('worktree_conflict', message, p);

export async function ensure(params: RpcParams<'git.worktree.ensure'>, home = os.homedir()): Promise<RpcResult<'git.worktree.ensure'>> {
  checkBranch(params.branch);
  checkBranch(params.base);
  const target = await guardPath(params.root, params.path, home);
  const repoDir = await repoOf(params.repo_dir, home);

  if (await exists(target)) {
    const wt = await findWorktree(repoDir, target);
    if (wt) {
      if (wt.branch !== params.branch) throw conflict(`a worktree em ${params.path} está em outro branch (${wt.branch ?? 'detached'})`, params.path);
      return { path: target, head: await gitOk('git rev-parse', ['-C', target, 'rev-parse', 'HEAD']), created: false };
    }
    if ((await readdir(target).catch(() => ['x'])).length > 0) throw conflict(`${params.path} já existe e não é uma worktree deste repositório`, params.path);
  }

  // A worktree whose folder was deleted by hand stays registered and blocks `worktree add` on its path.
  await gitOk('git worktree prune', ['-C', repoDir, 'worktree', 'prune']);

  const pushed = await remoteHas(repoDir, params.branch);
  const refspecs = [`+refs/heads/${params.base}:refs/remotes/origin/${params.base}`];
  if (pushed) refspecs.push(`+refs/heads/${params.branch}:refs/remotes/origin/${params.branch}`);
  await gitOk('git fetch', ['-C', repoDir, 'fetch', '--no-tags', 'origin', ...refspecs], FETCH_TIMEOUT_MS);

  const local = await commitOf(repoDir, `refs/heads/${params.branch}`);
  const remote = pushed ? await commitOf(repoDir, `refs/remotes/origin/${params.branch}`) : null;
  let args: string[];
  if (local === null || (remote !== null && local === remote)) {
    // A new branch, or one equal to what was pushed: `-B` starts it (resets nothing that matters).
    args = pushed
      ? ['worktree', 'add', '--track', '-B', params.branch, target, `origin/${params.branch}`]
      : ['worktree', 'add', '--no-track', '-B', params.branch, target, `origin/${params.base}`];
  } else {
    // A local branch with work of its own: checked out as it is, never reset.
    args = ['worktree', 'add', target, params.branch];
  }
  const r = await git(['-C', repoDir, ...args]);
  if (r.code !== 0) {
    if (/already (checked out|used by worktree)/.test(r.stderr)) throw conflict(`o branch ${params.branch} já está aberto em outra worktree`, params.path);
    throw gitFailure('git worktree add', r);
  }
  return { path: target, head: await gitOk('git rev-parse', ['-C', target, 'rev-parse', 'HEAD']), created: true };
}

export async function remove(params: RpcParams<'git.worktree.remove'>, home = os.homedir()): Promise<RpcResult<'git.worktree.remove'>> {
  const target = await guardPath(params.root, params.path, home);
  const repoDir = await repoOf(params.repo_dir, home);
  if (!(await exists(target))) {
    await gitOk('git worktree prune', ['-C', repoDir, 'worktree', 'prune']);
    return { removed: false, dirty: false };
  }
  if (!(await findWorktree(repoDir, target))) throw new RpcFailure('invalid', 'not a worktree of this repository', params.path);
  const status = await gitOk('git status', ['-C', target, 'status', '--porcelain']);
  if (status !== '') return { removed: false, dirty: true };
  await gitOk('git worktree remove', ['-C', repoDir, 'worktree', 'remove', target]);
  return { removed: true, dirty: false };
}
