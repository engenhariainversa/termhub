import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GIT_BRANCH_RE, RPC, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { expandHome } from '@termhub/machine-ops';
import { trustWorktree } from '../claude-trust.js';
import { RpcFailure, agentEnv, run, type RunResult } from '../exec.js';

/**
 * Git worktrees for automatic work (spec 2026-10-04 agentic board, §7). Every git call takes an argv
 * array (`run` → `execFile`), never a shell string, and `path` is held under the expanded `root`.
 * `home` is only ever overridden by tests (production always uses os.homedir()).
 */

/** Margin kept under the server's RPC timeout, so the agent always answers before the server gives up. */
const RPC_MARGIN_MS = 10_000;
/** The whole of one call, every git step included (the server waits `RPC[...].timeoutMs`). */
export const ENSURE_BUDGET_MS = RPC['git.worktree.ensure'].timeoutMs - RPC_MARGIN_MS;
export const REMOVE_BUDGET_MS = RPC['git.worktree.remove'].timeoutMs - RPC_MARGIN_MS;
/** What `ensure` keeps for `git worktree add` (a checkout of a large repo is slow): the network
 *  steps (ls-remote, fetch) only get what is left above it. */
const WORKTREE_ADD_SHARE_MS = 60_000;
/** Cap for a local, quick git step (rev-parse, status, prune, list). */
const QUICK_STEP_MS = 15_000;

/** One overall deadline, split across the steps of a call. */
class Deadline {
  private readonly end: number;
  constructor(budgetMs: number) {
    this.end = Date.now() + budgetMs;
  }
  /** The timeout for the next step: at most `capMs`, never eating into `reserveMs` kept for later steps. */
  step(what: string, capMs: number, reserveMs = 0): number {
    const left = this.end - Date.now() - reserveMs;
    if (left <= 0) throw new RpcFailure('timeout', `${what} timed out`);
    return Math.min(capMs, left);
  }
}

/** Removes `user:pass@` from URLs: git prints the remote URL in its errors, and a token can live there. */
export function scrubCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');
}

