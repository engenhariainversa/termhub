import { controlContextFor } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { CiState, ReleaseRun, TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import { GithubCiError, type GithubCiClient } from '../integrations/github-ci.js';
import { actionsDegraded, type GithubHealthReader } from '../integrations/github-status.js';
import { deployOf, latestPerWorkflow, matchesWorkflow, type WorkflowRun } from '../ci/rules.js';
import { t } from '../i18n/index.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { DEPLOY_FAILED, DEPLOY_FAILED_NOT_PAUSED, RELEASE_FAILED } from './escalation-text.js';
import { claimEvent, publishEvent, recordEvent } from './events.js';
import { postAutomationLine } from './chat-line.js';
import { escalateDelivery } from './follower.js';
import { pauseAutomation } from './pause.js';
import { globMatches } from './policy.js';

/*
 * After a merge (agentic board D22, §10.5): follow the project's deploy workflow and, for a PR that changed
 * release paths, its `automation.release_workflows` on the merge commit. A failed deploy pauses the project
 * and escalates — unless it failed on GitHub's side (TER-1025): then the same run is started again, up to
 * `automation.deploy_retries` times, before the pause. A failed release escalates only. Nothing is rolled
 * back automatically (spike TER-967).
 */

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

export interface DeliveryDeps {
  repos: Repositories;
  /** `runJobs` and `rerunRun` left out: a failed deploy is never run again (it pauses, as before TER-1025). */
  github: Pick<GithubCiClient, 'listRuns' | 'branchSha' | 'isAncestor' | 'fileAt' | 'prFiles'> & Partial<Pick<GithubCiClient, 'runJobs' | 'rerunRun'>>;
  /** githubstatus.com, for an Actions incident; left out, only the run's own jobs say whether GitHub failed. */
  githubHealth?: GithubHealthReader;
  now?: () => Date;
  log?: Log;
}
export interface DeliveryCtx {
  projectId: string;
  ownerId: string | null;
  token: string;
  repo: string;
  setup: ProjectSetupData;
}

const finished = (s: CiState): boolean => s === 'passed' || s === 'failed';

/** Whether the PR's release workflows are followed: automation on, the PR changed a release path (F-31). */
function followsReleases(setup: ProjectSetupData, w: TaskPullRequest): boolean {
  return !!setup.automation?.enabled && w.changed_level === 'release' && setup.automation.release_workflows.length > 0;
}

/** Whether a merged PR still has a delivery run to wait for (its deploy, or one of its release workflows). */
export function deliveryPending(setup: ProjectSetupData, w: TaskPullRequest): boolean {
  if (setup.repo?.deploy_workflow && !finished(w.deploy_state)) return true;
  if (!followsReleases(setup, w)) return false;
  return setup.automation.release_workflows.some((wf) => !finished(w.release_runs.find((r) => r.workflow === wf)?.state ?? 'none'));
}

/**
 * The runs of one workflow for a merge. A run of the merge commit itself that was cancelled was superseded
 * by a newer queued run (cancel-in-progress): the merge's code ships with the newest run of the base branch
 * that contains it, so that one is followed instead (is-ancestor).
 */
function runSource(deps: DeliveryDeps, c: DeliveryCtx, w: TaskPullRequest, followNewer: boolean): (workflow: string) => Promise<WorkflowRun[]> {
  const { github } = deps;
  const sha = w.merge_commit_sha!;
  let atMerge: Promise<WorkflowRun[]> | undefined;
  let atHead: Promise<WorkflowRun[] | null> | undefined;
  const newer = async (): Promise<WorkflowRun[] | null> => {
    if (!w.base_ref) return null;
    const head = await github.branchSha(c.token, c.repo, w.base_ref);
    if (!head || head === sha || !(await github.isAncestor(c.token, c.repo, sha, head))) return null;
    return github.listRuns(c.token, c.repo, head);
  };
  return async (workflow) => {
    const own = (await (atMerge ??= github.listRuns(c.token, c.repo, sha))).filter((r) => matchesWorkflow(r, workflow));
    const latest = latestPerWorkflow(own);
    // a project that never turned automation on keeps the plain deploy lookup (D3)
    if (!followNewer || latest.length === 0 || latest.some((r) => r.conclusion !== 'cancelled')) return own;
    const later = await (atHead ??= newer());
    return later ? later.filter((r) => matchesWorkflow(r, workflow)) : own;
  };
}

/**
 * The `version` of the package a release publishes: the `package.json` files the PR changed under
 * `automation.release_paths` (the first one with a public version), else the root one. Null when none is
 * readable or public.
 */
async function versionAt(deps: DeliveryDeps, c: DeliveryCtx, sha: string, number: number): Promise<string | null> {
  const read = async (path: string): Promise<string | null> => {
    try {
      const text = await deps.github.fileAt(c.token, c.repo, path, sha);
      const pkg = text ? (JSON.parse(text) as { version?: unknown; private?: unknown }) : null;
      return pkg && pkg.private !== true && typeof pkg.version === 'string' ? pkg.version.slice(0, 100) : null;
    } catch {
      return null;
    }
  };
  const changed = await deps.github.prFiles(c.token, c.repo, number).catch(() => [] as string[]);
  const globs = c.setup.automation.release_paths;
  const candidates = changed.filter((f) => f.endsWith('/package.json') && globs.some((g) => globMatches(g, f)));
  for (const path of [...candidates, 'package.json']) {
    const v = await read(path);
    if (v) return v;
  }
  return null;
}

/**
 * Whether the card's automatic runs worked on this branch: the card the PR is about. Any other card the PR
 * cites is only a reference (TER-1004: #394, a person's PR, cited TER-988 and its deploy landed there).
 */
export async function runBranchOf(repos: Repositories, taskId: string, headRef: string): Promise<boolean> {
  return (await repos.automationRuns.branchesOfTask(taskId)).includes(headRef);
}

/** Of a merged PR's rows (one per card it cites), the one of the automatic card that worked on its head; else the first. */
export async function deliveryRow(repos: Repositories, rows: TaskPullRequest[]): Promise<TaskPullRequest> {
  for (const row of rows) {
    if ((await repos.tasks.findById(row.task_id))?.auto && (await runBranchOf(repos, row.task_id, row.head_ref))) return row;
  }
  return rows[0]!;
}

/**
 * One sync pass over a merged PR: reads the deploy and release runs, stores them on the PR's rows, and —
 * for the automatic card whose run made the PR, with automation on — records the result once, on the pass that sees it finish.
 * The stored state is written before the events, so a result is reported at most once.
 */
export async function followMerged(deps: DeliveryDeps, c: DeliveryCtx, w: TaskPullRequest): Promise<void> {
  const { repos } = deps;
  if (!w.merge_commit_sha) return;
  const log = deps.log ?? noopLog;
  const runsOf = runSource(deps, c, w, !!c.setup.automation?.enabled);
  const deployWorkflow = c.setup.repo?.deploy_workflow ?? null;
  const patch: { deploy_state?: CiState; deploy_url?: string | null; release_runs?: ReleaseRun[] } = {};

  const deploy = deployWorkflow ? deployOf(await runsOf(deployWorkflow), deployWorkflow) : null;
  if (deploy) {
    patch.deploy_state = deploy.state;
    patch.deploy_url = deploy.url;
  }

  const releases: Array<ReleaseRun & { previous: CiState }> = [];
  if (followsReleases(c.setup, w)) {
    let version: Promise<string | null> | undefined;
    for (const workflow of c.setup.automation.release_workflows) {
      const { state, url } = deployOf(await runsOf(workflow), workflow);
      const previous = w.release_runs.find((r) => r.workflow === workflow);
      releases.push({ workflow, state, url, version: state === 'passed' ? await (version ??= versionAt(deps, c, w.merge_commit_sha, w.number)) : (previous?.version ?? null), previous: previous?.state ?? 'none' });
    }
    patch.release_runs = releases.map(({ workflow, state, url, version }) => ({ workflow, state, url, version }));
  }
  // only what the automation delivers: the PR of an automatic card's run, in a project with automation on
  const reporting = !!c.setup.automation?.enabled && !!(await repos.tasks.findById(w.task_id))?.auto && (await runBranchOf(repos, w.task_id, w.head_ref));
  const about = { project_id: c.projectId, task_id: w.task_id };
  const ids = { pr: w.number, sha: w.merge_commit_sha };
  const deployDone = reporting && !!deploy && finished(deploy.state) && deploy.state !== w.deploy_state;
  // TER-1025: a deploy that failed on GitHub's side is run again, or waits for its next try; the failed state
  // is not stored meanwhile, so every sync looks at it again and nothing is paused
  const retry = deployDone && deploy?.state === 'failed' && deploy.run ? await retryDeploy(deps, c, w, deploy.run, log) : null;
  if (retry && retry.outcome !== 'give_up') {
    if (retry.outcome === 'retried') patch.deploy_state = 'running';
    else delete patch.deploy_state;
    await repos.taskPullRequests.updateCi(c.projectId, w.repo, w.number, patch);
  } else if (deployDone && deploy?.state === 'failed') {
    // The safety action comes first and the failed state is stored last: if anything here throws, the next
    // sync still sees the deploy as unreported and retries (pausing again is a no-op).
    const payload = { ...ids, url: deploy.url, workflow: deployWorkflow, ...(retry?.attempts ? { attempts: retry.attempts } : {}) };
    const paused = await pauseOnDeployFailure(deps, c).catch((e: unknown) => {
      log.warn({ projectId: c.projectId, err: e instanceof Error ? e.message : String(e) }, 'automation: pause after a failed deploy failed');
      return false;
    });
    await recordEvent(repos, { ...about, kind: 'deploy_failed', payload: { ...payload, paused } });
    await escalateDelivery(repos, about, paused ? DEPLOY_FAILED : DEPLOY_FAILED_NOT_PAUSED, log, payload);
    await repos.taskPullRequests.updateCi(c.projectId, w.repo, w.number, patch);
  } else {
    await repos.taskPullRequests.updateCi(c.projectId, w.repo, w.number, patch);
    if (deployDone && deploy) {
      await recordEvent(repos, { ...about, kind: 'deploy_ok', payload: { ...ids, url: deploy.url, workflow: deployWorkflow } });
      const card = await repos.tasks.findById(w.task_id);
      const epic = card?.epic_id ? await repos.tasks.findById(card.epic_id) : undefined;
      const what = epic?.title ?? card?.ref ?? `#${w.number}`;
      await postAutomationLine(repos, c.projectId, (locale) => t(locale, 'Deploy concluído ({{epic}}): {{url}}', { epic: what, url: deploy.url ?? '' }), log);
    }
  }
  if (!reporting) return;
  for (const r of releases) {
    if (!finished(r.state) || r.state === r.previous) continue;
    const payload = { ...ids, url: r.url, workflow: r.workflow, ...(r.version ? { version: r.version } : {}) };
    if (r.state === 'passed') {
      await recordEvent(repos, { ...about, kind: 'release_ok', payload });
      await postAutomationLine(repos, c.projectId, (locale) => (r.version ? t(locale, 'Publicado {{package}} {{version}}', { package: r.workflow, version: r.version }) : t(locale, 'Publicado {{package}}', { package: r.workflow })), log);
    }
    else {
      await recordEvent(repos, { ...about, kind: 'release_failed', payload });
      await escalateDelivery(repos, about, RELEASE_FAILED, log, payload);
    }
  }
}

/** How long after a deploy failed on GitHub's side each new try waits (TER-1025): the 1st, the 2nd, the 3rd and on. */
export const DEPLOY_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000];

