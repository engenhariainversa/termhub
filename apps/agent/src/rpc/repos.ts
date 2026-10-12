import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_DESCRIPTION_MAX_CHARS, REPO_SCAN_MAX_REPOS, RPC, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { expandHome } from '@termhub/machine-ops';
import { RpcFailure } from '../exec.js';
import { Deadline, QUICK_STEP_MS, git, gitFailure } from './worktree.js';

/**
 * The git checkouts of a project folder, for repository discovery (spec 2026-10-07 multi-repo R2, R4, R10,
 * §5 step 2). The walk is `readdir` only, never a shell, and every git call takes an argv array.
 * `home` is only ever overridden by tests (production always uses os.homedir()).
 */

/** Margin kept under the server's RPC timeout, so the agent always answers before the server gives up. */
const RPC_MARGIN_MS = 10_000;
export const SCAN_BUDGET_MS = RPC['git.repos.scan'].timeoutMs - RPC_MARGIN_MS;
/** The most folders one scan looks at: a huge folder answers what it found so far, with `truncated`. */
const MAX_FOLDERS = 5000;
/** How much of `package.json` or `README.md` is read for the description (spec §5 step 2). */
const DESCRIPTION_READ_BYTES = 4096;

type Repo = RpcResult<'git.repos.scan'>['repos'][number];

/** `checkout`: `.git` is a folder. `linked`: `.git` is a file, so a worktree or a submodule. */
async function gitKind(dir: string): Promise<'checkout' | 'linked' | 'none'> {
  const dotGit = path.join(dir, '.git');
  try {
    const st = await lstat(dotGit);
    if (st.isDirectory()) return 'checkout';
    if (st.isSymbolicLink() && (await stat(dotGit)).isDirectory()) return 'checkout';
    return 'linked';
  } catch {
    return 'none';
  }
}

/** The scanned folder, links resolved. `/` and the home folder are refused, the same rule `worktrees_dir` has. */
async function scanRoot(dirParam: string, home: string): Promise<string> {
  const asked = dirParam === '~' ? home : expandHome(dirParam, home);
  if (!path.isAbsolute(asked)) throw new RpcFailure('invalid', 'path must be absolute');
  const realHome = await realpath(home).catch(() => path.resolve(home));
  const broad = (p: string) => p === path.parse(p).root || p === path.resolve(home) || p === realHome;
  const refuse = () => new RpcFailure('invalid', 'the scanned folder cannot be / or the home folder', dirParam);
  if (broad(path.resolve(asked))) throw refuse();
  let root: string;
  try {
    root = await realpath(asked);
    if (!(await stat(root)).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new RpcFailure('notfound', 'folder not found', dirParam);
  }
  if (broad(root)) throw refuse();
  return root;
}

/** The first `DESCRIPTION_READ_BYTES` of a regular file; a link is not followed. Null when it cannot be read. */
async function head(file: string): Promise<string | null> {
  try {
    const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await fh.stat()).isFile()) return null;
      const buf = Buffer.alloc(DESCRIPTION_READ_BYTES);
      const { bytesRead } = await fh.read(buf, 0, DESCRIPTION_READ_BYTES, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** The top-level `description` of a `package.json`. A manifest cut at the read cap is not valid JSON:
 *  then the first `"description": "…"` in what was read. */
export function packageDescription(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = /"description"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
    if (!m) return null;
    try {
      parsed = { description: JSON.parse(m[1]) };
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const description = (parsed as { description?: unknown }).description;
  return typeof description === 'string' ? description : null;
}

/** The first ATX heading (`# Title`) of a Markdown text, outside fenced code. */
export function readmeHeading(text: string): string | null {
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

/** One line of at most REPO_DESCRIPTION_MAX_CHARS, or null when nothing is left. */
function oneLine(text: string | null): string | null {
  if (text === null) return null;
  let out = text.replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, REPO_DESCRIPTION_MAX_CHARS);
  // The cut may fall in the middle of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  out = out.trimEnd();
  return out === '' ? null : out;
}

async function describe(dir: string): Promise<string | null> {
  const manifest = await head(path.join(dir, 'package.json'));
  const fromManifest = oneLine(manifest === null ? null : packageDescription(manifest));
  if (fromManifest !== null) return fromManifest;
  const names = await readdir(dir).catch(() => [] as string[]);
  const readme = names.includes('README.md') ? 'README.md' : names.sort().find((n) => n.toLowerCase() === 'readme.md');
  if (!readme) return null;
  const text = await head(path.join(dir, readme));
  return oneLine(text === null ? null : readmeHeading(text));
}

/**
 * The `origin` URL without a secret: an http(s) URL loses its whole `user:pass@` (a token lives in either
 * half), any other scheme only the password, since the user of `ssh://git@host/…` is part of the address.
 * The scp form (`git@host:owner/repo`) has no scheme and is left as it is.
 */
export function originUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^\s/@]+)@(.*)$/is.exec(url);
  if (!m) return url;
  const [, scheme, userinfo, rest] = m;
  if (/^https?$/i.test(scheme)) return `${scheme}://${rest}`;
  return `${scheme}://${userinfo.split(':')[0]}@${rest}`;
}

