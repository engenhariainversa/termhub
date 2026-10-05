import { controlContextFor } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { CiState, ReleaseRun, TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { GithubCiClient } from '../integrations/github-ci.js';
import { deployOf, latestPerWorkflow, matchesWorkflow, type WorkflowRun } from '../ci/rules.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { DEPLOY_FAILED, RELEASE_FAILED } from './escalation-text.js';
import { recordEvent } from './events.js';
import { escalateDelivery } from './follower.js';
import { pauseAutomation } from './pause.js';

/*
 * After a merge (agentic board D22, §10.5): follow the project's deploy workflow and, for a PR that changed
 * release paths, its `automation.release_workflows` on the merge commit. A failed deploy pauses the project
 * and escalates; a failed release escalates only. Nothing is rolled back automatically (spike TER-967).
 */

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

export interface DeliveryDeps {
  repos: Repositories;
  github: Pick<GithubCiClient, 'listRuns' | 'branchSha' | 'isAncestor' | 'fileAt'>;
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
function runSource(deps: DeliveryDeps, c: DeliveryCtx, w: TaskPullRequest): (workflow: string) => Promise<WorkflowRun[]> {
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
    if (latest.length === 0 || latest.some((r) => r.conclusion !== 'cancelled')) return own;
    const later = await (atHead ??= newer());
    return later ? later.filter((r) => matchesWorkflow(r, workflow)) : own;
  };
}

/** The `version` of the merged `package.json`; null when there is none, it is private or unreadable. */
async function versionAt(deps: DeliveryDeps, c: DeliveryCtx, sha: string): Promise<string | null> {
  try {
    const text = await deps.github.fileAt(c.token, c.repo, 'package.json', sha);
    const pkg = text ? (JSON.parse(text) as { version?: unknown; private?: unknown }) : null;
    return pkg && pkg.private !== true && typeof pkg.version === 'string' ? pkg.version.slice(0, 100) : null;
  } catch {
    return null;
  }
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
  const runsOf = runSource(deps, c, w);
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
      releases.push({ workflow, state, url, version: state === 'passed' ? await (version ??= versionAt(deps, c, w.merge_commit_sha)) : (previous?.version ?? null), previous: previous?.state ?? 'none' });
    }
    patch.release_runs = releases.map(({ workflow, state, url, version }) => ({ workflow, state, url, version }));
  }
  await repos.taskPullRequests.updateCi(c.projectId, w.repo, w.number, patch);

  if (!c.setup.automation?.enabled) return;
  // only what the automation delivers: a card tagged automatic
  const task = await repos.tasks.findById(w.task_id);
  if (!task?.auto) return;
  const about = { project_id: c.projectId, task_id: w.task_id };
  const ids = { pr: w.number, sha: w.merge_commit_sha };

  if (deploy && finished(deploy.state) && deploy.state !== w.deploy_state) {
    const payload = { ...ids, url: deploy.url, workflow: deployWorkflow };
    if (deploy.state === 'passed') await recordEvent(repos, { ...about, kind: 'deploy_ok', payload });
    else {
      await recordEvent(repos, { ...about, kind: 'deploy_failed', payload });
      await pauseOnDeployFailure(deps, c).catch((e: unknown) => log.warn({ projectId: c.projectId, err: e instanceof Error ? e.message : String(e) }, 'automation: pause after a failed deploy failed'));
      await escalateDelivery(repos, about, DEPLOY_FAILED, log, payload);
    }
  }
  for (const r of releases) {
    if (!finished(r.state) || r.state === r.previous) continue;
    const payload = { ...ids, url: r.url, workflow: r.workflow, ...(r.version ? { version: r.version } : {}) };
    if (r.state === 'passed') await recordEvent(repos, { ...about, kind: 'release_ok', payload });
    else {
      await recordEvent(repos, { ...about, kind: 'release_failed', payload });
      await escalateDelivery(repos, about, RELEASE_FAILED, log, payload);
    }
  }
}

/** Pauses this project only (D22): the person resumes it once the deploy is sorted out. */
async function pauseOnDeployFailure(deps: DeliveryDeps, c: DeliveryCtx): Promise<void> {
  const owner = c.ownerId ? await deps.repos.users.findById(c.ownerId) : undefined;
  if (!owner) return;
  await pauseAutomation(controlContextFor(deps.repos, owner), { scope: c.projectId, reason: DEPLOY_FAILED });
}
