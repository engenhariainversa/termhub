import { epicBranchName } from '../automation/branches.js';
import { adoptBlockedRuns } from '../automation/follower.js';
import { deliveryPending, deliveryRow, followMerged } from '../automation/release.js';
import type { Repositories } from '../db/repositories/index.js';
import type { PullRequestInfo } from '../db/repositories/task-pull-requests.js';
import { GithubCiError, type GithubCiClient, type GithubPull } from '../integrations/github-ci.js';
import type { GithubHealthReader } from '../integrations/github-status.js';
import { ciOf, refsIn } from './rules.js';
import { setCiError } from './status.js';

export interface CiSyncDeps {
  repos: Repositories;
  github: GithubCiClient;
  /** last ETag of the pulls list, per project (in memory: a restart costs one full list) */
  etags: Map<string, string>;
  now?: () => Date;
  /** The merge executor (agentic board §10.1), run after the sync's writes — only for a project with automation on. */
  merge?: (projectId: string) => Promise<void>;
  /** githubstatus.com, so a deploy that failed during an Actions incident is run again (TER-1025). */
  githubHealth?: GithubHealthReader;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
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

/** The epic's own branch under the pattern, or null when the pattern cannot give one for it. */
function ownEpicBranch(pattern: string, epic: { ref: string; title: string }): string | null {
  try {
    return epicBranchName(pattern, epic);
  } catch {
    return null;
  }
}

/**
 * Card ids a PR names: a subtask counts for its parent; epics and unknown numbers count for nothing. One
 * exception, only where automation is on (`epicPattern`): a PR whose head is an automatic epic's own branch
 * is that epic's PR (agentic board §10.2) and is linked to the epic alone, so the merge executor sees it.
 */
async function cardsNamed(repos: Repositories, projectId: string, key: string, pull: GithubPull, epicPattern: string | null): Promise<string[]> {
  const refs = refsIn([pull.head.ref, pull.title, pull.body], key);
  if (epicPattern) {
    for (const n of refsIn([pull.head.ref], key)) {
      const t = await repos.tasks.findByRef(projectId, n);
      if (t?.type === 'epic' && t.auto && ownEpicBranch(epicPattern, t) === pull.head.ref) return [t.id];
    }
  }
  const ids = new Set<string>();
  for (const n of refs) {
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
    const epicPattern = setup.automation?.enabled ? (setup.automation.epic_branch_pattern ?? null) : null;
    const page = await deps.github.listPulls(token, repo.full_name, deps.etags.get(projectId) ?? null);
    if (!page.notModified) {
      for (const pull of page.pulls) await repos.taskPullRequests.replaceLinks(projectId, infoOf(repo.full_name, pull), await cardsNamed(repos, projectId, project.key, pull, epicPattern));
      if (page.etag) deps.etags.set(projectId, page.etag);
      pulls = page.pulls.length;
    }
    // a PR from the branch of a run that ended blocked takes that run over (TER-1049)
    if (setup.automation?.enabled) await adoptBlockedRuns(repos, projectId, deps.log, deps.now?.() ?? new Date());
    const seen = new Set<number>();
    // Only the current repo's PRs; merged ones only when there is a deploy or a release to follow.
    const releases = !!setup.automation?.enabled && setup.automation.release_workflows.length > 0;
    const watched = await repos.taskPullRequests.listWatched(projectId, { repo: repo.full_name, includeMerged: !!repo.deploy_workflow || releases, releases }, deps.now?.() ?? new Date());
    for (const first of watched) {
      if (seen.has(first.number)) continue;
      seen.add(first.number);
      // a merged PR's delivery is told on the card whose run made it, not on one it only cites (TER-1004)
      const w = first.state === 'open' || !setup.automation?.enabled ? first : await deliveryRow(repos, watched.filter((r) => r.number === first.number));
      if (w.state === 'open') {
        const { state, summary } = ciOf(await deps.github.listRuns(token, w.repo, w.head_sha));
        await repos.taskPullRequests.updateCi(projectId, w.repo, w.number, { ci_state: state, ci_summary: summary });
      } else if (w.merge_commit_sha && deliveryPending(setup, w)) {
        await followMerged({ repos, github: deps.github, githubHealth: deps.githubHealth, now: deps.now, log: deps.log }, { projectId, ownerId: project.owner_id, token, repo: w.repo, setup }, w);
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
