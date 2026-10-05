import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { DEFAULT_AUTOMATION_TOOLS, type startAgent as startAgentFn } from '../control/agents.js';
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
import { implementerPrompt } from './prompts.js';
import { eligibilityQueue } from './queue.js';

/** Spec D11: a tick every 15 s, plus one shortly after a relevant event. */
export const TICK_MS = 15_000;
export const TRIGGER_DEBOUNCE_MS = 1_000;
/** Spec §8 step 7: heartbeats every 30 s; a run silent for 2 min is taken over by another instance. */
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 2 * 60_000;
/** A card whose start failed is not tried again by this process for this long (a restart clears it). */
export const RETRY_BACKOFF_MS = 10 * 60_000;
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
  /** Escape in a tab ("Pausar e interromper"); default: the tab's own session. */
  pressEscape?: PressEscape;
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
  const backoff = new Map<string, number>();
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

  /** Prepare and start one claimed run (spec §8 steps 4–5). Any failure ends the run `failed` with its code. */
  async function launch(ctx: ControlContext, project: Project, setup: ProjectSetupData, run: AutomationRun, task: Task, place: Extract<Placement, { machine: unknown }>): Promise<void> {
    const { automation, repo, runner } = setup;
    try {
      const epic = task.epic_id ? await repos.tasks.findById(task.epic_id) : undefined;
      const { base, epicBranch } = targetOf({ epic: epic ? { auto: epic.auto, ref: epic.ref, title: epic.title } : null }, setup);
      const branch = cardBranchName(repo?.branch_pattern ?? '{ticket}-{slug}', task);
      if (!(await write(run, { status: 'starting', machine_id: place.machine.id, account_id: place.account.id, branch }))) return;
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
      // D24: the last check before anything is typed. The worktree stays; the next claim reuses it.
      if (halted() || (await isPaused(repos, project.owner_id, project.id))) {
        await release(run);
        return;
      }
      const started = await deps.startAgent(
        ctx,
        { project_id: project.id, machine_id: place.machine.id, account_id: place.account.id, task_id: task.id, prompt },
        // setup command only from the project's runner, cwd only from the run's worktree (Task 14 rule)
        { cwd: ws.path, permission: { mode: 'acceptEdits', allowedTools: automation.allowed_tools ?? DEFAULT_AUTOMATION_TOOLS }, setupCommand: runner.setup_command, promptIsFinal: true },
      );
      if (!(await write(run, { status: 'running', tab_id: started.tab_id, started_at: deps.now() }))) return;
      await recordEvent(repos, {
        project_id: project.id,
        task_id: task.id,
        run_id: run.id,
        kind: 'run_started',
        payload: { tab_id: started.tab_id, machine_id: place.machine.id, account_id: place.account.id, branch },
      });
      log.info({ runId: run.id, taskId: task.id, tabId: started.tab_id, machineId: place.machine.id }, 'automation: run started');
    } catch (e) {
      const code = errorCode(e);
      backoff.set(task.id, deps.now().getTime() + RETRY_BACKOFF_MS);
      log.warn({ runId: run.id, taskId: task.id, machineId: place.machine.id, code }, 'automation: start failed');
      try {
        if (await write(run, { status: 'failed', waiting_reason: code, ended_at: deps.now() })) {
          await recordEvent(repos, { project_id: project.id, task_id: task.id, run_id: run.id, kind: 'run_blocked', payload: { code, stage: 'start' } });
        }
      } catch (err) {
        log.warn({ runId: run.id, err: err instanceof Error ? err.message : String(err) }, 'automation: could not record the failed start');
      }
    }
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
    const now = () => deps.now().getTime();

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]!;
      if (halted()) return;
      if ((backoff.get(item.task_id) ?? 0) > now()) continue;
      if (starting.has(item.task_id)) continue;
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

  async function passOnce(): Promise<void> {
    if (halted()) return;
    await sweep();
    const projects = await repos.projectSetup.listWithAutomation();
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
