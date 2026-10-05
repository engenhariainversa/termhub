import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { tabIdOfError, type startAgent as startAgentFn } from '../control/agents.js';
import { closeTab as closeTabFn } from '../control/terminals.js';
import { controlContextFor, ControlError, type ControlContext } from '../control/context.js';
import { cardUrl } from '../control/tasks.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun, AutomationRunPatch } from '../db/repositories/automation-runs.js';
import type { Project, Task } from '../db/repositories/types.js';
import { msg } from '../i18n/index.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { cardBranchName, removeWorkspace as removeWorkspaceFn, targetOf, type ensureEpicBranch as ensureEpicBranchFn, type ensureWorkspace as ensureWorkspaceFn } from './branches.js';
import { automationBus, dispatchTriggers, recordEvent } from './events.js';
import { interruptRuns, isPaused, type PressEscape } from './pause.js';
import { clearWaiting, noteWaiting, placeRun, type Placement } from './placement.js';
import { policyText } from './policy.js';
import { automationPermission } from './permission.js';
import { implementerPrompt } from './prompts.js';
import { eligibilityQueue } from './queue.js';

/** Spec D11: a tick every 15 s, plus one shortly after a relevant event. */
export const TICK_MS = 15_000;
export const TRIGGER_DEBOUNCE_MS = 1_000;
/** Spec §8 step 7: heartbeats every 30 s; a run silent for 2 min is taken over by another instance. */
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 2 * 60_000;
/** A card whose start failed is not tried again for this long (read from the runs table: both colours keep it). */
export const RETRY_BACKOFF_MS = 10 * 60_000;
/** Failed starts in a row after which the card's tag is removed until a person tags it again. */
export const MAX_START_FAILURES = 3;
/** How long `stop()` waits for starts in flight before letting the process close. */
const STOP_WAIT_MS = 10_000;

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export interface DispatcherDeps {
  repos: Repositories;
  /** Unique per process (`dispatcherInstanceId`): runs are claimed, heartbeated and written under it. */
  instance: string;
  lifecycle: { readonly draining: boolean };
  now(): Date;
  startAgent: typeof startAgentFn;
  ensureWorkspace: typeof ensureWorkspaceFn;
  ensureEpicBranch: typeof ensureEpicBranchFn;
  gh: GithubWriteClient;
  /** Peak utilization of the account in percent, from `getAccountUsage`; null = unknown. */
  usage: (accountId: string) => Promise<number | null>;
  removeWorkspace?: typeof removeWorkspaceFn;
  /** Closes a tab a failed start left open with nothing running; default: `closeTab` as the owner. */
  closeTab?: (ctx: ControlContext, tabId: string) => Promise<void>;
  /** Escape in a tab ("Pausar e interromper"); default: the tab's own session. */
  pressEscape?: PressEscape;
  /** Told of each running run this instance took over from a silent one: the follower looks at its tab now
   *  (a stop that happened while nobody followed the run would otherwise wait for the next state change). */
  onTakeOver?: (run: AutomationRun) => void;
  /** After expired exhaustions are cleared on a tick: resumes the runs whose account's usage reset (spec D16,
   *  `resumeAfterReset`). */
  resumeQuota?: () => Promise<void>;
  log?: Log;
}

export interface Dispatcher {
  /** One pass over every project with automatic work on. Concurrent calls share the pass in progress. */
  tick(reason: string): Promise<void>;
  /** Heartbeat of this instance's runs, then the takeover of runs whose instance went silent. */
  heartbeat(): Promise<void>;
  /** Resolves when the starts in flight have settled (tests, shutdown). */
  settle(): Promise<void>;
  /** Stops the timers and waits (bounded) for the starts in flight. */
  stop(): Promise<void>;
}

/** Colour-independent and unique per process: the host, the pid and a random part (two colours never share it). */
export function dispatcherInstanceId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

const noopLog: Log = { info: () => {}, warn: () => {} };

/** The error's code for the run row and the event: a code, never a message (which may quote a screen). */
function errorCode(e: unknown): string {
  const o = e as { code?: unknown; kind?: unknown };
  const code = typeof o?.code === 'string' ? o.code : typeof o?.kind === 'string' ? `GITHUB_${o.kind.toUpperCase()}` : 'INTERNAL';
  return code.slice(0, 64);
}

/**
 * The automation dispatcher (spec §8, D11–D14, D24). On each tick, for every project with automatic work
 * on and not paused, it walks the eligible cards in board order and, while `max_parallel` has room,
 * claims a card (one active run per card, enforced by the database), finds it a place, prepares the
 * branch and worktree and starts the agent as the project's owner. Nothing here touches a project whose
 * automation is off: the only projects read are those `listWithAutomation` returns.
 */