/** git with no prompt for credentials: a fetch that would ask hangs no RPC, it fails. */
function git(args: string[], timeoutMs: number): Promise<RunResult> {
  return run('git', args, { timeoutMs, env: agentEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' }) });
}

function gitFailure(what: string, r: RunResult): RpcFailure {
  if (r.error === 'enoent') return new RpcFailure('failed', 'git não encontrado nesta máquina');
  if (r.timedOut) return new RpcFailure('timeout', `${what} timed out`);
  const why = scrubCredentials(r.stderr.trim().split('\n').slice(-3).join('\n')).slice(0, 1500);
  return new RpcFailure('failed', `${what} falhou${why ? `: ${why}` : ''}`);
}

async function gitOk(what: string, args: string[], timeoutMs: number): Promise<string> {
  const r = await git(args, timeoutMs);
  if (r.code !== 0) throw gitFailure(what, r);
  return r.stdout.trim();
}

function checkBranch(name: string): void {
  if (!GIT_BRANCH_RE.test(name)) throw new RpcFailure('invalid', 'invalid branch name');
}

function absolute(p: string, home: string): string {
  const out = p === '~' ? home : expandHome(p, home);
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
 * Returns the real path (the parent resolved, the last missing segments appended), or null when
 * `root` is missing and `createRoot` is off (nothing can be under it).
 */
async function guardPath(rootParam: string, pathParam: string, home: string, opts: { createRoot: boolean }): Promise<string | null> {
  const root = absolute(rootParam, home);
  const target = absolute(pathParam, home);
  if (!inside(root, target)) throw new RpcFailure('path_outside_root', 'path is outside the worktrees folder', pathParam);
  const realHome = await realpath(home).catch(() => path.resolve(home));
  // A root of `/` or of the home itself would let `path` be any folder of the user's.
  const broad = (r: string) => r === path.parse(r).root || r === path.resolve(home) || r === realHome;
  if (broad(root)) throw new RpcFailure('path_outside_root', 'the worktrees folder cannot be / or the home folder', rootParam);
  if (opts.createRoot) await mkdir(root, { recursive: true });
  else if (!(await exists(root))) return null;
  const realRoot = await realpath(root);
  if (broad(realRoot)) throw new RpcFailure('path_outside_root', 'the worktrees folder cannot be / or the home folder', rootParam);
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

export interface WorktreeEntry {
  path: string;
  /** `refs/heads/<name>` stripped to `<name>`; null when detached. */
  branch: string | null;
}

/** Parses `git worktree list --porcelain` output: `sep` is `\0` with `-z`, else `\n`; an empty field ends an entry. */
export function parseWorktreeList(out: string, sep: '\0' | '\n'): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let p: string | null = null;
  let branch: string | null = null;
  for (const field of [...out.split(sep), '']) {
    if (field === '') {
      if (p !== null) entries.push({ path: p, branch });
      p = null;
      branch = null;
    } else if (field.startsWith('worktree ')) p = field.slice('worktree '.length);
    else if (field.startsWith('branch refs/heads/')) branch = field.slice('branch refs/heads/'.length);
  }
  return entries;
}

/** `git worktree list --porcelain -z` (NUL-separated, safe for any path), the main worktree first.
 *  git before 2.36 has no `-z`: then the newline form, which only a path with a newline could break. */
async function listWorktrees(repoDir: string, timeoutMs: number): Promise<WorktreeEntry[]> {
  const r = await git(['-C', repoDir, 'worktree', 'list', '--porcelain', '-z'], timeoutMs);
  if (r.code === 0) return parseWorktreeList(r.stdout, '\0');
  if (r.timedOut || r.error) throw gitFailure('git worktree list', r);
  return parseWorktreeList(await gitOk('git worktree list', ['-C', repoDir, 'worktree', 'list', '--porcelain'], timeoutMs), '\n');
}

/** The registered worktree at `target` (compared by real path), never the repo's main worktree. */
async function findWorktree(repoDir: string, target: string, timeoutMs: number): Promise<WorktreeEntry | null> {
  const entries = await listWorktrees(repoDir, timeoutMs);
  for (const e of entries.slice(1)) {
    const real = await realpath(e.path).catch(() => e.path);
    if (real === target) return e;
  }
  return null;
}

async function repoOf(repoDirParam: string, home: string, timeoutMs: number): Promise<string> {
  const repoDir = absolute(repoDirParam, home);
  const r = await git(['-C', repoDir, 'rev-parse', '--git-dir'], timeoutMs);
  if (r.timedOut) throw gitFailure('git rev-parse', r);
  if (r.code !== 0) throw new RpcFailure('failed', `${repoDirParam} não é um repositório git`, repoDirParam);
  return repoDir;
}

/** The commit `ref` points at, or null when it does not exist. */
async function commitOf(repoDir: string, ref: string, timeoutMs: number): Promise<string | null> {
  const r = await git(['-C', repoDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], timeoutMs);
  if (r.timedOut) throw gitFailure('git rev-parse', r);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Whether `origin` has `branch`: `ls-remote --exit-code` answers 2 when it does not. */
async function remoteHas(repoDir: string, branch: string, timeoutMs: number): Promise<boolean> {
  const r = await git(['-C', repoDir, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], timeoutMs);
  if (r.code === 0) return true;
  if (r.code === 2) return false;
  throw gitFailure('git ls-remote', r);
}

const conflict = (message: string, p: string) => new RpcFailure('worktree_conflict', message, p);

/**
 * The run's worktree, then (TER-1025) the worktree marked trusted in every Claude account here, so Claude's
 * trust question never stops an automatic run in it. The trust step is best effort and never fails the call.
 */
export async function ensure(params: RpcParams<'git.worktree.ensure'>, home = os.homedir()): Promise<RpcResult<'git.worktree.ensure'>> {
  const result = await ensureWorktree(params, home);
  await trustWorktree(result.path, home).catch(() => 0);
  return result;
}

async function ensureWorktree(params: RpcParams<'git.worktree.ensure'>, home: string): Promise<RpcResult<'git.worktree.ensure'>> {
  checkBranch(params.branch);
  checkBranch(params.base);
  const d = new Deadline(ENSURE_BUDGET_MS);
  // Every step before `worktree add` leaves WORKTREE_ADD_SHARE_MS (and a quick step after it) untouched.
  const keep = WORKTREE_ADD_SHARE_MS + QUICK_STEP_MS;
  const quick = (what: string) => d.step(what, QUICK_STEP_MS, keep);
  const target = (await guardPath(params.root, params.path, home, { createRoot: true }))!;
  const repoDir = await repoOf(params.repo_dir, home, quick('git rev-parse'));

  if (await exists(target)) {
    const wt = await findWorktree(repoDir, target, quick('git worktree list'));
    if (wt) {
      if (wt.branch !== params.branch) throw conflict(`a worktree em ${params.path} está em outro branch (${wt.branch ?? 'detached'})`, params.path);
      return { path: target, head: await gitOk('git rev-parse', ['-C', target, 'rev-parse', 'HEAD'], quick('git rev-parse')), created: false };
    }
    if ((await readdir(target).catch(() => ['x'])).length > 0) throw conflict(`${params.path} já existe e não é uma worktree deste repositório`, params.path);
  }

  // A worktree whose folder was deleted by hand stays registered and blocks `worktree add` on its path.
  await gitOk('git worktree prune', ['-C', repoDir, 'worktree', 'prune'], quick('git worktree prune'));

  const pushed = await remoteHas(repoDir, params.branch, d.step('git ls-remote', 30_000, keep));
  const refspecs = [`+refs/heads/${params.base}:refs/remotes/origin/${params.base}`];
  if (pushed) refspecs.push(`+refs/heads/${params.branch}:refs/remotes/origin/${params.branch}`);
  await gitOk('git fetch', ['-C', repoDir, 'fetch', '--no-tags', 'origin', ...refspecs], d.step('git fetch', ENSURE_BUDGET_MS, keep));

  const remoteRef = `refs/remotes/origin/${params.branch}`;
  const local = await commitOf(repoDir, `refs/heads/${params.branch}`, quick('git rev-parse'));
  const remote = pushed ? await commitOf(repoDir, remoteRef, quick('git rev-parse')) : null;
  let args: string[];
  if (local === null || (remote !== null && local === remote)) {
    // A new branch, or one equal to what was pushed: `-B` starts it (resets nothing that matters).
    args = pushed
      ? ['worktree', 'add', '--track', '-B', params.branch, target, remoteRef]
      : ['worktree', 'add', '--no-track', '-B', params.branch, target, `refs/remotes/origin/${params.base}`];
  } else {
    // A local branch with work of its own: checked out as it is, never reset.
    args = ['worktree', 'add', target, params.branch];
  }
  const r = await git(['-C', repoDir, ...args], d.step('git worktree add', ENSURE_BUDGET_MS, QUICK_STEP_MS));
  if (r.code !== 0) {
    if (/already (checked out|used by worktree)/.test(r.stderr)) throw conflict(`o branch ${params.branch} já está aberto em outra worktree`, params.path);
    throw gitFailure('git worktree add', r);
  }
  return { path: target, head: await gitOk('git rev-parse', ['-C', target, 'rev-parse', 'HEAD'], d.step('git rev-parse', QUICK_STEP_MS)), created: true };
}

export async function remove(params: RpcParams<'git.worktree.remove'>, home = os.homedir()): Promise<RpcResult<'git.worktree.remove'>> {
  const d = new Deadline(REMOVE_BUDGET_MS);
  const target = await guardPath(params.root, params.path, home, { createRoot: false });
  if (target === null) return { removed: false, dirty: false };
  const repoDir = await repoOf(params.repo_dir, home, d.step('git rev-parse', QUICK_STEP_MS));
  if (!(await exists(target))) {
    await gitOk('git worktree prune', ['-C', repoDir, 'worktree', 'prune'], d.step('git worktree prune', QUICK_STEP_MS));
    return { removed: false, dirty: false };
  }
  if (!(await findWorktree(repoDir, target, d.step('git worktree list', QUICK_STEP_MS)))) throw new RpcFailure('invalid', 'not a worktree of this repository', params.path);
  const status = await gitOk('git status', ['-C', target, 'status', '--porcelain'], d.step('git status', QUICK_STEP_MS));
  if (status !== '') return { removed: false, dirty: true };
  await gitOk('git worktree remove', ['-C', repoDir, 'worktree', 'remove', target], d.step('git worktree remove', REMOVE_BUDGET_MS));
  return { removed: true, dirty: false };
}
