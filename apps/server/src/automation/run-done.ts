import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { AutomationRunRepo } from '../db/repositories/automation-run-repos.js';
import type { TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import { GithubCiError } from '../integrations/github-ci.js';
import { createGithubWriteClient, type GithubWriteClient } from '../integrations/github-write.js';
import { sameRepo } from '../setup/schema.js';
import { githubAccess } from './github-access.js';
import { loadRepoEntries } from './repo-entry.js';

/*
 * When a run with several repositories is done (spec 2026-10-07 multi-repo R14, outline Task 13): every
 * repository whose branch is ahead of its base on GitHub has an open PR from it. A repository with no commit
 * ahead (or whose branch was never pushed) needs no PR: the agent only read it. A run in one repository never
 * comes here: it keeps the single-PR rule of the follower.
 */

/** A PR of the run, in one of its repositories. */
export interface RunPr {
  url: string;
  number: number;
  merged: boolean;
  repo: string;
}

/** `pr_open` and `no_changes` are final; `missing` = commits ahead and no PR; `unknown` = GitHub could not tell. */
export type RepoVerdictState = 'pr_open' | 'no_changes' | 'missing' | 'unknown';

export interface RepoVerdict {
  repository_id: string;
  /** the repository's key in the project (the run's folder `<worktree>/<key>`); null when discovery has none */
  key: string | null;
  /** owner/repo; null when the repository row is gone */
  full_name: string | null;
  state: RepoVerdictState;
  pr?: RunPr;
}

export interface DoneVerdict {
  done: boolean;
  /** the PRs found, in the run's repository order */
  prs: RunPr[];
  repos: RepoVerdict[];
}

let defaultGh: GithubWriteClient | null = null;
/** The real GitHub client, made once on first use (tests pass their own). */
export const githubClient = (): GithubWriteClient => (defaultGh ??= createGithubWriteClient());

/** The repositories a run still works on: its `automation_run_repos` rows not `removed`. A fake without the table has none. */
export async function liveRunRepos(repos: Repositories, runId: string): Promise<AutomationRunRepo[]> {
  if (!repos.automationRunRepos) return [];
  return (await repos.automationRunRepos.listByRun(runId)).filter((r) => r.state !== 'removed');
}

/** A PR linked to the card counts for the run while open, or once merged after the run began (final review I2). */
export const prOfRun = (run: Pick<AutomationRun, 'created_at'>, p: Pick<TaskPullRequest, 'state' | 'merged_at'>): boolean =>
  p.state === 'open' || (p.state === 'merged' && p.merged_at !== null && p.merged_at.getTime() >= run.created_at.getTime());

/**
 * The verdict of a run with several repositories: one line per row, from what the CI sync linked to the card
 * (`linked`, already filtered to the run's branch and `prOfRun`), else from GitHub — an open PR from the branch
 * the sync has not linked yet, else how far the branch is ahead of its base. Never throws for one repository:
 * a GitHub error leaves that line `unknown`, and the run not done.
 */
export async function multiRepoVerdict(
  repos: Repositories,
  run: Pick<AutomationRun, 'project_id' | 'created_at'>,
  rows: readonly AutomationRunRepo[],
  linked: readonly TaskPullRequest[],
  gh: GithubWriteClient,
): Promise<DoneVerdict> {
  const project = await repos.projects.findById(run.project_id);
  const setup = (await repos.projectSetup.get(run.project_id)).data;
  const known = repos.projectRepositories ? await repos.projectRepositories.listByProject(run.project_id) : [];
  const entries = await loadRepoEntries(repos, run.project_id, setup);
  const out: RepoVerdict[] = [];
  for (const row of rows) {
    const full_name = known.find((k) => k.id === row.repository_id)?.full_name ?? null;
    const entry = full_name ? (entries.find((e) => sameRepo(e.full_name, full_name)) ?? null) : null;
    const line = { repository_id: row.repository_id, key: entry?.key ?? null, full_name };
    const pr = full_name ? linked.find((p) => p.head_ref === row.branch && sameRepo(p.repo, full_name)) : undefined;
    if (pr) {
      out.push({ ...line, state: 'pr_open', pr: { url: pr.url, number: pr.number, merged: pr.state === 'merged', repo: pr.repo } });
      continue;
    }
    const access = project && entry ? await githubAccess(repos, project, setup, entry).catch(() => null) : null;
    if (!access) {
      out.push({ ...line, state: 'unknown' });
      continue;
    }
    out.push({ ...line, ...(await fromGithub(gh, access, row)) });
  }
  const prs = out.flatMap((r) => (r.pr ? [r.pr] : []));
  return { done: out.every((r) => r.state === 'pr_open' || r.state === 'no_changes'), prs, repos: out };
}

/** One repository read on GitHub: an open PR from the branch, else whether the branch has commits ahead of its base. */
async function fromGithub(gh: GithubWriteClient, access: { token: string; repo: string }, row: AutomationRunRepo): Promise<Pick<RepoVerdict, 'state' | 'pr'>> {
  try {
    const open = await gh.findOpenPull(access.token, access.repo, row.branch, row.base);
    if (open) return { state: 'pr_open', pr: { url: open.url, number: open.number, merged: false, repo: access.repo } };
    const { ahead_by } = await gh.compare(access.token, access.repo, row.base, row.branch);
    return { state: ahead_by > 0 ? 'missing' : 'no_changes' };
  } catch (e) {
    // the branch was never pushed: nothing of the run is on GitHub in this repository
    if (e instanceof GithubCiError && e.kind === 'not_found') return { state: 'no_changes' };
    return { state: 'unknown' };
  }
}

/** The repositories a verdict lists in one state, by key (else owner/repo), for the agent's answer. */
export const reposIn = (v: DoneVerdict, state: RepoVerdictState): string[] => v.repos.filter((r) => r.state === state).map((r) => r.key ?? r.full_name ?? r.repository_id);

/** Writes the final state of each repository of a done run (`ready → pr_open | no_changes`). Never throws. */
export async function settleRunRepos(repos: Repositories, runId: string, v: DoneVerdict): Promise<void> {
  if (!repos.automationRunRepos) return;
  for (const r of v.repos) {
    if (r.state !== 'pr_open' && r.state !== 'no_changes') continue;
    await repos.automationRunRepos.setState(runId, r.repository_id, r.state).catch(() => {});
  }
}
