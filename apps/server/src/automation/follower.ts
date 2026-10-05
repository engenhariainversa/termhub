import { AGENT_EXITED_TEXT, EXITED_RESUME_PROMPT, resumeCommandFor } from '../chat/agent-exited.js';
import { controlContextFor, ControlError, type ControlContext } from '../control/context.js';
import { taskOut, type TaskOut } from '../control/tasks.js';
import { sendInput } from '../control/terminals.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun, AutomationRunPatch } from '../db/repositories/automation-runs.js';
import type { Tab, Task } from '../db/repositories/types.js';
import { msg } from '../i18n/index.js';
import { monitorBus, type TabStateChange } from '../monitor/bus.js';
import { RATE_LIMIT_TEXT } from '../monitor/state.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { recordEvent } from './events.js';
import { isPaused } from './pause.js';
import { automationPermission } from './permission.js';
import { RESUME_TEXT, serverMessage } from './prompts.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/** Agent restarts after an exit (spec D15): one, then the run is blocked. */
export const MAX_RESTARTS = 1;

export interface FollowerDeps {
  repos: Repositories;
  /** This process's instance (`dispatcherInstanceId`): only the runs it drives are followed here. */
  instance: string;
  lifecycle: { readonly draining: boolean };
  /** Types a line into the tab as the project's owner, Enter included. Default: `sendInput` with no origin
   *  note — the `[termhub automático]` marker says where the text comes from (spec D27). */
  type?: (ctx: ControlContext, tabId: string, text: string) => Promise<void>;
  /** The shell line that brings an exited agent back in the same tab. Default: `resumeCommandFor`. */
  restartLine?: typeof resumeCommandFor;
  /** A stop on a usage limit (spec D16). Task 19 fills it; until then the run just waits. */
  onRateLimited?: (run: AutomationRun, tab: Tab) => Promise<void>;
  /** How long a change settles before the tab is read (default SETTLE_MS). */
  settleMs?: number;
  log?: Log;
}

/**
 * The monitor publishes a state before the hook's question card is opened (`noteHookEvent` runs after it),
 * and one turn can end in a burst of events: the follower reads the tab this long after the change, so a
 * question is seen as a question and only the settled state is acted on.
 */
export const SETTLE_MS = 3_000;

const noopLog: Log = { info: () => {}, warn: () => {} };

const defaultType = async (ctx: ControlContext, tabId: string, text: string): Promise<void> => {
  await sendInput(ctx, { tab_id: tabId, text }, null);
};

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code.slice(0, 64) : 'INTERNAL';
}

/**
 * Writes the run under the instance that drives it now (the row's own `claimed_by`): the write is dropped
 * when another instance took the run over in between. A tab tool (`report_card`) may reach either colour,
 * so it writes on behalf of whoever holds the run. Only an active run is written: a run ends once.
 */
function writeRun(repos: Repositories, run: AutomationRun, patch: Pick<AutomationRunPatch, 'status' | 'waiting_reason' | 'ended_at'>): Promise<boolean> {
  return repos.automationRuns.updateActive(run.id, run.claimed_by, patch);
}

/**
 * Escalation of a run to the person (spec §9.3). Task 24 gives it the question card and the push; for now it
 * records the event the feed shows. Never throws.
 */
export async function escalateRun(repos: Repositories, run: AutomationRun, reason: string, log: Log = noopLog): Promise<void> {
  await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'escalated', payload: { reason, tab_id: run.tab_id } }).catch((e: unknown) =>
    log.warn({ runId: run.id, code: errorCode(e) }, 'automation: escalation not recorded'),
  );
}

/**
 * A run that keeps stopping after `resume_max` resumes (spec D15). Task 23 first wakes the chat to read the
 * last answer and decide; for now the run waits (so it is not resumed again) and is escalated.
 */
export async function wakeOrEscalate(repos: Repositories, run: AutomationRun, reason: string, log: Log = noopLog): Promise<void> {
  if (!(await writeRun(repos, run, { status: 'waiting', waiting_reason: reason }))) return;
  log.info({ runId: run.id, taskId: run.task_id, tabId: run.tab_id, reason }, 'automation: run waits for a person');
  await escalateRun(repos, run, reason, log);
}

/**
 * The card of a run that ends done (spec D17): it stays where the agent put it. A card whose link failed at
 * the start (`TASK_LINK_FAILED`: the agent ran, the card never moved) is linked to the run's tab now and
 * leaves `todo` for the agent column, as a start would have done — otherwise the dispatcher would take it
 * again. A card a person linked to another tab or moved on is left alone.
 */
