import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRunRepo } from '../db/repositories/automation-run-repos.js';
import type { TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import { GithubCiError } from '../integrations/github-ci.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { multiRepoVerdict, reposIn, settleRunRepos } from './run-done.js';

/** A project with two discovered repositories, `front` and `api`, both readable with the integration `i1`. */
function twoRepoWorld(o: { access?: boolean } = {}) {
  const repos = {
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    projectSetup: { get: vi.fn(async () => ({ data: { repo: { full_name: 'acme/front', integration_id: 'i1', base_branch: 'main', branch_pattern: '{ref}-{slug}', require_ticket: false } } })) },
    projectRepositories: {
      listByProject: vi.fn(async () => [
        { id: 'r-front', project_id: 'p1', key: 'front', full_name: 'acme/front', status: 'ok', description: null, checkouts: [] },
        { id: 'r-api', project_id: 'p1', key: 'api', full_name: 'acme/api', status: 'ok', description: null, checkouts: [] },
      ]),
    },
    integrations: {
      findById: vi.fn(async () => (o.access === false ? undefined : { id: 'i1', provider: 'github', owner_id: 'u1' })),
      getSecret: vi.fn(async () => 'tok'),
    },
    automationRunRepos: { setState: vi.fn(async () => {}) },
  } as unknown as Repositories;
  return { repos };
}

const row = (repository_id: string, key: string): AutomationRunRepo => ({ run_id: 'run1', repository_id, branch: 'TER-1-x', base: 'main', worktree_path: `/w/p1/TER-1/${key}`, state: 'ready', created_at: new Date() });
const ROWS = [row('r-front', 'front'), row('r-api', 'api')];
const RUN = { project_id: 'p1', created_at: new Date('2026-11-16T10:00:00.000Z') };
const linkedPr = (repo: string, number: number) => ({ repo, number, url: `https://github.com/${repo}/pull/${number}`, head_ref: 'TER-1-x', state: 'open', merged_at: null }) as unknown as TaskPullRequest;

/** GitHub: per repository, an open PR from the branch (or none) and how far the branch is ahead (or a 404). */
function github(per: Record<string, { open?: number; ahead?: number | 'missing' | 'error' }>) {
  return {
    findOpenPull: vi.fn(async (_t: string, repo: string) => (per[repo]?.open ? { number: per[repo].open, url: `https://github.com/${repo}/pull/${per[repo].open}` } : null)),
    compare: vi.fn(async (_t: string, repo: string) => {
      const a = per[repo]?.ahead ?? 0;
      if (a === 'missing') throw new GithubCiError('not_found', 404);
      if (a === 'error') throw new GithubCiError('http', 502);
      return { ahead_by: a, behind_by: 0 };
    }),
  } as unknown as GithubWriteClient;
}

describe('the done rule of a run with several repositories (spec 2026-10-07 multi-repo R14)', () => {
  it('two repositories with one PR missing: not done, and the missing one is named', async () => {
    const { repos } = twoRepoWorld();
    const v = await multiRepoVerdict(repos, RUN, ROWS, [linkedPr('acme/front', 7)], github({ 'acme/api': { ahead: 2 } }));
    expect(v.done).toBe(false);
    expect(v.repos.map((r) => [r.key, r.state])).toEqual([['front', 'pr_open'], ['api', 'missing']]);
    expect(reposIn(v, 'missing')).toEqual(['api']);
  });

  it('a repository with no commits ahead needs no PR: done, that one no_changes', async () => {
    const { repos } = twoRepoWorld();
    const v = await multiRepoVerdict(repos, RUN, ROWS, [linkedPr('acme/front', 7)], github({ 'acme/api': { ahead: 0 } }));
    expect(v.done).toBe(true);
    expect(v.prs.map((p) => p.number)).toEqual([7]);
    expect(v.repos.map((r) => r.state)).toEqual(['pr_open', 'no_changes']);
  });

  it('a branch never pushed to a repository counts as no changes', async () => {
    const { repos } = twoRepoWorld();
    const v = await multiRepoVerdict(repos, RUN, ROWS, [linkedPr('acme/front', 7)], github({ 'acme/api': { ahead: 'missing' } }));
    expect(v.done).toBe(true);
    expect(v.repos[1]!.state).toBe('no_changes');
  });

  it('an open PR the CI sync has not linked yet counts, read from GitHub', async () => {
    const { repos } = twoRepoWorld();
    const v = await multiRepoVerdict(repos, RUN, ROWS, [linkedPr('acme/front', 7)], github({ 'acme/api': { open: 3, ahead: 2 } }));
    expect(v.done).toBe(true);
    expect(v.prs.map((p) => p.url)).toEqual(['https://github.com/acme/front/pull/7', 'https://github.com/acme/api/pull/3']);
  });

  it('a PR of the same branch name linked from another repository is not this repository\'s', async () => {
    const { repos } = twoRepoWorld();
    const v = await multiRepoVerdict(repos, RUN, ROWS, [linkedPr('acme/front', 7), linkedPr('acme/other', 9)], github({ 'acme/api': { ahead: 1 } }));
    expect(v.done).toBe(false);
  });

  it('GitHub errors and missing access leave the repository unknown, and the run not done', async () => {
    const failing = await multiRepoVerdict(twoRepoWorld().repos, RUN, ROWS, [linkedPr('acme/front', 7)], github({ 'acme/api': { ahead: 'error' } }));
    expect(failing.done).toBe(false);
    expect(reposIn(failing, 'unknown')).toEqual(['api']);
    const gh = github({});
    const noAccess = await multiRepoVerdict(twoRepoWorld({ access: false }).repos, RUN, ROWS, [linkedPr('acme/front', 7)], gh);
    expect(noAccess.repos.map((r) => r.state)).toEqual(['pr_open', 'unknown']);
    expect(gh.compare).not.toHaveBeenCalled();
  });

  it('settles the final state of every repository of a done run', async () => {
    const { repos } = twoRepoWorld();
    const v = await multiRepoVerdict(repos, RUN, ROWS, [linkedPr('acme/front', 7)], github({}));
    await settleRunRepos(repos, 'run1', v);
    expect(repos.automationRunRepos.setState).toHaveBeenCalledWith('run1', 'r-front', 'pr_open');
    expect(repos.automationRunRepos.setState).toHaveBeenCalledWith('run1', 'r-api', 'no_changes');
  });
});
