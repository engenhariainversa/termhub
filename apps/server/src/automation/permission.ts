import { DEFAULT_AUTOMATION_TOOLS, type AgentPermission } from '../control/agents.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { ProjectSetupData } from '../setup/schema.js';

/**
 * The permission profile an automatic run starts with (spec D19): `acceptEdits` plus the project's allow
 * list, or the default one. The dispatcher stores the list on the run (`allowed_tools`).
 */
export function automationPermission(automation: Pick<ProjectSetupData['automation'], 'allowed_tools'>): AgentPermission {
  return { mode: 'acceptEdits', allowedTools: automation.allowed_tools ?? DEFAULT_AUTOMATION_TOOLS };
}

/**
 * The profile a restart or resume line of this run keeps (preflight F-12): the one stored on the run when it
 * started, so an edit of the project's allow list mid-run does not change a running tab's flags. A run
 * started before the list was stored falls back to the project's current setup.
 */
export async function runPermission(repos: Repositories, run: Pick<AutomationRun, 'project_id' | 'allowed_tools'>): Promise<AgentPermission> {
  if (run.allowed_tools) return { mode: 'acceptEdits', allowedTools: run.allowed_tools };
  return automationPermission((await repos.projectSetup.get(run.project_id)).data.automation);
}

/**
 * The permission profile a line typed into this tab must keep, when the tab runs automatic work (an
 * active run); null for every other tab, whose lines stay as they were.
 */
export async function activeRunPermission(repos: Repositories, tabId: string): Promise<AgentPermission | null> {
  const run = await repos.automationRuns.activeByTab(tabId);
  return run ? runPermission(repos, run) : null;
}