async function placeDoneCard(repos: Repositories, run: AutomationRun, log: Log): Promise<void> {
  if (!run.task_id || !run.tab_id) return;
  try {
    const task = await repos.tasks.findById(run.task_id);
    if (!task) return;
    if (task.tab_id === null) await repos.tasks.setTab(task.id, run.tab_id);
    if (task.status === 'todo') await repos.tasks.startWork(task.id);
  } catch (e) {
    log.warn({ runId: run.id, taskId: run.task_id, code: errorCode(e) }, 'automation: card of a done run not placed');
  }
}

/** Ends the run `done` (a report or an open PR from its branch) and places its card. False when another
 *  instance wrote it first. */
async function finishDone(repos: Repositories, run: AutomationRun, via: 'report_card' | 'pull_request', pr: { url: string; number?: number } | null, log: Log): Promise<boolean> {
  if (!(await writeRun(repos, run, { status: 'done', waiting_reason: null, ended_at: new Date() }))) return false;
  actedOn.delete(run.id);
  await placeDoneCard(repos, run, log);
  const base = { project_id: run.project_id, task_id: run.task_id, run_id: run.id };
  await recordEvent(repos, { ...base, kind: 'run_done', payload: { via, tab_id: run.tab_id, pr_url: pr?.url ?? null } }).catch((e: unknown) => log.warn({ runId: run.id, code: errorCode(e) }, 'automation: run_done not recorded'));
  if (pr) {
    await recordEvent(repos, { ...base, kind: 'pr_opened', payload: { pr_url: pr.url, ...(pr.number !== undefined ? { number: pr.number } : {}), branch: run.branch } }).catch((e: unknown) =>
      log.warn({ runId: run.id, code: errorCode(e) }, 'automation: pr_opened not recorded'),
    );
  }
  log.info({ runId: run.id, taskId: run.task_id, tabId: run.tab_id, via }, 'automation: run done');
  return true;
}

/** Ends the run `blocked` and escalates it (spec D15, D17). */
async function finishBlocked(repos: Repositories, run: AutomationRun, code: string, reason: string | null, log: Log): Promise<boolean> {
  if (!(await writeRun(repos, run, { status: 'blocked', waiting_reason: code, ended_at: new Date() }))) return false;
  actedOn.delete(run.id);
  await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'run_blocked', payload: { code, reason, tab_id: run.tab_id } }).catch((e: unknown) =>
    log.warn({ runId: run.id, code: errorCode(e) }, 'automation: run_blocked not recorded'),
  );
  log.info({ runId: run.id, taskId: run.task_id, tabId: run.tab_id, code }, 'automation: run blocked');
  await escalateRun(repos, run, code, log);
  return true;
}

/** The PR fallback of D17: an open PR the CI sync linked to the card, from the run's branch. */
async function openPrOfRun(repos: Repositories, run: AutomationRun): Promise<{ url: string; number: number } | null> {
  if (!run.task_id || !run.branch) return null;
  const pr = (await repos.taskPullRequests.listByTasks([run.task_id])).find((p) => p.state === 'open' && p.head_ref === run.branch);
  return pr ? { url: pr.url, number: pr.number } : null;
}

const rateLimited = (tab: Tab) => tab.rate_limited_at !== null || (tab.state_text ?? '').startsWith(RATE_LIMIT_TEXT);

/**
 * Whether the server may type into the run's tab now, and what with: the project's automation is on and
 * not paused (D24), and the card is still tagged (spec §13, preflight F-23). A card whose tag was removed
 * ends its run here — the agent finished its turn and is not resumed; the card is the person's now.
 */
async function mayType(deps: FollowerDeps, run: AutomationRun, log: Log): Promise<{ ctx: ControlContext; setup: ProjectSetupData; task: Task } | null> {
  const { repos } = deps;
  const project = await repos.projects.findById(run.project_id);
  if (!project?.owner_id || !run.task_id) return null;
  const [task, setup] = await Promise.all([repos.tasks.findById(run.task_id), repos.projectSetup.get(run.project_id)]);
  if (!task || !setup.data.automation.enabled) return null;
  if (!task.auto) {
    if (await writeRun(repos, run, { status: 'cancelled', waiting_reason: 'untagged', ended_at: new Date() })) {
      log.info({ runId: run.id, taskId: task.id, tabId: run.tab_id }, 'automation: card untagged, run not resumed');
    }
    return null;
  }
  if (await isPaused(repos, project.owner_id, run.project_id)) return null;
  const owner = await repos.users.findById(project.owner_id);
  if (!owner) return null;
  return { ctx: controlContextFor(repos, owner), setup: setup.data, task };
}

