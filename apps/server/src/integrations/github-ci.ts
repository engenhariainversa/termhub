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
  base: { ref: string };
}
export type PullsPage = { notModified: true } | { notModified: false; etag: string | null; pulls: GithubPull[] };

export interface GithubCiClient {
  listPulls(token: string, repo: string, etag: string | null): Promise<PullsPage>;
  listRuns(token: string, repo: string, headSha: string): Promise<WorkflowRun[]>;
  /** The head commit of a branch; null when the branch is gone. */
  branchSha(token: string, repo: string, branch: string): Promise<string | null>;
  /** Whether `ancestor` is part of `descendant`'s history (or the same commit). */
  isAncestor(token: string, repo: string, ancestor: string, descendant: string): Promise<boolean>;
  /** The paths a PR changed (first 100 files: enough to find the package a release publishes). */
  prFiles(token: string, repo: string, number: number): Promise<string[]>;
  /** A text file at a commit; null when it does not exist there. */
  fileAt(token: string, repo: string, path: string, ref: string): Promise<string | null>;
  /** The jobs of a run's latest attempt, with their steps (TER-1025: a deploy that failed with no failed step is GitHub's). */
  runJobs(token: string, repo: string, runId: number): Promise<RunJob[]>;
  /** Runs a whole workflow run again, on the same commit (TER-1025: a deploy that failed on GitHub's side). */
  rerunRun(token: string, repo: string, runId: number): Promise<void>;
}

/** A job of a workflow run and how its steps ended. */
export interface RunJob {
  name: string;
  status: string;
  conclusion: string | null;
  steps: Array<{ name: string; conclusion: string | null }>;
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

  const post = (token: string, path: string) =>
    fetchImpl(`${API}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'termhub', 'x-github-api-version': '2022-11-28' },
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
      return body.workflow_runs.map(({ id, name, path, status, conclusion, html_url, created_at, updated_at }) => ({ id, name, path, status, conclusion, html_url, created_at, updated_at }));
    },
    async branchSha(token, repo, branch) {
      const res = await get(token, `/repos/${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      if (res.status === 404) return null;
      if (!res.ok) throw failure(res);
      return ((await res.json()) as { object: { sha: string } }).object.sha;
    },
    async isAncestor(token, repo, ancestor, descendant) {
      const res = await get(token, `/repos/${repo}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}?per_page=1`);
      if (res.status === 404) return false;
      if (!res.ok) throw failure(res);
      const { status } = (await res.json()) as { status: string };
      return status === 'ahead' || status === 'identical';
    },
    async prFiles(token, repo, number) {
      const res = await get(token, `/repos/${repo}/pulls/${number}/files?per_page=100`);
      if (!res.ok) throw failure(res);
      return ((await res.json()) as Array<{ filename: string }>).map((f) => f.filename);
    },
    async fileAt(token, repo, path, ref) {
      const res = await get(token, `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw failure(res);
      const body = (await res.json()) as { content?: string; encoding?: string };
      return body.encoding === 'base64' && typeof body.content === 'string' ? Buffer.from(body.content, 'base64').toString('utf8') : null;
    },
    async runJobs(token, repo, runId) {
      const res = await get(token, `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
      if (!res.ok) throw failure(res);
      const body = (await res.json()) as { jobs?: Array<{ name: string; status: string; conclusion: string | null; steps?: Array<{ name: string; conclusion: string | null }> }> };
      return (body.jobs ?? []).map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion, steps: (j.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion })) }));
    },
    async rerunRun(token, repo, runId) {
      const res = await post(token, `/repos/${repo}/actions/runs/${runId}/rerun`);
      if (!res.ok) throw failure(res);
    },
  };
}