/**
 * Why a failed deploy run is GitHub's and not the code's (TER-1025), or null for a real failure: GitHub
 * never started it (`startup_failure`), it has no job at all (the `deploy` job was never created), none of
 * its jobs has a failed step, or githubstatus.com reports trouble with Actions. A jobs list that cannot be
 * read is a real failure: the person looks at it.
 */
export async function infraCause(deps: DeliveryDeps, c: DeliveryCtx, run: WorkflowRun): Promise<string | null> {
  if (run.conclusion === 'startup_failure') return 'startup_failure';
  const jobs = await deps.github.runJobs?.(c.token, c.repo, run.id).catch(() => null);
  if (jobs && jobs.length === 0) return 'no_jobs';
  if (jobs && !jobs.some((j) => j.steps.some((s) => s.conclusion === 'failure'))) return 'no_failed_step';
  const health = await deps.githubHealth?.().catch(() => null);
  return health && actionsDegraded(health) ? 'github_incident' : null;
}

/** An error GitHub would answer the same way later: a re-run refused for good gives up (the person looks). */
const refusedForGood = (e: unknown) => e instanceof GithubCiError && (e.kind === 'auth' || e.kind === 'forbidden' || e.kind === 'not_found' || (e.kind === 'http' && e.status < 500));

/**
 * A failed deploy of an automatic merge, before the pause (TER-1025): when it failed on GitHub's side
 * (`infraCause`) and tries are left, the same workflow run is started again once its delay passed — the
 * same commit, never a newer one. Each try is claimed (`deploy_retried`, one per card, merge SHA and
 * attempt) before GitHub is asked, so two colours never re-run it twice. `retried`: it runs again; `wait`:
 * not yet (the delay, the other colour, GitHub refusing for now); `give_up`: pause and escalate as before.
 */