/** `waiting_input` after a Stop (preflight F-13): resume, end on an open PR, or hand over past the cap. */
async function onStopped(deps: FollowerDeps, run: AutomationRun, tab: Tab, log: Log): Promise<void> {
  const { repos } = deps;
  // a usage limit first: never resume into it (D16, Task 19)
  if (rateLimited(tab)) {
    await deps.onRateLimited?.(run, tab);
    return;
  }
  // a question card waits for its own answer (spec §9.1, Task 21)
  if (await repos.tabQuestions.hasOpenQuestion(tab.id)) return;
  const pr = await openPrOfRun(repos, run);
  if (pr) {
    await finishDone(repos, run, 'pull_request', pr, log);
    return;
  }
  const ready = await mayType(deps, run, log);
  if (!ready) return;
  if (run.resume_count >= ready.setup.automation.resume_max) {
    await wakeOrEscalate(repos, run, 'resume_cap', log);
    return;
  }
  // D24: the last check before anything is typed
  if (await isPaused(repos, ready.ctx.scope.ownerId, run.project_id)) return;
  const count = await repos.automationRuns.bump(run.id, 'resume_count');
  await (deps.type ?? defaultType)(ready.ctx, tab.id, serverMessage(RESUME_TEXT));
  await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'run_resumed', payload: { tab_id: tab.id, count } }).catch((e: unknown) =>
    log.warn({ runId: run.id, code: errorCode(e) }, 'automation: run_resumed not recorded'),
  );
  log.info({ runId: run.id, tabId: tab.id, count }, 'automation: run resumed');
}

/** The agent exited without a hook (`idle` with AGENT_EXITED_TEXT): restart it once in the same tab. */
async function onExited(deps: FollowerDeps, run: AutomationRun, tab: Tab, log: Log): Promise<void> {
  const { repos } = deps;
  const pr = await openPrOfRun(repos, run);
  if (pr) {
    await finishDone(repos, run, 'pull_request', pr, log);
    return;
  }
  const ready = await mayType(deps, run, log);
  if (!ready) return;
  if (run.restart_count >= MAX_RESTARTS) {
    await finishBlocked(repos, run, 'agent_exited', null, log);
    return;
  }
  const machine = await repos.machines.findById(tab.machine_id);
  if (!machine) return;
  // the same tab, the same session, the run's permission profile (preflight F-12)
  const line = await (deps.restartLine ?? resumeCommandFor)(repos, tab, machine, {
    permission: automationPermission(ready.setup.automation),
    prompt: serverMessage(EXITED_RESUME_PROMPT),
  });
  if (await isPaused(repos, ready.ctx.scope.ownerId, run.project_id)) return;
  const count = await repos.automationRuns.bump(run.id, 'restart_count');
  await (deps.type ?? defaultType)(ready.ctx, tab.id, line);
  await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'run_resumed', payload: { tab_id: tab.id, restart: true, count } }).catch((e: unknown) =>
    log.warn({ runId: run.id, code: errorCode(e) }, 'automation: run_resumed not recorded'),
  );
  log.info({ runId: run.id, tabId: tab.id, machineId: machine.id }, 'automation: agent restarted');
}

/** One handler at a time per run, and each tab state acted on once (a hook may be delivered twice). A
 *  change that arrives while a follow still settles joins it: that follow reads the tab after it anyway. */
const chains = new Map<string, Promise<void>>();
const settling = new Map<string, Promise<void>>();
const actedOn = new Map<string, string>();

/**
 * Looks at the run's tab as it is now and does what its state asks (spec §8 step 6, D15, D17). Reads the
 * run and the tab from the database, so it works for a run this process started and for one it took over
 * from a silent instance. Only a `running` run driven by this instance is followed.
 */
