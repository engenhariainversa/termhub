import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { GithubCiClient, GithubPull } from '../integrations/github-ci.js';
import { GithubCiError } from '../integrations/github-ci.js';
import { ciErrorOf } from './status.js';
import { syncProjectCi } from './sync.js';

const pull = (over: Partial<GithubPull> = {}): GithubPull => ({
  number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'Painel TER-2', body: 'Also TER-3 and TER-1 and TER-99', state: 'open', draft: false,
  merged_at: null, merge_commit_sha: null, head: { ref: 'TER-2-panel', sha: 'abc' }, base: { ref: 'epic/TER-1-x' }, ...over,
});
const cards: Record<number, { id: string; type: string; parent_id: string | null; auto?: boolean; ref?: string; title?: string }> = {
  1: { id: 'epic', type: 'epic', parent_id: null },
  2: { id: 'card2', type: 'story', parent_id: null },
  3: { id: 'sub3', type: 'subtask', parent_id: 'card2' },
  4: { id: 'epic4', type: 'epic', parent_id: null, auto: true, ref: 'TER-4', title: 'Big epic' },
  5: { id: 'epic5', type: 'epic', parent_id: null, auto: false, ref: 'TER-5', title: 'Manual epic' },
};

function setup(over: { integrationOwner?: string | null; projectOwner?: string | null; provider?: string; repo?: object | null; automation?: object } = {}) {
  const replaceLinks = vi.fn(async () => {});
  const updateCi = vi.fn(async () => {});
  const listWatched = vi.fn(async () => [] as unknown[]);
  const repos = {
    projectSetup: { get: vi.fn(async () => ({ data: { repo: over.repo === undefined ? { integration_id: 'i1', full_name: 'acme/app', deploy_workflow: 'deploy.yml' } : over.repo, automation: { enabled: false, release_workflows: [], ...over.automation } } })) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', key: 'TER', owner_id: over.projectOwner === undefined ? 'u1' : over.projectOwner })) },
    integrations: {
      findById: vi.fn(async () => ({ id: 'i1', provider: over.provider ?? 'github', owner_id: over.integrationOwner === undefined ? 'u1' : over.integrationOwner })),
      getSecret: vi.fn(async () => 'tok'),
    },
    tasks: { findByRef: vi.fn(async (_p: string, n: number) => cards[n]) },
    taskPullRequests: { replaceLinks, updateCi, listWatched },
  } as unknown as Repositories;
  const github: GithubCiClient = {
    listPulls: vi.fn(async () => ({ notModified: false as const, etag: 'e2', pulls: [pull()] })),
    listRuns: vi.fn(async () => [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'failure', html_url: 'r', created_at: '2026-09-27T12:00:00Z' }]),
  };
  const etags = new Map<string, string>();
  return { deps: { repos, github, etags, now: () => new Date('2026-09-27T12:00:00Z') }, replaceLinks, updateCi, listWatched, github, etags };
}

beforeEach(() => vi.clearAllMocks());

