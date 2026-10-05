import type { Repositories } from '../db/repositories/index.js';
import type { PullRequestInfo } from '../db/repositories/task-pull-requests.js';
import { GithubCiError, type GithubCiClient, type GithubPull } from '../integrations/github-ci.js';
import { ciOf, deployOf, refsIn } from './rules.js';
import { setCiError } from './status.js';

export interface CiSyncDeps {
  repos: Repositories;
  github: GithubCiClient;
  /** last ETag of the pulls list, per project (in memory: a restart costs one full list) */
  etags: Map<string, string>;
  now?: () => Date;
  /** The merge executor (agentic board §10.1), run after the sync's writes — only for a project with automation on. */
  merge?: (projectId: string) => Promise<void>;
}
export type CiSyncResult = { skipped: 'no_repo' | 'not_allowed' } | { pulls: number | null; checked: number };

const MESSAGES: Record<GithubCiError['kind'], (status: number) => string> = {
  auth: () => 'GitHub: o token não tem acesso ao repositório',
  not_found: () => 'GitHub: repositório não encontrado',
  rate_limited: () => 'GitHub: limite de requisições atingido',
  forbidden: () => 'GitHub: sem permissão de escrita',
  not_mergeable: () => 'GitHub: o pull request não pode ser mesclado',
  http: (status) => `GitHub: falha ao consultar (HTTP ${status})`,
};

const NOT_ALLOWED = 'GitHub: a integração do projeto não é do dono do projeto';

const infoOf = (repo: string, p: GithubPull): PullRequestInfo => ({
  repo,
  number: p.number,
  url: p.html_url,
  title: p.title,
  head_ref: p.head.ref,
  head_sha: p.head.sha,
  base_ref: p.base?.ref ?? null,
  state: p.merged_at ? 'merged' : p.state,
  draft: p.draft,
  merged_at: p.merged_at ? new Date(p.merged_at) : null,
  merge_commit_sha: p.merged_at ? p.merge_commit_sha : null,
});

/** Card ids a PR names: a subtask counts for its parent; epics and unknown numbers count for nothing. */
async function cardsNamed(repos: Repositories, projectId: string, key: string, pull: GithubPull): Promise<string[]> {
  const ids = new Set<string>();
  for (const n of refsIn([pull.head.ref, pull.title, pull.body], key)) {
    const t = await repos.tasks.findByRef(projectId, n);
    if (!t || t.type === 'epic') continue;
    ids.add(t.parent_id ?? t.id);
  }
  return [...ids];
}

/** One project's CI sync (spec 2026-09-26 progress-panel §5.5). */
export async function syncProjectCi(deps: CiSyncDeps, projectId: string): Promise<CiSyncResult> {
  const { repos } = deps;
  const setup = (await repos.projectSetup.get(projectId)).data;
  const repo = setup.repo;
  if (!repo?.integration_id || !repo.full_name) {
    setCiError(projectId, null);
    return { skipped: 'no_repo' };
  }
  const [project, integration] = await Promise.all([repos.projects.findById(projectId), repos.integrations.findById(repo.integration_id)]);
  // Two missing owners (legacy or orphaned rows) never match.
  const allowed = !!project && !!integration && integration.provider === 'github' && project.owner_id !== null && integration.owner_id === project.owner_id;
  const token = allowed ? await repos.integrations.getSecret(integration.id) : null;
  if (!project || !token) {
    setCiError(projectId, NOT_ALLOWED); // spec §7: a permission problem is never a silent "no PR"
    return { skipped: 'not_allowed' };
  }

  let result: CiSyncResult;
  try {
    let pulls: number | null = null;
    const page = await deps.github.listPulls(token, repo.full_name, deps.etags.get(projectId) ?? null);
    if (!page.notModified) {
      for (const pull of page.pulls) await repos.taskPullRequests.replaceLinks(projectId, infoOf(repo.full_name, pull), await cardsNamed(repos, projectId, project.key, pull));
      if (page.etag) deps.etags.set(projectId, page.etag);
      pulls = page.pulls.length;
    }
    const seen = new Set<number>();
    // Only the current repo's PRs; merged ones only when there is a deploy to follow.
    const watched = await repos.taskPullRequests.listWatched(projectId, { repo: repo.full_name, includeMerged: !!repo.deploy_workflow }, deps.now?.() ?? new Date());
    for (const w of watched) {
      if (seen.has(w.number)) continue;
      seen.add(w.number);
      if (w.state === 'open') {
        const { state, summary } = ciOf(await deps.github.listRuns(token, w.repo, w.head_sha));
        await repos.taskPullRequests.updateCi(projectId, w.repo, w.number, { ci_state: state, ci_summary: summary });
      } else if (w.merge_commit_sha) {
        const { state, url } = deployOf(await deps.github.listRuns(token, w.repo, w.merge_commit_sha), repo.deploy_workflow);
        await repos.taskPullRequests.updateCi(projectId, w.repo, w.number, { deploy_state: state, deploy_url: url });
      }
    }
    setCiError(projectId, null);
    result = { pulls, checked: seen.size };
  } catch (e) {
    if (e instanceof GithubCiError) setCiError(projectId, MESSAGES[e.kind](e.status));
    throw e;
  }
  // A project that never turned automation on gets nothing more than the sync (spec D3).
  if (setup.automation?.enabled && deps.merge) await deps.merge(projectId);
  return result;
}
