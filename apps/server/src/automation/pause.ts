import type { ControlContext } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
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

/** The person's projects where automatic work is on: where a global pause or resume is recorded. */
async function automatedProjects(repos: Repositories, ownerId: string): Promise<string[]> {
  const projects = await repos.projects.list({ owner: ownerId });
  const out: string[] = [];
  for (const p of projects) if ((await repos.projectSetup.get(p.id)).data.automation.enabled) out.push(p.id);
  return out;
}

/**
 * Pauses the automatic work of one project or of all the person's projects. Pausing what is already
 * paused keeps the first timestamp. `interrupt` asks to also stop the tabs running now: here it is only
 * recorded on the event; the dispatcher sends the keys.
 */
export async function pauseAutomation(ctx: ControlContext, i: { scope: PauseScope; interrupt?: boolean }): Promise<{ paused_at: string }> {
  const { repos } = ctx;
  const interrupt = i.interrupt === true;
  if (i.scope === 'all') {
    // "View as" pauses the viewed person's work; "all" (admins) pauses the admin's own.
    const ownerId = ctx.scope.createAs;
    const { paused_at, fresh } = await repos.automationPauses.pauseUser(ownerId, new Date());
    if (fresh || interrupt) {
      for (const projectId of await automatedProjects(repos, ownerId)) await recordEvent(repos, { project_id: projectId, kind: 'paused', payload: { scope: 'all', interrupt } });
    }
    return { paused_at: paused_at.toISOString() };
  }
  const { project } = await ctx.scoped.project(i.scope);
  const { paused_at, fresh } = await repos.automationPauses.pauseProject(project.id, new Date());
  if (fresh || interrupt) await recordEvent(repos, { project_id: project.id, kind: 'paused', payload: { scope: 'project', interrupt } });
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