export function startDispatcher(deps: DispatcherDeps, opts: { tickMs?: number; heartbeatMs?: number; schedule?: boolean } = {}): Dispatcher {
  const { repos, instance } = deps;
  const log = deps.log ?? noopLog;
  const removeWorkspace = deps.removeWorkspace ?? removeWorkspaceFn;
  const closeTab = deps.closeTab ?? (async (ctx: ControlContext, tabId: string) => void (await closeTabFn(ctx, { tab_id: tabId, force: true })));
  const inflight = new Set<Promise<void>>();
  const starting = new Set<string>();
  let stopped = false;
  let pass: Promise<void> | null = null;
  let again = false;
  let startupDone = false;

  const write = (run: AutomationRun, patch: AutomationRunPatch) => repos.automationRuns.update(run.id, instance, patch);
  const release = (run: AutomationRun) => repos.automationRuns.release(run.id, instance);
  const halted = () => stopped || deps.lifecycle.draining;

  /** F-23 (spec §13): after the claim, the card must still be what the queue said — or the claim is let go. */
  async function stillWanted(taskId: string, projectId: string): Promise<{ task: Task; setup: ProjectSetupData } | null> {
    const [task, setup] = await Promise.all([repos.tasks.findById(taskId), repos.projectSetup.get(projectId)]);
    if (!task || task.project_id !== projectId || !task.auto || task.parent_id !== null || !task.column_id) return null;
    const column = await repos.taskColumns.findById(task.column_id);
    if (column?.category !== 'todo' || !setup.data.automation.enabled) return null;
    return { task, setup: setup.data };
  }

  /** The project's GitHub token, under the same rule as the CI sync: a GitHub integration of the project's owner. */
  async function githubToken(project: Project, setup: ProjectSetupData): Promise<{ token: string; repo: string }> {
    const repo = setup.repo;
    const integration = repo?.integration_id ? await repos.integrations.findById(repo.integration_id) : undefined;
    const allowed = !!repo?.full_name && !!integration && integration.provider === 'github' && project.owner_id !== null && integration.owner_id === project.owner_id;
    const token = allowed ? await repos.integrations.getSecret(integration.id) : undefined;
    if (!token || !repo?.full_name) throw new ControlError('GITHUB_NO_ACCESS', msg('Integração do GitHub sem acesso'));
    return { token, repo: repo.full_name };
  }

  /** The run is live in `tabId`: write it, then tell the feed (best effort: a lost event never turns a live run into a failed one). */
  async function markRunning(project: Project, run: AutomationRun, task: Task, place: Extract<Placement, { machine: unknown }>, tabId: string, branch: string, linked: boolean): Promise<void> {
    let wrote: boolean;
    try {
      wrote = await write(run, { status: 'running', tab_id: tabId, started_at: deps.now() });
    } catch (e) {
      log.warn({ runId: run.id, taskId: task.id, tabId, code: errorCode(e) }, 'automation: run started but its row was not updated');
      return;
    }
    if (!wrote) {
      log.warn({ runId: run.id, taskId: task.id, tabId }, 'automation: run taken over by another instance while it started');
      return;
    }
    await recordEvent(repos, {
      project_id: project.id,
      task_id: task.id,
      run_id: run.id,
      kind: 'run_started',
      payload: { tab_id: tabId, machine_id: place.machine.id, account_id: place.account.id, branch, ...(linked ? {} : { card_linked: false }) },
    }).catch((e: unknown) => log.warn({ runId: run.id, code: errorCode(e) }, 'automation: run_started not recorded'));
    log.info({ runId: run.id, taskId: task.id, tabId, machineId: place.machine.id, linked }, 'automation: run started');
  }

  /**
   * A start that failed. When the agent is already running (`TASK_LINK_FAILED`: only the card link failed)
   * the run stays active with its tab, so the card is never claimed twice and the pause still reaches it.
   * Otherwise a tab left open with nothing in it is closed, the run ends `failed` (its code and tab kept),
   * and after `MAX_START_FAILURES` failed starts in a row the card's tag is removed: a person tags it again
   * once the cause is fixed. The wait between attempts is read from the database, so both colours keep it.
   */
  async function startFailed(ctx: ControlContext, project: Project, run: AutomationRun, task: Task, place: Extract<Placement, { machine: unknown }>, branch: string | null, e: unknown): Promise<void> {
    const code = errorCode(e);
    const tabId = tabIdOfError(e);
    if (tabId && code === 'TASK_LINK_FAILED') {
      log.warn({ runId: run.id, taskId: task.id, tabId }, 'automation: agent started but the card was not linked');
      await markRunning(project, run, task, place, tabId, branch ?? '', false);
      return;
    }
    log.warn({ runId: run.id, taskId: task.id, machineId: place.machine.id, tabId, code }, 'automation: start failed');
    if (tabId) {
      await closeTab(ctx, tabId).catch((err: unknown) => log.warn({ runId: run.id, tabId, code: errorCode(err) }, 'automation: tab of a failed start not closed'));
    }
    try {
      if (!(await write(run, { status: 'failed', waiting_reason: code, ended_at: deps.now(), ...(tabId ? { tab_id: tabId } : {}) }))) return;
    } catch (err) {
      log.warn({ runId: run.id, code: errorCode(err) }, 'automation: failed start not recorded');
      return;
    }
    await recordEvent(repos, { project_id: project.id, task_id: task.id, run_id: run.id, kind: 'run_blocked', payload: { code, stage: 'start' } }).catch((err: unknown) =>
      log.warn({ runId: run.id, code: errorCode(err) }, 'automation: run_blocked not recorded'),
    );
    try {
      const { consecutive } = await repos.automationRuns.startFailures(task.id, RETRY_BACKOFF_MS);
      if (consecutive >= MAX_START_FAILURES) {
        await repos.tasks.setAuto(task.id, false);
        await recordEvent(repos, { project_id: project.id, task_id: task.id, run_id: run.id, kind: 'escalated', payload: { reason: 'start_failed', attempts: consecutive, code, untagged: true } });
        log.warn({ runId: run.id, taskId: task.id, attempts: consecutive }, 'automation: card untagged after failed starts');
      }
    } catch (err) {
      log.warn({ runId: run.id, taskId: task.id, code: errorCode(err) }, 'automation: start failure cap not applied');
    }
  }

  /** Prepare and start one claimed run (spec §8 steps 4–5). Only the preparation and the start itself count as a failed start. */
  async function launch(ctx: ControlContext, project: Project, setup: ProjectSetupData, run: AutomationRun, task: Task, place: Extract<Placement, { machine: unknown }>): Promise<void> {
    const { automation, repo, runner } = setup;
    let branch: string | null = null;
    let tabId: string;
    try {
      const epic = task.epic_id ? await repos.tasks.findById(task.epic_id) : undefined;
      const { base, epicBranch } = targetOf({ epic: epic ? { auto: epic.auto, ref: epic.ref, title: epic.title } : null }, setup);
      branch = cardBranchName(repo?.branch_pattern ?? '{ticket}-{slug}', task);
      const permission = automationPermission(automation);
      // the profile is stored on the run: restarts and swaps keep it even if the setup changes (F-12)
      if (!(await write(run, { status: 'starting', machine_id: place.machine.id, account_id: place.account.id, branch, allowed_tools: permission.allowedTools }))) return;
      if (epicBranch) {
        const gh = await githubToken(project, setup);
        await deps.ensureEpicBranch({ gh: deps.gh, ...gh }, repo?.base_branch ?? 'main', epicBranch);
      }
      const ws = await deps.ensureWorkspace(place.machine, { repoDir: place.link.cwd, root: automation.worktrees_dir, projectId: project.id, ref: task.ref, branch, base });
      if (!(await write(run, { worktree_path: ws.path }))) return;
      const prompt = implementerPrompt({
        card: { ref: task.ref, url: cardUrl(task.ref), title: task.title },
        branch,
        base,
        policy: policyText(automation, repo?.deploy_workflow ?? null),
        custom: automation.prompts.implementer,
        description: task.description,
      });
      // the agent's questions become cards in the owner's project chat (spec §9.1, §9.3): make sure it
      // has one, or a question would have nowhere to go (review I1)
      if (project.owner_id) await repos.chat.getOrCreateForProject(project.owner_id, project.id);
      // D24: the last check before anything is typed. The worktree stays; the next claim reuses it.
      // (A pause landing while startAgent runs still lets this one prompt through: within D24's 5 s.)
      if (halted() || (await isPaused(repos, project.owner_id, project.id))) {
        await release(run);
        return;
      }
      const started = await deps.startAgent(
        ctx,
        { project_id: project.id, machine_id: place.machine.id, account_id: place.account.id, task_id: task.id, prompt },
        // setup command only from the project's runner, cwd only from the run's worktree (Task 14 rule)
        {
          cwd: ws.path,
          permission,
          setupCommand: runner.setup_command,
          promptIsFinal: true,
          // the run knows its tab before the agent starts: its tab MCP then lists report_card and get_card
          onTabOpened: async (id) => void (await write(run, { tab_id: id })),
        },
      );
      tabId = started.tab_id;
    } catch (e) {
      await startFailed(ctx, project, run, task, place, branch, e);
      return;
    }
    await markRunning(project, run, task, place, tabId, branch, true);
  }

  async function dispatchProject(projectId: string, enabledSetup: ProjectSetupData): Promise<void> {
    const project = await repos.projects.findById(projectId);
    if (!project?.owner_id) return;
    if (await isPaused(repos, project.owner_id, projectId)) return;
    const owner = await repos.users.findById(project.owner_id);
    if (!owner) return;
    // D12: automation acts as the project's owner.
    const ctx = controlContextFor(repos, owner);
    const queue = (await eligibilityQueue(ctx, projectId)).filter((i) => i.eligible);
    const max = enabledSetup.automation.max_parallel;

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]!;
      if (halted()) return;
      if (starting.has(item.task_id)) continue;
      // a failed start waits RETRY_BACKOFF_MS before the next attempt, on whichever colour (database clock)
      if ((await repos.automationRuns.startFailures(item.task_id, RETRY_BACKOFF_MS)).recent) continue;
      if (max !== null && (await repos.automationRuns.countActive(projectId)) >= max) return;
      // D24: a pause pressed during this pass stops the claims right here.
      if (await isPaused(repos, project.owner_id, projectId)) return;

      const run = await repos.automationRuns.claim({ project_id: projectId, task_id: item.task_id, role: 'implementer', instance });
      if (!run) continue; // already taken (the other colour, or a run still active)
      // Two instances counting at once may both fit under the ceiling: the one that sees it exceeded lets go.
      if (max !== null && (await repos.automationRuns.countActive(projectId)) > max) {
        await release(run);
        return;
      }
      const wanted = await stillWanted(item.task_id, projectId);
      if (!wanted) {
        await release(run);
        continue;
      }
      const place = await placeRun(deps, project, wanted.setup);
      if ('waiting' in place) {
        // No place now: the claim goes away and the card (and those after it, which would get the same
        // answer) shows why it waits. Not an error, and no event per tick.
        await release(run);
        for (const rest of queue.slice(i)) noteWaiting(rest.task_id, place.waiting, deps.now());
        return;
      }
      clearWaiting(item.task_id);
      starting.add(item.task_id);
      const p = launch(ctx, project, wanted.setup, run, wanted.task, place).finally(() => {
        starting.delete(item.task_id);
        inflight.delete(p);
      });
      inflight.add(p);
    }
  }

  /** Runs whose card was deleted are cancelled; their worktrees are removed when clean (spec §13). */
  async function sweep(): Promise<void> {
    for (const orphan of await repos.automationRuns.cancelOrphaned()) {
      if (!orphan.machine_id || !orphan.worktree_path) continue;
      try {
        const [machine, link, setup] = await Promise.all([
          repos.machines.findById(orphan.machine_id),
          repos.projectMachines.find(orphan.project_id, orphan.machine_id),
          repos.projectSetup.get(orphan.project_id),
        ]);
        if (!machine || !link) continue;
        const r = await removeWorkspace(machine, { repoDir: link.cwd, root: setup.data.automation.worktrees_dir, path: orphan.worktree_path });
        log.info({ runId: orphan.id, machineId: machine.id, removed: r.removed, dirty: r.dirty }, 'automation: worktree of a deleted card');
      } catch (e) {
        log.warn({ runId: orphan.id, machineId: orphan.machine_id, code: errorCode(e) }, 'automation: worktree of a deleted card not removed');
      }
    }
  }

  /**
   * A "Pausar e interromper" recorded while no instance could act on it (before this code shipped, or
   * while the instance that took it restarted): once per process start, tabs of a project whose latest
   * pause asked to interrupt and that are still in a turn get Escape.
   */
  async function interruptRecordedPauses(projects: { project_id: string }[]): Promise<void> {
    for (const { project_id } of projects) {
      const project = await repos.projects.findById(project_id);
      if (!project || !(await isPaused(repos, project.owner_id, project_id))) continue;
      if ((await repos.automationRuns.countActive(project_id)) === 0) continue;
      const events = await repos.automationEvents.listByProject(project_id, { limit: 50 });
      const last = events.find((e) => e.kind === 'paused' || e.kind === 'resumed');
      if (last?.kind !== 'paused' || last.payload.interrupt !== true) continue;
      const sent = await interruptRuns(repos, [project_id], { onlyWorking: true, press: deps.pressEscape, log });
      if (sent > 0) log.info({ projectId: project_id, tabs: sent }, 'automation: interrupted runs of a pause recorded earlier');
    }
  }

  /** Accounts whose usage reset are free again, and the runs that waited on them go on (spec D16). */
  async function quotaPass(): Promise<void> {
    try {
      const cleared = await repos.aiAccountExhaustions.clearExpired(deps.now());
      if (cleared.length > 0) log.info({ accounts: cleared.length }, 'automation: exhausted accounts cleared');
      await deps.resumeQuota?.();
    } catch (e) {
      log.warn({ code: errorCode(e) }, 'automation: quota pass failed');
    }
  }

  async function passOnce(): Promise<void> {
    if (halted()) return;
    await sweep();
    const projects = await repos.projectSetup.listWithAutomation();
    // D16: only automatic work marks accounts exhausted, so with no project on there is nothing to do
    if (projects.length > 0) await quotaPass();
    if (!startupDone) {
      startupDone = true;
      await interruptRecordedPauses(projects).catch((e: unknown) => log.warn({ code: errorCode(e) }, 'automation: startup interrupt failed'));
    }
    for (const { project_id, data } of projects) {
      if (halted()) return;
      try {
        await dispatchProject(project_id, data);
      } catch (e) {
        log.warn({ projectId: project_id, code: errorCode(e) }, 'automation: dispatch failed');
      }
    }
  }

  function tick(reason: string): Promise<void> {
    if (stopped) return Promise.resolve();
    if (pass) {
      again = true;
      return pass;
    }
    void reason;
    pass = (async () => {
      do {
        again = false;
        try {
          await passOnce();
        } catch (e) {
          log.warn({ code: errorCode(e) }, 'automation: tick failed');
        }
      } while (again && !halted());
    })().finally(() => {
      pass = null;
    });
    return pass;
  }

  async function heartbeat(): Promise<void> {
    await repos.automationRuns.heartbeat(instance);
    // A draining instance is on its way out: it keeps its own runs alive until it exits, but takes none.
    if (halted()) return;
    for (const run of await repos.automationRuns.takeOver(instance, STALE_MS)) {
      // A run that never got past starting has nobody starting it any more: free the card for a new claim.
      // A tab may exist if the instance died right after opening it; then the card left `todo` (and is
      // linked to the tab), so it is not claimed again.
      if (run.status === 'queued' || run.status === 'starting') {
        await release(run);
        log.info({ runId: run.id, taskId: run.task_id }, 'automation: released an unstarted run of a silent instance');
      } else {
        log.info({ runId: run.id, taskId: run.task_id, tabId: run.tab_id }, 'automation: took over a run');
        deps.onTakeOver?.(run);
      }
    }
  }

  async function settle(): Promise<void> {
    while (pass || inflight.size > 0) {
      if (pass) await pass;
      await Promise.allSettled([...inflight]);
    }
  }

  const timers: Array<ReturnType<typeof setInterval>> = [];
  const unsubscribe: Array<() => void> = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;
  if (opts.schedule !== false) {
    const poke = (reason: string) => {
      if (debounce || stopped) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        void tick(reason);
      }, TRIGGER_DEBOUNCE_MS);
      debounce.unref?.();
    };
    const every = setInterval(() => void tick('timer'), opts.tickMs ?? TICK_MS);
    const beat = setInterval(() => void heartbeat().catch((e: unknown) => log.warn({ code: errorCode(e) }, 'automation: heartbeat failed')), opts.heartbeatMs ?? HEARTBEAT_MS);
    every.unref?.();
    beat.unref?.();
    timers.push(every, beat);
    // a run that ended frees a slot; a lifted pause lets the queue go (D11)
    unsubscribe.push(automationBus.subscribe((e) => (e.kind === 'resumed' || e.kind === 'run_done' || e.kind === 'run_blocked' ? poke(e.kind) : undefined)));
    unsubscribe.push(dispatchTriggers.subscribe(poke));
    poke('boot');
  }

  return {
    tick,
    heartbeat,
    settle,
    async stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      clearTimeout(debounce);
      for (const off of unsubscribe) off();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settle(), new Promise<void>((r) => (timer = setTimeout(r, STOP_WAIT_MS)))]);
      clearTimeout(timer);
    },
  };
}
