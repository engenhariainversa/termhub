import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import { isPaused } from './pause.js';

/** Agent restarts after an exit (spec D15): one, then the run is blocked. */
export const MAX_RESTARTS = 1;

/**
 * Whether the follower will bring this run's exited agent back by itself (spec D15): the run is `running`,
 * has its restart left, the project's automation is on and not paused, and the card is still tagged. Only
 * then is the chat's "agent exited" card left out (`notifyAgentExited`); in every other case the person is
 * told, as for any tab.
 */
export async function followerWillRestart(repos: Repositories, run: AutomationRun): Promise<boolean> {
  if (run.status !== 'running' || run.restart_count >= MAX_RESTARTS || !run.task_id) return false;
  const [project, setup, task] = await Promise.all([repos.projects.findById(run.project_id), repos.projectSetup.get(run.project_id), repos.tasks.findById(run.task_id)]);
  if (!project?.owner_id || !setup.data.automation.enabled || !task?.auto) return false;
  return !(await isPaused(repos, project.owner_id, run.project_id));
}
