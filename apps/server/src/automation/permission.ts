import { DEFAULT_AUTOMATION_TOOLS, type AgentPermission } from '../control/agents.js';
import type { Repositories } from '../db/repositories/index.js';
import type { ProjectSetupData } from '../setup/schema.js';

/**
 * The permission profile of an automatic run (spec D19): `acceptEdits` plus the project's allow list, or
 * the default one. Derived from the project's setup every time it is needed — at the start and on every
 * restart or resume line (preflight F-12) — so all of them follow the same rule.
 */
export function automationPermission(automation: Pick<ProjectSetupData['automation'], 'allowed_tools'>): AgentPermission {
  return { mode: 'acceptEdits', allowedTools: automation.allowed_tools ?? DEFAULT_AUTOMATION_TOOLS };
}

/**
 * The permission profile a line typed into this tab must keep, when the tab runs automatic work (an
 * active run); null for every other tab, whose lines stay as they were.
 */
export async function activeRunPermission(repos: Repositories, tabId: string): Promise<AgentPermission | null> {
  const run = await repos.automationRuns.activeByTab(tabId);
  if (!run) return null;
  return automationPermission((await repos.projectSetup.get(run.project_id)).data.automation);
}