describe('syncProjectCi', () => {
  it('links the PR to the cards it names, a subtask to its parent, never an epic or a missing number', async () => {
    const { deps, replaceLinks, etags } = setup();
    expect(await syncProjectCi(deps, 'p1')).toEqual({ pulls: 1, checked: 0 });
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ repo: 'acme/app', number: 7, state: 'open', head_sha: 'abc' }), ['card2']);
    expect(etags.get('p1')).toBe('e2');
  });

  it('stores the PR base branch', async () => {
    const { deps, replaceLinks } = setup();
    await syncProjectCi(deps, 'p1');
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ base_ref: 'epic/TER-1-x' }), ['card2']);
  });

  // Agentic board §10.2: the epic PR (head = an automatic epic's own branch) is linked to that epic alone.
  it('with automation on, links a PR from an automatic epic\'s own branch to that epic only', async () => {
    const { deps, replaceLinks, github } = setup({ automation: { enabled: true, epic_branch_pattern: 'epic/{ref}-{slug}' } });
    const epicPull = pull({ title: 'TER-4: integrate epic/TER-4-big-epic', body: 'Part of TER-4\n- TER-2 Painel (#6)', head: { ref: 'epic/TER-4-big-epic', sha: 'e' }, base: { ref: 'main' } });
    vi.mocked(github.listPulls).mockResolvedValue({ notModified: false, etag: null, pulls: [epicPull] });
    await syncProjectCi(deps, 'p1');
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ head_ref: 'epic/TER-4-big-epic', base_ref: 'main' }), ['epic4']);
  });

  it('with automation off, links exactly as before: an epic PR naming only the epic is on no card, and card refs in a PR still link the cards', async () => {
    const { deps, replaceLinks, github } = setup();
    const epicPull = pull({ number: 9, title: 'TER-4: integrate epic/TER-4-big-epic', body: 'Part of TER-4.\n\nCard PRs merged into the epic branch: #6, #7.', head: { ref: 'epic/TER-4-big-epic', sha: 'e' }, base: { ref: 'main' } });
    vi.mocked(github.listPulls).mockResolvedValue({ notModified: false, etag: null, pulls: [epicPull, pull()] });
    await syncProjectCi(deps, 'p1');
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ number: 9 }), []);
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ number: 7 }), ['card2']);
  });

  it('never links an epic otherwise: automation off, a manual epic, or a head that is not the epic\'s own branch', async () => {
    const on = { enabled: true, epic_branch_pattern: 'epic/{ref}-{slug}' };
    const cases = [
      { automation: { enabled: false, epic_branch_pattern: 'epic/{ref}-{slug}' }, head: 'epic/TER-4-big-epic' },
      { automation: on, head: 'epic/TER-5-manual-epic' },
      { automation: on, head: 'TER-4-big-epic-fix' },
    ];
    for (const c of cases) {
      const { deps, replaceLinks, github } = setup({ automation: c.automation });
      vi.mocked(github.listPulls).mockResolvedValue({ notModified: false, etag: null, pulls: [pull({ title: 'x', body: 'TER-2', head: { ref: c.head, sha: 'e' } })] });
      await syncProjectCi(deps, 'p1');
      expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ head_ref: c.head }), ['card2']);
    }
  });

  it('calls replaceLinks with no cards when the PR names none, so old links go', async () => {
    const { deps, replaceLinks, github } = setup();
    vi.mocked(github.listPulls).mockResolvedValue({ notModified: false, etag: null, pulls: [pull({ title: 'x', body: null, head: { ref: 'main-fix', sha: 'z' } })] });
    await syncProjectCi(deps, 'p1');
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ number: 7 }), []);
  });

  it('maps a merged PR', async () => {
    const { deps, replaceLinks, github } = setup();
    vi.mocked(github.listPulls).mockResolvedValue({ notModified: false, etag: null, pulls: [pull({ state: 'closed', merged_at: '2026-09-27T11:00:00Z', merge_commit_sha: 'm' })] });
    await syncProjectCi(deps, 'p1');
    expect(replaceLinks).toHaveBeenCalledWith('p1', expect.objectContaining({ state: 'merged', merge_commit_sha: 'm', merged_at: new Date('2026-09-27T11:00:00Z') }), ['card2']);
  });

  it('refreshes CI of open watched PRs and deploy of merged ones, once per PR, even when the list is not modified', async () => {
    const { deps, updateCi, listWatched, github } = setup();
    vi.mocked(github.listPulls).mockResolvedValue({ notModified: true });
    listWatched.mockResolvedValue([
      { repo: 'acme/app', number: 7, state: 'open', head_sha: 'abc', merge_commit_sha: null },
      { repo: 'acme/app', number: 7, state: 'open', head_sha: 'abc', merge_commit_sha: null },
      { repo: 'acme/app', number: 5, state: 'merged', head_sha: 'old', merge_commit_sha: 'm5' },
    ]);
    expect(await syncProjectCi(deps, 'p1')).toEqual({ pulls: null, checked: 2 });
    expect(updateCi).toHaveBeenCalledWith('p1', 'acme/app', 7, { ci_state: 'failed', ci_summary: { total: 1, passed: 0, failed: 1, running: 0, failing: ['CI'] } });
    expect(updateCi).toHaveBeenCalledWith('p1', 'acme/app', 5, { deploy_state: 'none', deploy_url: null });
    expect(github.listRuns).toHaveBeenCalledWith('tok', 'acme/app', 'm5');
  });

  // Agentic board D22: a merged PR is also watched for the release workflows, only with automation on.
  it('with automation on, follows the release workflows of a merged release-level PR and keeps watching a finished deploy', async () => {
    const { deps, updateCi, listWatched, github } = setup({ automation: { enabled: true, release_workflows: ['publish-agent.yml'] } });
    (deps.repos as unknown as { tasks: Record<string, unknown> }).tasks.findById = vi.fn(async () => ({ id: 't1', auto: false }));
    listWatched.mockResolvedValue([{ repo: 'acme/app', number: 5, state: 'merged', head_sha: 'old', merge_commit_sha: 'm5', base_ref: 'main', task_id: 't1', deploy_state: 'passed', release_runs: [], changed_level: 'release' }]);
    vi.mocked(github.listRuns).mockResolvedValue([{ id: 9, name: 'Publish', path: '.github/workflows/publish-agent.yml', status: 'in_progress', conclusion: null, html_url: 'r9', created_at: '2026-09-27T12:00:00Z' }]);
    Object.assign(github, { fileAt: vi.fn(async () => null) });
    await syncProjectCi(deps, 'p1');
    expect(listWatched).toHaveBeenCalledWith('p1', { repo: 'acme/app', includeMerged: true, releases: true }, expect.any(Date));
    expect(updateCi).toHaveBeenCalledWith('p1', 'acme/app', 5, {
      deploy_state: 'none',
      deploy_url: null,
      release_runs: [{ workflow: 'publish-agent.yml', state: 'running', url: 'r9', version: null }],
    });
  });

  it('with automation off, never reads release workflows', async () => {
    const { deps, listWatched } = setup({ automation: { release_workflows: ['publish-agent.yml'] } });
    await syncProjectCi(deps, 'p1');
    expect(listWatched).toHaveBeenCalledWith('p1', expect.objectContaining({ releases: false }), expect.any(Date));
  });

  it('skips a project without repo, and one whose integration is not the owner’s GitHub', async () => {
    expect(await syncProjectCi(setup({ repo: null }).deps, 'p1')).toEqual({ skipped: 'no_repo' });
    expect(await syncProjectCi(setup({ integrationOwner: 'u2' }).deps, 'p1')).toEqual({ skipped: 'not_allowed' });
    expect(await syncProjectCi(setup({ provider: 'linear' }).deps, 'p1')).toEqual({ skipped: 'not_allowed' });
  });

  it('watches only the current repo, and merged PRs only when a deploy workflow is set', async () => {
    const withDeploy = setup();
    await syncProjectCi(withDeploy.deps, 'p1');
    expect(withDeploy.listWatched).toHaveBeenCalledWith('p1', { repo: 'acme/app', includeMerged: true, releases: false }, new Date('2026-09-27T12:00:00Z'));
    const noDeploy = setup({ repo: { integration_id: 'i1', full_name: 'acme/new', deploy_workflow: null } });
    await syncProjectCi(noDeploy.deps, 'p1');
    expect(noDeploy.listWatched).toHaveBeenCalledWith('p1', { repo: 'acme/new', includeMerged: false, releases: false }, new Date('2026-09-27T12:00:00Z'));
  });

  it('never matches two missing owners', async () => {
    expect(await syncProjectCi(setup({ projectOwner: null, integrationOwner: null }).deps, 'p1')).toEqual({ skipped: 'not_allowed' });
  });

  it('says why nothing shows when not allowed, and clears the error once the repo is removed', async () => {
    await syncProjectCi(setup({ integrationOwner: 'u2' }).deps, 'p1');
    expect(ciErrorOf('p1')).toBe('GitHub: a integração do projeto não é do dono do projeto');
    await syncProjectCi(setup({ repo: null }).deps, 'p1');
    expect(ciErrorOf('p1')).toBeNull();
  });

  it('records a GitHub failure for the panel, keeps the links, and clears it after a good sync', async () => {
    const { deps, replaceLinks, github } = setup();
    vi.mocked(github.listPulls).mockRejectedValueOnce(new GithubCiError('auth', 401));
    await expect(syncProjectCi(deps, 'p1')).rejects.toBeInstanceOf(GithubCiError);
    expect(ciErrorOf('p1')).toBe('GitHub: o token não tem acesso ao repositório');
    expect(replaceLinks).not.toHaveBeenCalled();
    await syncProjectCi(deps, 'p1');
    expect(ciErrorOf('p1')).toBeNull();
  });

  // Agentic board §10.1 and Review Focus 5: the merge executor runs after the sync's writes, and only where
  // the project turned automation on.
  it('a project with automation off never calls the merge executor', async () => {
    const { deps } = setup();
    const merge = vi.fn(async () => {});
    await syncProjectCi({ ...deps, merge }, 'p1');
    expect(merge).not.toHaveBeenCalled();
  });

  it('a project with automation on runs the merge executor after the CI writes', async () => {
    const { deps, updateCi, listWatched } = setup({ automation: { enabled: true } });
    listWatched.mockResolvedValue([{ repo: 'acme/app', number: 7, state: 'open', head_sha: 'abc', merge_commit_sha: null }]);
    const merge = vi.fn(async () => {});
    await syncProjectCi({ ...deps, merge }, 'p1');
    expect(merge).toHaveBeenCalledWith('p1');
    expect(updateCi.mock.invocationCallOrder[0]).toBeLessThan(merge.mock.invocationCallOrder[0]!);
  });

  it('a failed sync does not run the merge executor', async () => {
    const { deps, github } = setup({ automation: { enabled: true } });
    vi.mocked(github.listPulls).mockRejectedValueOnce(new GithubCiError('auth', 401));
    const merge = vi.fn(async () => {});
    await expect(syncProjectCi({ ...deps, merge }, 'p1')).rejects.toBeInstanceOf(GithubCiError);
    expect(merge).not.toHaveBeenCalled();
  });
});
