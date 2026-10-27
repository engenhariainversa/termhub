import { matchesWorkflow, type WorkflowRun } from '../ci/rules.js';
import type { ProjectSetupData } from '../setup/schema.js';

/** A workflow as the Setup names it: its display name and its file. */
export interface WorkflowRef {
  name: string;
  path: string;
}

/**
 * TER-1120: the workflows a push to the base branch starts that a PR's head never runs (deploys, releases,
 * builds…), per project, as the merge executor last read them on the base head. Per process, like the merge
 * waits: a restart clears it and the next pass into the base fills it again.
 */
const seen = new Map<string, { sha: string; workflows: WorkflowRef[] }>();

/** Whether the base head `sha` of the project was already read (one extra GitHub read per base head). */
export const pushOnlyKnown = (projectId: string, sha: string): boolean => seen.get(projectId)?.sha === sha;

export function notePushOnlyWorkflows(projectId: string, sha: string, workflows: WorkflowRef[]): void {
  seen.set(projectId, { sha, workflows });
}

/**
 * The push-only runs of a base head: started by a push (or of unknown event, in older readings) and of no
 * workflow that also ran on the PR's head.
 */
export function pushOnlyOf(baseRuns: WorkflowRun[], headRuns: WorkflowRun[]): WorkflowRef[] {
  const onHead = new Set(headRuns.map((r) => r.path));
  return baseRuns.filter((r) => (r.event === undefined || r.event === 'push') && !onHead.has(r.path)).map((r) => ({ name: r.name, path: r.path }));
}

/** Whether the Setup already names the workflow: the deploy, a release workflow or a required check. */
export function listedInSetup(w: WorkflowRef, setup: ProjectSetupData): boolean {
  const names = [setup.repo?.deploy_workflow ?? null, ...setup.automation.release_workflows, ...setup.automation.required_checks].filter((n): n is string => !!n);
  const asRun = { name: w.name, path: w.path } as WorkflowRun;
  return names.some((n) => matchesWorkflow(asRun, n));
}

/** The push-only workflows of the project's base head the Setup does not name: the Setup's warning. */
export function unlistedWorkflows(projectId: string, setup: ProjectSetupData): WorkflowRef[] {
  return (seen.get(projectId)?.workflows ?? []).filter((w) => !listedInSetup(w, setup));
}

/** Tests only. */
export function resetPushOnlyWorkflows(): void {
  seen.clear();
}
