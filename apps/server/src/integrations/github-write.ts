import { failure, GithubCiError } from './github-ci.js';

const API = 'https://api.github.com';
const PER_PAGE = 100;
/** GitHub lists at most 3000 files of a pull request. */
export const FILES_CAP = 3000;

export interface PullInfo {
  number: number;
  url: string;
}

export interface PullFiles {
  paths: string[];
  /** False when the list may be missing files (GitHub's 3000 cap reached, or pagination stopped early). */
  complete: boolean;
}

export interface GithubWriteClient {
  branchSha(token: string, repo: string, branch: string): Promise<string | null>;
  createBranch(token: string, repo: string, branch: string, fromSha: string): Promise<'created' | 'exists'>;
  openPull(token: string, repo: string, i: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<PullInfo>;
  findOpenPull(token: string, repo: string, head: string, base: string): Promise<PullInfo | null>;
  /** `head_repo`: the repository the head branch lives in (`owner/name`), null when the fork is gone. */
  pull(token: string, repo: string, n: number): Promise<{ mergeable: boolean | null; mergeable_state: string; head_sha: string; head_ref: string; head_repo: string | null; base_ref: string }>;
  /** How far `head` is from `base` (a branch or a sha): `behind_by` = commits of the base the head lacks. */
  compare(token: string, repo: string, base: string, head: string): Promise<{ ahead_by: number; behind_by: number }>;
  files(token: string, repo: string, n: number): Promise<PullFiles>;
  /** 409 (head moved) gives `{ merged: false }`; 405 (not mergeable, already merged, method not allowed) throws `not_mergeable`. */
  merge(token: string, repo: string, n: number, i: { sha: string; title: string; method: 'squash' | 'merge' }): Promise<{ merged: boolean; sha: string | null }>;
  /** Merges the base into a PR that is behind it (GitHub's "Update branch"). False when the head moved or there was nothing to do (422). */
  updateBranch(token: string, repo: string, n: number, expectedHeadSha: string): Promise<boolean>;
}

/** Like the CI client's mapping, but a 403 that is not a rate limit on a write means the token is read-only. */
function writeFailure(res: Response): GithubCiError {
  const err = failure(res);
  if (res.status === 403 && err.kind === 'auth') return new GithubCiError('forbidden', 403);
  if (res.status === 405) return new GithubCiError('not_mergeable', 405);
  return err;
}

const enc = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

/** Write side of the GitHub integration for the automation (branches, pulls, merge). The token is only ever a header. */
export function createGithubWriteClient(fetchImpl: typeof fetch = fetch): GithubWriteClient {
  const call = (token: string, method: string, url: string, body?: unknown) =>
    fetchImpl(url.startsWith('http') ? url : `${API}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'termhub',
        'x-github-api-version': '2022-11-28',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const toInfo = (p: { number: number; html_url: string }): PullInfo => ({ number: p.number, url: p.html_url });

  return {
    async branchSha(token, repo, branch) {
      const res = await call(token, 'GET', `/repos/${repo}/git/ref/heads/${enc(branch)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw writeFailure(res);
      return ((await res.json()) as { object: { sha: string } }).object.sha;
    },
    async createBranch(token, repo, branch, fromSha) {
      const res = await call(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: fromSha });
      if (res.ok) return 'created';
      if (res.status === 422 && /already exists/i.test(await res.clone().text().catch(() => ''))) return 'exists';
      throw writeFailure(res);
    },
    async openPull(token, repo, i) {
      const res = await call(token, 'POST', `/repos/${repo}/pulls`, i);
      if (!res.ok) throw writeFailure(res);
      return toInfo((await res.json()) as { number: number; html_url: string });
    },
    async findOpenPull(token, repo, head, base) {
      const owner = repo.split('/')[0];
      const res = await call(token, 'GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=1`);
      if (!res.ok) throw writeFailure(res);
      const list = (await res.json()) as Array<{ number: number; html_url: string }>;
      return list[0] ? toInfo(list[0]) : null;
    },
    async pull(token, repo, n) {
      const res = await call(token, 'GET', `/repos/${repo}/pulls/${n}`);
      if (!res.ok) throw writeFailure(res);
      const p = (await res.json()) as { mergeable: boolean | null; mergeable_state: string; head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { ref: string } };
      return { mergeable: p.mergeable, mergeable_state: p.mergeable_state, head_sha: p.head.sha, head_ref: p.head.ref, head_repo: p.head.repo?.full_name ?? null, base_ref: p.base.ref };
    },
    async compare(token, repo, base, head) {
      const res = await call(token, 'GET', `/repos/${repo}/compare/${enc(base)}...${enc(head)}?per_page=1`);
      if (!res.ok) throw writeFailure(res);
      const c = (await res.json()) as { ahead_by: number; behind_by: number };
      return { ahead_by: c.ahead_by, behind_by: c.behind_by };
    },
    async files(token, repo, n) {
      const paths: string[] = [];
      let url: string | null = `/repos/${repo}/pulls/${n}/files?per_page=${PER_PAGE}`;
      for (let page = 0; url && page < FILES_CAP / PER_PAGE; page++) {
        const res: Response = await call(token, 'GET', url);
        if (!res.ok) throw writeFailure(res);
        for (const f of (await res.json()) as Array<{ filename: string }>) paths.push(f.filename);
        const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
        // Never send the bearer token to another origin: stop and report the list as incomplete.
        if (next && new URL(next, API).origin !== API) return { paths, complete: false };
        url = next;
      }
      return { paths, complete: url === null && paths.length < FILES_CAP };
    },
    async merge(token, repo, n, i) {
      const res = await call(token, 'PUT', `/repos/${repo}/pulls/${n}/merge`, { sha: i.sha, commit_title: i.title, merge_method: i.method });
      if (res.status === 409) return { merged: false, sha: null };
      if (!res.ok) throw writeFailure(res);
      const body = (await res.json()) as { merged?: boolean; sha?: string };
      return { merged: body.merged !== false, sha: body.sha ?? null };
    },
    async updateBranch(token, repo, n, expectedHeadSha) {
      const res = await call(token, 'PUT', `/repos/${repo}/pulls/${n}/update-branch`, { expected_head_sha: expectedHeadSha });
      if (res.status === 422) return false;
      if (!res.ok) throw writeFailure(res);
      return true;
    },
  };
}
