import type { WorkflowRun } from '../ci/rules.js';

const API = 'https://api.github.com';

export class GithubCiError extends Error {
  constructor(
    public kind: 'auth' | 'not_found' | 'rate_limited' | 'http' | 'forbidden' | 'not_mergeable',
    public status: number,
    public resetAt: Date | null = null,
  ) {
    super(`GitHub ${status} (${kind})`);
  }
}

export interface GithubPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
}
export type PullsPage = { notModified: true } | { notModified: false; etag: string | null; pulls: GithubPull[] };

export interface GithubCiClient {
  listPulls(token: string, repo: string, etag: string | null): Promise<PullsPage>;
  listRuns(token: string, repo: string, headSha: string): Promise<WorkflowRun[]>;
}

export function failure(res: Response): GithubCiError {
  if (res.status === 401) return new GithubCiError('auth', 401);
  if (res.status === 404) return new GithubCiError('not_found', 404);
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    return new GithubCiError('rate_limited', res.status, Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null);
  }
  // Secondary rate limit: 403/429 with `retry-after` (seconds) and no `x-ratelimit-remaining: 0`.
  const retryAfter = Number(res.headers.get('retry-after'));
  if ((res.status === 403 || res.status === 429) && res.headers.has('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new GithubCiError('rate_limited', res.status, new Date(Date.now() + retryAfter * 1000));
  }
  if (res.status === 403) return new GithubCiError('auth', 403);
  return new GithubCiError('http', res.status);
}

/** Pulls and Actions runs for the CI panel (spec 2026-09-26 progress-panel §5.3). The token is only ever a header. */
export function createGithubCiClient(fetchImpl: typeof fetch = fetch): GithubCiClient {
  const get = (token: string, path: string, etag: string | null = null) =>
    fetchImpl(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'termhub',
        'x-github-api-version': '2022-11-28',
        ...(etag ? { 'if-none-match': etag } : {}),
      },
    });

  return {
    async listPulls(token, repo, etag) {
      const res = await get(token, `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`, etag);
      if (res.status === 304) return { notModified: true };
      if (!res.ok) throw failure(res);
      return { notModified: false, etag: res.headers.get('etag'), pulls: (await res.json()) as GithubPull[] };
    },
    async listRuns(token, repo, headSha) {
      const res = await get(token, `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=50`);
      if (!res.ok) throw failure(res);
      const body = (await res.json()) as { workflow_runs: WorkflowRun[] };
      return body.workflow_runs.map(({ id, name, path, status, conclusion, html_url, created_at }) => ({ id, name, path, status, conclusion, html_url, created_at }));
    },
  };
}