export function followRun(deps: FollowerDeps, runId: string): Promise<void> {
  const log = deps.log ?? noopLog;
  const joined = settling.get(runId);
  if (joined) return joined;
  const prev = chains.get(runId) ?? Promise.resolve();
  const settle = deps.settleMs ?? SETTLE_MS;
  const next: Promise<void> = prev
    .then(async () => {
      if (settle > 0) await new Promise((r) => setTimeout(r, settle));
      settling.delete(runId);
      if (deps.lifecycle.draining) return;
      const run = await deps.repos.automationRuns.findById(runId);
      if (!run || run.status !== 'running' || run.claimed_by !== deps.instance || !run.tab_id) {
        actedOn.delete(runId);
        return;
      }
      const tab = await deps.repos.tabs.findById(run.tab_id);
      if (!tab?.state_at) return;
      const stopped = tab.state === 'waiting_input';
      const exited = tab.state === 'idle' && tab.state_text === AGENT_EXITED_TEXT;
      // `working` and `waiting_background` (lesson TER-615) are the agent's own time; permissions are Task 22's
      if (!stopped && !exited) return;
      const key = `${tab.state}@${tab.state_at}`;
      if (actedOn.get(runId) === key) return;
      actedOn.set(runId, key);
      if (stopped) await onStopped(deps, run, tab, log);
      else await onExited(deps, run, tab, log);
    })
    .catch((e: unknown) => log.warn({ runId, code: errorCode(e) }, 'automation: follow failed'))
    .finally(() => {
      if (settling.get(runId) === next) settling.delete(runId);
      if (chains.get(runId) === next) chains.delete(runId);
    });
  chains.set(runId, next);
  settling.set(runId, next);
  return next;
}

/** A tab's state changed: when it carries an active run, follow it. */
export async function onTabChange(deps: FollowerDeps, change: TabStateChange): Promise<void> {
  if (deps.lifecycle.draining) return;
  const run = await deps.repos.automationRuns.activeByTab(change.tab.id);
  if (!run || run.status !== 'running' || run.claimed_by !== deps.instance) return;
  await followRun(deps, run.id);
}

/** Subscribes the follower to the monitor's state changes; returns the unsubscribe. */
export function startFollower(deps: FollowerDeps): () => void {
  const log = deps.log ?? noopLog;
  return monitorBus.subscribe((change) => {
    void onTabChange(deps, change).catch((e: unknown) => log.warn({ tabId: change.tab.id, code: errorCode(e) }, 'automation: follower failed'));
  });
}

/** The active run of the calling tab token's tab, or null (another tab's token, no run). */
async function runOfTabToken(ctx: ControlContext): Promise<AutomationRun | null> {
  const tab = ctx.token?.tab;
  if (!tab) return null;
  const run = await ctx.repos.automationRuns.activeByTab(tab.id);
  return run && run.project_id === tab.project_id ? run : null;
}

/**
 * Whether this call comes from an agent tab with an active automatic run: the condition of the tab tools
 * `report_card` and `get_card` (preflight F-8). Fails closed.
 */
export async function tabHasActiveRun(ctx: ControlContext): Promise<boolean> {
  return (await runOfTabToken(ctx).catch(() => null)) !== null;
}

/**
 * The tab tool `report_card` (spec D17): the agent ends its own run. `done` (with the PR URL) leaves the
 * card where the agent put it; `blocked` (with the reason) ends the run and escalates it.
 */
export async function reportCard(ctx: ControlContext, i: { status: 'done' | 'blocked'; pr_url?: string; reason?: string }): Promise<{ ok: true }> {
  const run = await runOfTabToken(ctx);
  if (!run) throw new ControlError('NO_RUN', msg('Esta aba não tem trabalho automático em andamento'));
  const log = ctx.log ?? noopLog;
  const ended =
    i.status === 'done'
      ? await finishDone(ctx.repos, run, 'report_card', i.pr_url ? { url: i.pr_url } : null, log)
      : await finishBlocked(ctx.repos, run, 'reported_blocked', i.reason ?? null, log);
  // another instance took the run over between the read and the write: the agent may simply call again
  if (!ended) throw new ControlError('RUN_MOVED', msg('O trabalho automático desta aba mudou de instância; chame report_card de novo'));
  return { ok: true };
}

/** The tab tool `get_card` (preflight F-8): the run's own card, read-only, with its subtasks and branch. */
export async function getRunCard(ctx: ControlContext): Promise<TaskOut & { branch: string | null; subtasks: Array<{ ref: string; title: string; status: string }> }> {
  const run = await runOfTabToken(ctx);
  const task = run?.task_id ? await ctx.repos.tasks.findById(run.task_id) : undefined;
  if (!run || !task) throw new ControlError('NO_RUN', msg('Esta aba não tem trabalho automático em andamento'));
  const subtasks = await ctx.repos.tasks.findByIds(await ctx.repos.tasks.childIds(task.id));
  return { ...taskOut(task), branch: run.branch, subtasks: subtasks.map((s) => ({ ref: s.ref, title: s.title, status: s.status })) };
}