/** What git says about the checkout at `dir`, or null when git does not take it as a repository
 *  (a folder owned by someone else, a broken `.git`). */
async function inspect(dir: string, rel: string, d: Deadline): Promise<Repo | null> {
  // Stdout of one quick git step; null when it exited non-zero. A timeout or a missing git fails the call.
  const ask = async (what: string, ...args: string[]): Promise<string | null> => {
    const r = await git(['-C', dir, ...args], d.step(what, QUICK_STEP_MS));
    if (r.timedOut || r.error) throw gitFailure(what, r);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  if ((await ask('git rev-parse', 'rev-parse', '--git-dir')) === null) return null;
  const origin = await ask('git remote get-url', 'remote', 'get-url', 'origin');
  const originHead = await ask('git symbolic-ref', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  const lastCommit = await ask('git rev-list', 'rev-list', '-n1', '--all');
  return {
    dir: rel,
    origin: origin ? originUrl(origin).slice(0, 2048) : null,
    default_branch: originHead ? originHead.replace(/^origin\//, '').slice(0, 255) : null,
    has_commits: !!lastCommit,
    description: await describe(dir),
  };
}

export async function scan(params: RpcParams<'git.repos.scan'>, home = os.homedir()): Promise<RpcResult<'git.repos.scan'>> {
  const d = new Deadline(SCAN_BUDGET_MS);
  const root = await scanRoot(params.dir, home);

  // `dir` relative to the root, with `/`; `.` for the root itself (spec §4).
  const found: string[] = [];
  let truncated = false;
  let seen = 0;
  // The root is walked even when it is a checkout: it may also hold repos of their own (spec §10).
  if ((await gitKind(root)) === 'checkout') found.push('.');
  let level = [''];
  walk: for (let depth = 1; depth <= params.depth; depth++) {
    const next: string[] = [];
    for (const parent of level) {
      const entries = await readdir(path.join(root, parent), { withFileTypes: true }).catch(() => []);
      // A link is not a directory here, so the walk never leaves the folder nor loops.
      const names = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name);
      for (const name of names.sort()) {
        if (++seen > MAX_FOLDERS) {
          truncated = true;
          break walk;
        }
        const rel = parent === '' ? name : `${parent}/${name}`;
        const kind = await gitKind(path.join(root, rel));
        if (kind === 'none') next.push(rel);
        else if (kind === 'checkout') {
          if (found.length >= REPO_SCAN_MAX_REPOS) {
            truncated = true;
            break walk;
          }
          found.push(rel);
        }
      }
    }
    level = next;
  }

  const repos: Repo[] = [];
  for (const rel of found.sort()) {
    const repo = await inspect(path.join(root, rel), rel, d);
    if (repo) repos.push(repo);
  }
  return { repos, truncated };
}
