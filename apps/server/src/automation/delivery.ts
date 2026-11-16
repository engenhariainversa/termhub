import type { CiState, TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { ProjectSetupData } from '../setup/schema.js';

/* What a merged PR still has to deliver (agentic board D22): pure, so the progress panel and the health
 * watcher read it without loading the delivery follower (`release.ts`). */

export const finished = (s: CiState): boolean => s === 'passed' || s === 'failed';

/** What a merged PR's repository delivers (multi-repo R7): its deploy workflow and release workflows. */
export type DeliveryEntry = { deploy_workflow: string | null; release_workflows: string[] };

/** The setup's own repository (`setup.repo` and the project-wide workflows): a single-repo project's entry. */
const setupEntry = (setup: ProjectSetupData): DeliveryEntry => ({ deploy_workflow: setup.repo?.deploy_workflow ?? null, release_workflows: setup.automation?.release_workflows ?? [] });

/** Whether the PR's release workflows are followed: automation on, the PR changed a release path (F-31). */
export function followsReleases(setup: ProjectSetupData, w: Pick<TaskPullRequest, 'deploy_state' | 'release_runs' | 'changed_level'>, entry: DeliveryEntry = setupEntry(setup)): boolean {
  return !!setup.automation?.enabled && w.changed_level === 'release' && entry.release_workflows.length > 0;
}

/** Whether a merged PR still has a delivery run to wait for (its deploy, or one of its release workflows), under its repository's entry. */
export function deliveryPending(setup: ProjectSetupData, w: Pick<TaskPullRequest, 'deploy_state' | 'release_runs' | 'changed_level'>, entry: DeliveryEntry = setupEntry(setup)): boolean {
  if (entry.deploy_workflow && !finished(w.deploy_state)) return true;
  if (!followsReleases(setup, w, entry)) return false;
  return entry.release_workflows.some((wf) => !finished(w.release_runs.find((r) => r.workflow === wf)?.state ?? 'none'));
}
