import { controlContextFor, type ControlContext } from '../control/context.js';
import { closeTab as closeTabFn } from '../control/terminals.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Project } from '../db/repositories/types.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { removeWorkspace as removeWorkspaceFn } from './branches.js';
import { recordEvent } from './events.js';

/*
 * After a merge (agentic board spec §7, TER-871): the card's worktree is removed and the finished run's tab
 * closed. A run is `due` for it from the merge (or from its card being deleted) until it settles. What cannot
 * be done yet — the machine is offline, the tab is still busy, another run of the card is active — stays due
 * and is tried again on the dispatcher's next ticks, up to CLEANUP_MAX_ATTEMPTS, then given up with an event.
 */

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

/** Unfinished passes before the cleanup is given up: about an hour of the dispatcher's 15 s ticks. */
export const CLEANUP_MAX_ATTEMPTS = 240;

export interface CleanupDeps {
  repos: Repositories;
  removeWorkspace?: typeof removeWorkspaceFn;
  /** Closes the tab as the owner. Default: `closeTab` of the control layer. */
  closeTab?: (ctx: ControlContext, tabId: string) => Promise<void>;
  log?: Log;
}

export interface CleanupResult {
  /** worktrees removed now */
  removed: number;
  /** worktrees kept because they hold uncommitted changes */
  kept: number;
  /** runs whose cleanup is still due */
  pending: number;
}

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting']);

const codeOf = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code.slice(0, 64) : 'INTERNAL';
};

/**
 * Works through the due runs of one project. Never throws for a run it cannot finish: that run stays due.
 * Pause and automation-off are the caller's to decide (a merged card's cleanup is not "work", so a pause
 * does not stop it; turning automation off does: nothing calls this then).
 */
export async function cleanupRuns(deps: CleanupDeps, project: Pick<Project, 'id' | 'owner_id'>, setup: ProjectSetupData, runs: AutomationRun[]): Promise<CleanupResult> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  const remove = deps.removeWorkspace ?? removeWorkspaceFn;
  const closeTab = deps.closeTab ?? (async (ctx: ControlContext, tabId: string) => void (await closeTabFn(ctx, { tab_id: tabId, force: true })));
  const result: CleanupResult = { removed: 0, kept: 0, pending: 0 };
  const due = runs.filter((r) => r.cleanup_state === 'due');
  const owner = project.owner_id ? await repos.users.findById(project.owner_id) : undefined;

  /** Tab step: only the tab of a run that ended `done` and sits idle or finished is closed; a working tab is never killed. */
  const tabResolved = async (run: AutomationRun): Promise<boolean> => {
    if (ACTIVE.has(run.status)) return false;
    if (run.status !== 'done' || !run.tab_id) return true; // a blocked or failed run's tab is the person's to look at
    const tab = await repos.tabs.findById(run.tab_id);
    if (!tab) return true;
    if (tab.state !== 'idle' && tab.state !== 'finished') return false;
    if (!owner) return false;
    try {
      await closeTab(controlContextFor(repos, owner), tab.id);
      return true;
    } catch (e) {
      if (codeOf(e) === 'TAB_NOT_FOUND' || codeOf(e) === 'NOT_FOUND') return true;
      log.warn({ runId: run.id, tabId: tab.id, code: codeOf(e) }, 'automation: tab of a finished run not closed');
      failed.add(run.id);
      return false;
    }
  };

  /** runs whose cleanup really failed (an RPC or close error): only these count against the attempt bound */
  const failed = new Set<string>();
  const ready: AutomationRun[] = [];
  const waiting: AutomationRun[] = [];
  for (const run of due) {
    try {
      (await tabResolved(run) ? ready : waiting).push(run);
    } catch (e) {
      log.warn({ runId: run.id, code: codeOf(e) }, 'automation: tab step failed');
      failed.add(run.id);
      waiting.push(run);
    }
  }

  // runs of one card share one worktree: it goes only when every one of them is ready
  const groups = new Map<string, AutomationRun[]>();
  const keyOf = (r: AutomationRun) => (r.machine_id && r.worktree_path ? `${r.machine_id}\n${r.worktree_path}` : null);
  for (const run of due) {
    const key = keyOf(run);
    if (key) groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const settle = async (run: AutomationRun, state: 'done' | 'kept' | 'gave_up', outcome: 'removed' | 'kept' | 'gave_up' | null): Promise<void> => {
    if (!(await repos.automationRuns.settleCleanup(run.id, state))) return;
    if (!outcome) return;
    await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'worktree_cleanup', payload: { outcome, path: run.worktree_path } }).catch((e: unknown) =>
      log.warn({ runId: run.id, code: codeOf(e) }, 'automation: worktree_cleanup not recorded'),
    );
  };

  const done = new Set<string>();
  for (const run of ready) {
    if (done.has(run.id)) continue;
    const key = keyOf(run);
    const group = key ? groups.get(key)! : [run];
    if (group.some((r) => waiting.includes(r))) {
      waiting.push(...group.filter((r) => !waiting.includes(r)));
      group.forEach((r) => done.add(r.id));
      continue;
    }
    group.forEach((r) => done.add(r.id));
    if (!key) {
      await settle(run, 'done', null);
      continue;
    }
    try {
      const [machine, link] = await Promise.all([repos.machines.findById(run.machine_id!), repos.projectMachines.find(run.project_id, run.machine_id!)]);
      if (!machine || !link) {
        for (const r of group) await settle(r, 'done', null); // the machine or its link is gone: nothing to remove
        continue;
      }
      const r = await remove(machine, { repoDir: link.cwd, root: setup.automation.worktrees_dir, path: run.worktree_path! });
      if (r.dirty) {
        result.kept++;
        for (const x of group) await settle(x, 'kept', 'kept');
      } else {
        if (r.removed) result.removed++;
        for (const x of group) await settle(x, 'done', r.removed ? 'removed' : null);
      }
      log.info({ runId: run.id, machineId: machine.id, removed: r.removed, dirty: r.dirty }, 'automation: worktree cleanup');
    } catch (e) {
      log.warn({ runId: run.id, machineId: run.machine_id, code: codeOf(e) }, 'automation: worktree not removed yet');
      group.forEach((r) => failed.add(r.id));
      waiting.push(...group);
    }
  }

  for (const run of waiting) {
    result.pending++;
    // waiting on an active sibling run or a busy tab is not a failed attempt: only a real failure is counted
    if (!failed.has(run.id)) continue;
    const attempts = await repos.automationRuns.bumpCleanup(run.id).catch((e: unknown) => {
      log.warn({ runId: run.id, code: codeOf(e) }, 'automation: cleanup attempt not counted');
      return 0;
    });
    if (attempts >= CLEANUP_MAX_ATTEMPTS) {
      result.pending--;
      await settle(run, 'gave_up', 'gave_up');
    }
  }
  return result;
}
