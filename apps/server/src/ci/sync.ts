import { epicBranchName } from '../automation/branches.js';
import { adoptBlockedRuns } from '../automation/follower.js';
import { deliveryPending, deliveryRow, followMerged } from '../automation/release.js';
import type { Repositories } from '../db/repositories/index.js';
import type { PullRequestInfo } from '../db/repositories/task-pull-requests.js';
import { GithubCiError, type GithubCiClient, type GithubPull } from '../integrations/github-ci.js';
import type { GithubHealthReader } from '../integrations/github-status.js';
import { githubAccess } from '../automation/merge.js';
import { activeEntries, loadRepoEntries, runEntry } from '../automation/repo-entry.js';
import type { Project } from '../db/repositories/types.js';
import type { EffectiveRepo } from '../setup/repos.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { ciOf, linkedRefsIn, refsIn } from './rules.js';
import { setCiError } from './status.js';

export interface CiSyncDeps {
  repos: Repositories;
  github: GithubCiClient;
  /** last ETag of each repository's pulls list, keyed `ciEtagKey(project, repo)` (in memory: a restart costs one full list) */
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
 *
 * `mentioned` (TER-1136): the cards the PR only cites in passing — named in its title or body but not in its
 * branch nor after a "Depende de"/"Closes" (`linkedRefsIn`). They still show the PR; they never hold its merge.
 */
async function cardsNamed(repos: Repositories, projectId: string, key: string, pull: GithubPull, epicPattern: string | null): Promise<{ ids: string[]; mentioned: string[] }> {
  const refs = refsIn([pull.head.ref, pull.title, pull.body], key);
  if (epicPattern) {
    for (const n of refsIn([pull.head.ref], key)) {
      const t = await repos.tasks.findByRef(projectId, n);
      if (t?.type === 'epic' && t.auto && ownEpicBranch(epicPattern, t) === pull.head.ref) return { ids: [t.id], mentioned: [] };
    }
  }
  const linked = new Set([...refsIn([pull.head.ref], key), ...linkedRefsIn([pull.title, pull.body], key)]);
  const ids = new Set<string>();
  const links = new Set<string>();
  for (const n of refs) {
    const t = await repos.tasks.findByRef(projectId, n);
    if (!t || t.type === 'epic') continue;
    const id = t.parent_id ?? t.id;
    ids.add(id);
    if (linked.has(n)) links.add(id);
  }
  // TER-1110: a PR that names no card (a project whose branches and titles carry the ticket's key, never the
  // termhub ref) is the card's whose automatic run works on its branch; so is one that only cites cards in passing
  if (links.size === 0) {
    const taskId = await repos.automationRuns.taskOfBranch(projectId, pull.head.ref);
    const t = taskId ? await repos.tasks.findById(taskId) : undefined;
    if (t && t.type !== 'epic') {
      ids.add(t.parent_id ?? t.id);
      links.add(t.parent_id ?? t.id);
    }
  }
  return { ids: [...ids], mentioned: [...ids].filter((id) => !links.has(id)) };
}

/** The ETag of one repository's pulls list in a project (spec 2026-10-07 multi-repo R17). */
export const ciEtagKey = (projectId: string, repo: string): string => `${projectId}:${repo.toLowerCase()}`;

type Access = { token: string; repo: string };
type Log = NonNullable<CiSyncDeps['log']>;

/**
 * Which repositories of a project with several get their pulls listed (spec 2026-10-07 multi-repo R17): a
 * repository with a watched PR, or named by a card in doing or an automatic card in todo; the run's
 * repository too for a card that names none and for any active run (the runs work on it, R14).
 */
async function reposInPlay(deps: CiSyncDeps, projectId: string, setup: ProjectSetupData, entries: EffectiveRepo[]): Promise<Set<EffectiveRepo>> {
  const { repos } = deps;
  const now = deps.now?.() ?? new Date();
  const [{ keys, unscoped }, active] = await Promise.all([repos.tasks.repoKeysInPlay(projectId), repos.automationRuns.activeByProject(projectId)]);
  const run = runEntry(entries, setup);
  const out = new Set<EffectiveRepo>();
  for (const e of entries) {
    if ((e.key !== null && keys.includes(e.key)) || (e === run && (unscoped || active.length > 0))) out.add(e);
    else if ((await repos.taskPullRequests.listWatched(projectId, watchOf(setup, e), now)).length > 0) out.add(e);
  }
  return out;
}

/** The PRs of a repository the sync follows: the open ones, and merged ones only when there is a deploy or a release to follow. */
function watchOf(setup: ProjectSetupData, e: EffectiveRepo): { repo: string; includeMerged: boolean; releases: boolean } {
  const releases = !!setup.automation?.enabled && e.release_workflows.length > 0;
  return { repo: e.full_name, includeMerged: !!e.deploy_workflow || releases, releases };
}

/** Lists one repository's pulls (when they changed) and links each to the cards it names. Null: not modified. */
async function linkPulls(deps: CiSyncDeps, project: Project, setup: ProjectSetupData, a: Access): Promise<number | null> {
  const { repos } = deps;
  const epicPattern = setup.automation?.enabled ? (setup.automation.epic_branch_pattern ?? null) : null;
  const key = ciEtagKey(project.id, a.repo);
  const page = await deps.github.listPulls(a.token, a.repo, deps.etags.get(key) ?? null);
  if (page.notModified) return null;
  for (const pull of page.pulls) {
    const { ids, mentioned } = await cardsNamed(repos, project.id, project.key, pull, epicPattern);
    await repos.taskPullRequests.replaceLinks(project.id, infoOf(a.repo, pull), ids, mentioned);
  }
  if (page.etag) deps.etags.set(key, page.etag);
  return page.pulls.length;
}

/** One repository's watched PRs: the open ones' CI, the merged ones' delivery. Returns how many PRs it read. */
async function followRepo(deps: CiSyncDeps, project: Project, setup: ProjectSetupData, e: EffectiveRepo, a: Access): Promise<number> {
  const { repos } = deps;
  const projectId = project.id;
  const seen = new Set<number>();
  const watched = await repos.taskPullRequests.listWatched(projectId, watchOf(setup, e), deps.now?.() ?? new Date());
  for (const first of watched) {
    if (seen.has(first.number)) continue;
    seen.add(first.number);
    // a merged PR's delivery is told on the card whose run made it, not on one it only cites (TER-1004)
    const w = first.state === 'open' || !setup.automation?.enabled ? first : await deliveryRow(repos, setup, watched.filter((r) => r.number === first.number));
    if (w.state === 'open') {
      const { state, summary } = ciOf(await deps.github.listRuns(a.token, w.repo, w.head_sha));
      await repos.taskPullRequests.updateCi(projectId, w.repo, w.number, { ci_state: state, ci_summary: summary });
    } else if (w.merge_commit_sha && deliveryPending(setup, w, e)) {
      await followMerged({ repos, github: deps.github, githubHealth: deps.githubHealth, now: deps.now, log: deps.log }, { projectId, ownerId: project.owner_id, token: a.token, repo: w.repo, setup, entry: e }, w);
    }
  }
  return seen.size;
}

const noLog: Log = { info: () => {}, warn: () => {} };

/**
 * One project's CI sync (spec 2026-09-26 progress-panel §5.5), over each repository the automation works on
 * (spec 2026-10-07 multi-repo R17), with one ETag per repository. A project with one repository syncs it as
 * before. With several, only the repositories in play are listed (`reposInPlay`), and a GitHub error in one
 * of them never holds the others: it is shown in the CI panel and logged. A rate limit stops the pass, and
 * every repository failing fails it as before (no merge pass).
 */
export async function syncProjectCi(deps: CiSyncDeps, projectId: string): Promise<CiSyncResult> {
  const { repos } = deps;
  const setup = (await repos.projectSetup.get(projectId)).data;
  const entries = activeEntries(await loadRepoEntries(repos, projectId, setup)).filter((e) => !!(e.integration_id ?? setup.repo?.integration_id));
  if (entries.length === 0) {
    setCiError(projectId, null);
    return { skipped: 'no_repo' };
  }
  const project = await repos.projects.findById(projectId);
  const access = new Map<EffectiveRepo, Access>();
  if (project) {
    for (const e of entries) {
      const a = await githubAccess(repos, project, setup, e);
      if (a) access.set(e, a);
    }
  }
  if (!project || access.size === 0) {
    setCiError(projectId, NOT_ALLOWED); // spec §7: a permission problem is never a silent "no PR"
    return { skipped: 'not_allowed' };
  }

  const several = entries.length > 1;
  const inPlay = several ? await reposInPlay(deps, projectId, setup, entries) : null;
  const synced = [...access].filter(([e]) => !inPlay || inPlay.has(e));
  const errors: unknown[] = [];
  /** A failing repository: GitHub's reason in the CI panel; a rate limit (or the only repository) stops the pass. */
  const failed = (e: unknown, repo: string) => {
    if (e instanceof GithubCiError) setCiError(projectId, MESSAGES[e.kind](e.status));
    if (!several || (e instanceof GithubCiError && e.kind === 'rate_limited')) throw e;
    errors.push(e);
    (deps.log ?? noLog).warn({ projectId, repo, err: e instanceof Error ? e.message : String(e) }, 'ci sync failed for a repository');
  };

  let pulls: number | null = null;
  let checked = 0;
  const ok = new Set<EffectiveRepo>();
  for (const [e, a] of synced) {
    try {
      const n = await linkPulls(deps, project, setup, a);
      if (n !== null) pulls = (pulls ?? 0) + n;
      ok.add(e);
    } catch (err) {
      failed(err, a.repo);
    }
  }
  // a PR from the branch of a run that ended blocked takes that run over (TER-1049)
  if (setup.automation?.enabled && (ok.size > 0 || synced.length === 0)) await adoptBlockedRuns(repos, projectId, deps.log, deps.now?.() ?? new Date());
  for (const [e, a] of synced) {
    if (!ok.has(e)) continue;
    try {
      checked += await followRepo(deps, project, setup, e, a);
    } catch (err) {
      ok.delete(e);
      failed(err, a.repo);
    }
  }
  if (synced.length > 0 && ok.size === 0) throw errors[0];
  if (errors.length === 0) setCiError(projectId, access.size < entries.length ? NOT_ALLOWED : null);
  const result: CiSyncResult = { pulls, checked };
  // A project that never turned automation on gets nothing more than the sync (spec D3).
  if (setup.automation?.enabled && deps.merge) await deps.merge(projectId);
  return result;
}