async function retryDeploy(deps: DeliveryDeps, c: DeliveryCtx, w: TaskPullRequest, run: WorkflowRun, log: Log): Promise<{ outcome: 'retried' | 'wait' | 'give_up'; attempts: number }> {
  const { repos } = deps;
  const max = c.setup.automation.deploy_retries ?? 0;
  if (!deps.github.rerunRun || max === 0) return { outcome: 'give_up', attempts: 0 };
  const sha = w.merge_commit_sha!;
  const done = await repos.automationEvents.countForTask(w.task_id, 'deploy_retried', { sha });
  if (done >= max) return { outcome: 'give_up', attempts: done };
  const cause = await infraCause(deps, c, run);
  if (!cause) return { outcome: 'give_up', attempts: done };
  const delay = DEPLOY_RETRY_DELAYS_MS[Math.min(done, DEPLOY_RETRY_DELAYS_MS.length - 1)]!;
  const failedAt = Date.parse(run.updated_at ?? run.created_at);
  if ((deps.now?.() ?? new Date()).getTime() - failedAt < delay) return { outcome: 'wait', attempts: done };
  const attempt = done + 1;
  const claim = await claimEvent(repos, { project_id: c.projectId, task_id: w.task_id, kind: 'deploy_retried', payload: { pr: w.number, sha, attempt, run_id: run.id, cause, url: run.html_url, workflow: c.setup.repo?.deploy_workflow ?? null } });
  if (!claim) return { outcome: 'wait', attempts: done };
  try {
    await deps.github.rerunRun(c.token, c.repo, run.id);
  } catch (e) {
    await repos.automationEvents.remove(claim.id);
    log.warn({ projectId: c.projectId, pr: w.number, err: e instanceof Error ? e.message : String(e) }, 'automation: deploy re-run refused');
    return { outcome: refusedForGood(e) ? 'give_up' : 'wait', attempts: done };
  }
  await publishEvent(repos, claim);
  log.info({ projectId: c.projectId, pr: w.number, runId: run.id, attempt, cause }, 'automation: deploy run again after a GitHub failure');
  await postAutomationLine(repos, c.projectId, (locale) => t(locale, 'O deploy falhou por um problema do GitHub; rodando de novo ({{attempt}} de {{max}}): {{url}}', { attempt, max, url: run.html_url }), log);
  return { outcome: 'retried', attempts: attempt };
}

/** Pauses this project only (D22): the person resumes it once the deploy is sorted out. */
async function pauseOnDeployFailure(deps: DeliveryDeps, c: DeliveryCtx): Promise<boolean> {
  const owner = c.ownerId ? await deps.repos.users.findById(c.ownerId) : undefined;
  if (!owner) return false;
  await pauseAutomation(controlContextFor(deps.repos, owner), { scope: c.projectId, reason: DEPLOY_FAILED });
  return true;
}
