import type { CiState, TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { ProjectSetupData } from '../setup/schema.js';

/* What a merged PR still has to deliver (agentic board D22): pure, so the progress panel and the health
 * watcher read it without loading the delivery follower (`release.ts`). */

export const finished = (s: CiState): boolean => s === 'passed' || s === 'failed';

/** Whether the PR's release workflows are followed: automation on, the PR changed a release path (F-31). */
export function followsReleases(setup: ProjectSetupData, w: Pick<TaskPullRequest, 'deploy_state' | 'release_runs' | 'changed_level'>): boolean {
  return !!setup.automation?.enabled && w.changed_level === 'release' && setup.automation.release_workflows.length > 0;
}

/** Whether a merged PR still has a delivery run to wait for (its deploy, or one of its release workflows). */
export function deliveryPending(setup: ProjectSetupData, w: Pick<TaskPullRequest, 'deploy_state' | 'release_runs' | 'changed_level'>): boolean {
  if (setup.repo?.deploy_workflow && !finished(w.deploy_state)) return true;
  if (!followsReleases(setup, w)) return false;
  return setup.automation.release_workflows.some((wf) => !finished(w.release_runs.find((r) => r.workflow === wf)?.state ?? 'none'));
}

