import type { ControlContext } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import { sendKeyToSession } from '../terminal/session-ops.js';
import { recordEvent } from './events.js';

/** `'all'` = every project of the person ("Pausar tudo"); otherwise a project id. */
export type PauseScope = 'all' | string;

/**
 * Whether automatic work may not act on a project right now: its owner pressed "Pausar tudo", or the
 * project itself is paused. While paused nothing is started, typed, answered or merged (spec D24).
 */
export async function isPaused(repos: Repositories, ownerId: string | null, projectId: string): Promise<boolean> {
  const { user, project } = await repos.automationPauses.state(ownerId, projectId);
  return user !== null || project !== null;
}

/**
 * The tab's active automatic run when automatic work may act in it right now: the tab has an active run,
 * its project has automation on and is not paused (spec D18, D24, preflight F-17). Null otherwise — a
 * manual tab, a paused or disabled project — and then the tab is treated as any other: "Responder
 * sozinho" decides. Read again before every automatic answer is sent, so a pause stops it.
 */
export async function automaticRunOfTab(repos: Repositories, tabId: string): Promise<AutomationRun | null> {
  const run = await repos.automationRuns.activeByTab(tabId);
  if (!run) return null;
  const project = await repos.projects.findById(run.project_id);
  if (!project) return null;
  if (!(await repos.projectSetup.get(run.project_id)).data.automation.enabled) return null;
  if (await isPaused(repos, project.owner_id, run.project_id)) return null;
  return run;
}

/** The person's projects where automatic work is on: where a global pause or resume is recorded. */
export async function automatedProjects(repos: Repositories, ownerId: string): Promise<string[]> {
  const projects = await repos.projects.list({ owner: ownerId });
  const out: string[] = [];
  for (const p of projects) if ((await repos.projectSetup.get(p.id)).data.automation.enabled) out.push(p.id);
  return out;
}

/** Presses Escape in a tab: stops the agent's current turn (Claude Code and Codex both read it as "interrupt"). */
export type PressEscape = (tabId: string) => Promise<void>;

/** Escape through the tab's own session, without recreating a session that is gone. */
export function escapeTab(repos: Repositories): PressEscape {
  return async (tabId) => {
    const tab = await repos.tabs.findById(tabId);
    if (!tab?.tmux_session) return;
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine) return;
    await sendKeyToSession(machine, tab.tmux_session, 'Escape');
  };
}

/**
 * "Pausar e interromper" (D24): Escape in the tab of every active automatic run of these projects. Best
 * effort per tab: a machine that is offline or a tab that is gone does not keep the others from stopping.
 * `onlyWorking`: only tabs in the middle of a turn (the dispatcher's startup pass, which may run again on
 * every deploy while the pause lasts). Returns how many tabs got the key.
 */
export async function interruptRuns(
  repos: Repositories,
  projectIds: string[],
  opts: { press?: PressEscape; onlyWorking?: boolean; log?: { warn(o: object, m: string): void } } = {},
): Promise<number> {
  const press = opts.press ?? escapeTab(repos);
  let sent = 0;
  for (const projectId of projectIds) {
    let runs: Awaited<ReturnType<Repositories['automationRuns']['activeByProject']>>;
    try {
      runs = await repos.automationRuns.activeByProject(projectId);
    } catch (e) {
      // the pause itself is already recorded: a failed read must not undo the answer to it
      opts.log?.warn({ projectId, err: e instanceof Error ? e.message : String(e) }, 'automation: interrupt could not list runs');
      continue;
    }
    for (const run of runs) {
      if (!run.tab_id) continue;
      try {
        if (opts.onlyWorking && (await repos.tabs.findById(run.tab_id))?.state !== 'working') continue;
        await press(run.tab_id);
        sent++;
      } catch (e) {
        opts.log?.warn({ tabId: run.tab_id, runId: run.id, err: e instanceof Error ? e.message : String(e) }, 'automation: interrupt failed');
      }
    }
  }
  return sent;
}

