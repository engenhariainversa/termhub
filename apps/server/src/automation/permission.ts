import { DEFAULT_AUTOMATION_TOOLS, type AgentPermission } from '../control/agents.js';
import { safeAllowedTools } from '../control/automation-tools.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { ProjectSetupData } from '../setup/schema.js';

/**
 * The permission profile an automatic run starts with (spec D19): `acceptEdits` plus the project's allow
 * list, or the default one, and the pushes to the run's own `branch` (TER-968). The dispatcher stores the
 * list on the run (`allowed_tools`); the push rules come from the run's branch, never from the list.
 */
export function automationPermission(automation: Pick<ProjectSetupData['automation'], 'allowed_tools'>, branch: string | null): AgentPermission {
  return { mode: 'acceptEdits', allowedTools: automation.allowed_tools ?? DEFAULT_AUTOMATION_TOOLS, branch };
}

/**
 * The profile a new run starts with, its allow list less any rule too broad for an automatic tab
 * (`unsafeAllowedTool`, TER-968): `dropped` counts them, so the caller can log it (never the rules).
 * The line builder and `permissionAllowed` filter again, for lists stored before the filter existed.
 */
export function startPermission(automation: Pick<ProjectSetupData['automation'], 'allowed_tools'>, branch: string | null): { permission: AgentPermission; dropped: number } {
  const base = automationPermission(automation, branch);
  const { kept, dropped } = safeAllowedTools(base.allowedTools);
  return { permission: { ...base, allowedTools: kept }, dropped: dropped.length };
}

/**
 * The profile a restart or resume line of this run keeps (preflight F-12): the one stored on the run when it
 * started, so an edit of the project's allow list mid-run does not change a running tab's flags. A run
 * started before the list was stored falls back to the project's current setup. The worktree comes from the
 * run (TER-991), like the branch.
 */
export async function runPermission(
  repos: Repositories,
  run: Pick<AutomationRun, 'project_id' | 'allowed_tools' | 'branch'> & Partial<Pick<AutomationRun, 'worktree_path'>>,
): Promise<AgentPermission> {
  const worktree = run.worktree_path ?? null;
  if (run.allowed_tools) return { mode: 'acceptEdits', allowedTools: run.allowed_tools, branch: run.branch, worktree };
  return { ...automationPermission((await repos.projectSetup.get(run.project_id)).data.automation, run.branch), worktree };
}

/**
 * The permission profile a line typed into this tab must keep, when the tab runs automatic work (an
 * active run); null for every other tab, whose lines stay as they were.
 */
export async function activeRunPermission(repos: Repositories, tabId: string): Promise<AgentPermission | null> {
  const run = await repos.automationRuns.activeByTab(tabId);
  return run ? runPermission(repos, run) : null;
}
