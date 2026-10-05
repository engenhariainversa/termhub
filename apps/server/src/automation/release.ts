import { controlContextFor } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { CiState, ReleaseRun, TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { GithubCiClient } from '../integrations/github-ci.js';
import { deployOf, latestPerWorkflow, matchesWorkflow, type WorkflowRun } from '../ci/rules.js';
import { t } from '../i18n/index.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { DEPLOY_FAILED, DEPLOY_FAILED_NOT_PAUSED, RELEASE_FAILED } from './escalation-text.js';
import { recordEvent } from './events.js';
import { postAutomationLine } from './chat-line.js';
import { escalateDelivery } from './follower.js';
import { pauseAutomation } from './pause.js';
import { globMatches } from './policy.js';

/*
 * After a merge (agentic board D22, §10.5): follow the project's deploy workflow and, for a PR that changed
 * release paths, its `automation.release_workflows` on the merge commit. A failed deploy pauses the project
 * and escalates; a failed release escalates only. Nothing is rolled back automatically (spike TER-967).
 */

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

export interface DeliveryDeps {
  repos: Repositories;
  github: Pick<GithubCiClient, 'listRuns' | 'branchSha' | 'isAncestor' | 'fileAt' | 'prFiles'>;
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
 * One sync pass over a merged PR: reads the deploy and release runs, stores them on the PR's rows, and —
 * for an automatic card with automation on — records the result once, on the pass that sees it finish.
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
  // only what the automation delivers: an automatic card of a project with automation on
  const reporting = !!c.setup.automation?.enabled && !!(await repos.tasks.findById(w.task_id))?.auto;
  const about = { project_id: c.projectId, task_id: w.task_id };
  const ids = { pr: w.number, sha: w.merge_commit_sha };
  const deployDone = reporting && !!deploy && finished(deploy.state) && deploy.state !== w.deploy_state;

  if (deployDone && deploy?.state === 'failed') {
    // The safety action comes first and the failed state is stored last: if anything here throws, the next
    // sync still sees the deploy as unreported and retries (pausing again is a no-op).
    const payload = { ...ids, url: deploy.url, workflow: deployWorkflow };
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

/** Pauses this project only (D22): the person resumes it once the deploy is sorted out. */
async function pauseOnDeployFailure(deps: DeliveryDeps, c: DeliveryCtx): Promise<boolean> {
  const owner = c.ownerId ? await deps.repos.users.findById(c.ownerId) : undefined;
  if (!owner) return false;
  await pauseAutomation(controlContextFor(deps.repos, owner), { scope: c.projectId, reason: DEPLOY_FAILED });
  return true;
}