/**
 * Pauses the automatic work of one project or of all the person's projects. Pausing what is already
 * paused keeps the first timestamp. `interrupt` also stops the tabs running now: Escape in each active
 * run's tab (`interruptRuns`), after the pause is recorded so nothing types into them again.
 */
export async function pauseAutomation(
  ctx: ControlContext,
  i: { scope: PauseScope; interrupt?: boolean; /** why the server pauses by itself (`deploy_failed`); recorded on the event */ reason?: string },
  opts: { press?: PressEscape } = {},
): Promise<{ paused_at: string }> {
  const { repos } = ctx;
  const interrupt = i.interrupt === true;
  if (i.scope === 'all') {
    // "View as" pauses the viewed person's work; "all" (admins) pauses the admin's own.
    const ownerId = ctx.scope.createAs;
    const { paused_at, fresh } = await repos.automationPauses.pauseUser(ownerId, new Date());
    if (fresh || interrupt) {
      const projects = await automatedProjects(repos, ownerId);
      for (const projectId of projects) await recordEvent(repos, { project_id: projectId, kind: 'paused', payload: { scope: 'all', interrupt } });
      if (interrupt) await interruptRuns(repos, projects, opts);
    }
    return { paused_at: paused_at.toISOString() };
  }
  const { project } = await ctx.scoped.project(i.scope);
  const { paused_at, fresh } = await repos.automationPauses.pauseProject(project.id, new Date());
  if (fresh || interrupt) await recordEvent(repos, { project_id: project.id, kind: 'paused', payload: { scope: 'project', interrupt, ...(i.reason ? { reason: i.reason } : {}) } });
  if (interrupt) await interruptRuns(repos, [project.id], opts);
  return { paused_at: paused_at.toISOString() };
}

/** Lifts a pause. A project still under its owner's "Pausar tudo" stays paused until that is lifted too. */
export async function resumeAutomation(ctx: ControlContext, i: { scope: PauseScope }): Promise<void> {
  const { repos } = ctx;
  if (i.scope === 'all') {
    const ownerId = ctx.scope.createAs;
    if (!(await repos.automationPauses.resumeUser(ownerId))) return;
    for (const projectId of await automatedProjects(repos, ownerId)) await recordEvent(repos, { project_id: projectId, kind: 'resumed', payload: { scope: 'all' } });
    return;
  }
  const { project } = await ctx.scoped.project(i.scope);
  if (await repos.automationPauses.resumeProject(project.id)) await recordEvent(repos, { project_id: project.id, kind: 'resumed', payload: { scope: 'project' } });
}

/** What the pause switch shows to a client: the person's "Pausar tudo" and the projects paused on their own. */
export interface AutomationPauseView {
  paused_at: string | null;
  projects: Array<{ id: string; paused_at: string }>;
  /** Whether the person has any project with automatic work on: without one the pause switch has nothing to stop and clients hide it. */
  has_automation: boolean;
  /** The person may pause and resume (`projects:update`): clients hide the buttons otherwise. */
  can_update: boolean;
}

export async function automationPauseState(ctx: ControlContext): Promise<AutomationPauseView> {
  const { repos } = ctx;
  // The admin's "view as all" has no single owner: the pause switch is about the admin's own projects then.
  const ownerId = ctx.scope.ownerId ?? ctx.scope.createAs;
  const [user, projects, automated] = await Promise.all([repos.automationPauses.userPausedAt(ctx.scope.createAs), repos.automationPauses.pausedProjects(ownerId), automatedProjects(repos, ownerId)]);
  return {
    paused_at: user ? user.toISOString() : null,
    projects: projects.map((p) => ({ id: p.id, paused_at: p.paused_at.toISOString() })),
    has_automation: automated.length > 0,
    can_update: await ctx.can('projects', 'update'),
  };
}
