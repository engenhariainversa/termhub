import type { AiAccountUsage } from '../ai/index.js';
import { AGENT_EXITED_TEXT, EXITED_RESUME_PROMPT, resumeCommandFor } from '../chat/agent-exited.js';
import { isAccountSwapState } from '../control/account-swap.js';
import { controlContextFor, ControlError, type ControlContext } from '../control/context.js';
import { taskOut, type TaskOut } from '../control/tasks.js';
import { sendInput } from '../control/terminals.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun, AutomationRunPatch } from '../db/repositories/automation-runs.js';
import type { Tab, Task } from '../db/repositories/types.js';
import { DEFAULT_LOCALE, msg, t, tk, type Locale } from '../i18n/index.js';
import { monitorBus, type TabStateChange } from '../monitor/bus.js';
import { CI_POLL_MS } from '../ci/scheduler.js';
import { RATE_LIMIT_TEXT } from '../monitor/state.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { automationBus, recordEvent } from './events.js';
import { isPaused } from './pause.js';
import { runPermission } from './permission.js';
import { RESUME_TEXT, serverMessage } from './prompts.js';
import { MAX_RESTARTS } from './restart.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export { MAX_RESTARTS };

/**
 * How long a stop is left alone before it is resumed (or escalated, or restarted): long enough for the CI
 * sync (every CI_POLL_MS) to link a PR the agent opened right before it stopped, so the PR fallback (D17)
 * ends the run instead of a resume being typed into a finished one.
 */
export const PR_GRACE_MS = CI_POLL_MS + 30_000;
/** How often the follower looks again at every run this instance drives (a stop that waited, a pause
 *  lifted, a PR linked later, a failed attempt). */
export const FOLLOW_SWEEP_MS = 30_000;
/** A message typed into a tab whose state then never moved is typed again after this long (it got lost). */
export const RETYPE_AFTER_MS = 10 * 60_000;
/**
 * Claude's "trust this folder" question comes before any hook (a first start in a new worktree) or right
 * after an account swap (trust is per account). Its answer is the person's: past this long the run is
 * parked for them instead of being typed into.
 */
export const TRUST_WAIT_MS = 3 * 60_000;
/** `automation_runs.waiting_reason` of a run parked on something only a person can do in the tab. */
export const NEEDS_PERSON = 'needs_person';
/** The escalation reason of a run parked on the trust question. */
export const TRUST_PROMPT = 'trust_prompt';
/** The escalation reason of a run whose tab asks a question nothing automatic could answer (spec D18 step 4). */
export const QUESTION_UNANSWERED = 'question_unanswered';
/** The escalation reason of a run whose question card closed without an answer while the tab still asks it. */
export const QUESTION_EXPIRED = 'question_expired';
/** The escalation reason of a run whose questions were answered automatically too often in the last hour. */
export const ANSWER_CAP = 'answer_cap';
/** A permission request the project's rules do not allow (spec §9.2): the person answers it on the card. */
export const PERMISSION_NEEDED = 'permission_needed';
/**
 * How long an open question card of an automatic tab may wait with no countdown before the person is
 * called: the woken chat had this long to answer it (spec D18 step 3 → 4).
 */
export const QUESTION_WAIT_MS = 10 * 60_000;

/** The text the feed and the escalation show for each escalation reason known so far (spec §9.3). */
export const ESCALATION_TEXT: Record<string, string> = {
  [TRUST_PROMPT]: tk('O agente parou na confirmação de confiança da pasta; confirme na aba para continuar.'),
  [QUESTION_UNANSWERED]: tk('O agente fez uma pergunta que o modo automático não soube responder; responda no card.'),
  [QUESTION_EXPIRED]: tk('O card da pergunta do agente fechou sem resposta; responda na aba para continuar.'),
  [ANSWER_CAP]: tk('O agente fez perguntas demais respondidas automaticamente na última hora; confira a aba e responda no card.'),
  [PERMISSION_NEEDED]: tk('O agente pediu uma permissão que as regras do projeto não liberam; responda no card.'),
};

/** The escalation's text in the reader's language; null for a reason with no text yet. */
export function escalationText(reason: string, locale: Locale = DEFAULT_LOCALE): string | null {
  const key = ESCALATION_TEXT[reason];
  return key ? t(locale, key) : null;
}

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
  /** A stop on a usage limit (spec D16): `onRateLimit` (quota.ts), wired in app.ts. Called again on every
   *  look at the run while the tab stays on the limit, so it must be idempotent. */
  onRateLimited?: (run: AutomationRun, tab: Tab) => Promise<void>;
  /** The account's usage, for the reset a limited account waits for. Default: `getAccountUsage`, refreshed. */
  accountUsage?: (accountId: string) => Promise<AiAccountUsage | null>;
  /** The clock (tests). */
  now?: () => Date;
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

export const defaultType = async (ctx: ControlContext, tabId: string, text: string): Promise<void> => {
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
 * The tab waits on Claude's trust question (spec §9.3): the run is parked for the person — nothing is typed
 * into the tab — and given back to the follower once the tab reports a state of its own again.
 */
async function parkForTrust(repos: Repositories, run: AutomationRun, log: Log): Promise<void> {
  if (!(await writeRun(repos, run, { status: 'waiting', waiting_reason: NEEDS_PERSON }))) return;
  log.info({ runId: run.id, taskId: run.task_id, tabId: run.tab_id }, 'automation: run waits on the trust question');
  await escalateRun(repos, run, TRUST_PROMPT, log);
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
export async function mayType(deps: FollowerDeps, run: AutomationRun, log: Log): Promise<{ ctx: ControlContext; setup: ProjectSetupData; task: Task } | null> {
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

/** Milliseconds since `at` (an ISO string or a date); NaN when unknown. */
const sinceMs = (deps: FollowerDeps, at: string | Date | null | undefined) => (deps.now?.() ?? new Date()).getTime() - (at instanceof Date ? at.getTime() : Date.parse(at ?? ''));

/** Whether the stop is younger than PR_GRACE_MS: a PR opened just before it may not be linked yet. */
const inGrace = (deps: FollowerDeps, tab: Tab) => sinceMs(deps, tab.state_at) < PR_GRACE_MS;

/**
 * `waiting_input` after a Stop (preflight F-13): end on an open PR, resume, or hand over past the cap.
 * Returns true when something was typed into the tab; every other outcome is looked at again later.
 */
async function onStopped(deps: FollowerDeps, run: AutomationRun, tab: Tab, log: Log): Promise<boolean> {
  const { repos } = deps;
  // a usage limit first: never resume into it (D16, Task 19)
  if (rateLimited(tab)) {
    await deps.onRateLimited?.(run, tab);
    return false;
  }
  // after an account swap the resumed session may wait on the trust question: never typed into (an Enter
  // would answer it for the person); past TRUST_WAIT_MS the run is parked for them
  if (isAccountSwapState(tab.state_text)) {
    if (sinceMs(deps, tab.state_at) >= TRUST_WAIT_MS) await parkForTrust(repos, run, log);
    return false;
  }
  // a question card waits for its own answer (spec §9.1, Task 21)
  if (await repos.tabQuestions.hasOpenQuestion(tab.id)) return false;
  const pr = await openPrOfRun(repos, run);
  if (pr) {
    await finishDone(repos, run, 'pull_request', pr, log);
    return false;
  }
  if (inGrace(deps, tab)) return false;
  const ready = await mayType(deps, run, log);
  if (!ready) return false;
  if (run.resume_count >= ready.setup.automation.resume_max) {
    await wakeOrEscalate(repos, run, 'resume_cap', log);
    return false;
  }
  // D24: the last check before anything is typed
  if (await isPaused(repos, ready.ctx.scope.ownerId, run.project_id)) return false;
  const count = await repos.automationRuns.bump(run.id, 'resume_count');
  await (deps.type ?? defaultType)(ready.ctx, tab.id, serverMessage(RESUME_TEXT));
  await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'run_resumed', payload: { tab_id: tab.id, count } }).catch((e: unknown) =>
    log.warn({ runId: run.id, code: errorCode(e) }, 'automation: run_resumed not recorded'),
  );
  log.info({ runId: run.id, tabId: tab.id, count }, 'automation: run resumed');
  return true;
}

/** The agent exited without a hook (`idle` with AGENT_EXITED_TEXT): restart it once in the same tab.
 *  Returns true when the restart line was typed. */
async function onExited(deps: FollowerDeps, run: AutomationRun, tab: Tab, log: Log): Promise<boolean> {
  const { repos } = deps;
  const pr = await openPrOfRun(repos, run);
  if (pr) {
    await finishDone(repos, run, 'pull_request', pr, log);
    return false;
  }
  if (inGrace(deps, tab)) return false;
  const ready = await mayType(deps, run, log);
  if (!ready) return false;
  if (run.restart_count >= MAX_RESTARTS) {
    await finishBlocked(repos, run, 'agent_exited', null, log);
    return false;
  }
  const machine = await repos.machines.findById(tab.machine_id);
  if (!machine) return false;
  // the same tab, the same session, the profile the run started with (preflight F-12)
  const line = await (deps.restartLine ?? resumeCommandFor)(repos, tab, machine, {
    permission: await runPermission(repos, run),
    prompt: serverMessage(EXITED_RESUME_PROMPT),
  });
  if (await isPaused(repos, ready.ctx.scope.ownerId, run.project_id)) return false;
  const count = await repos.automationRuns.bump(run.id, 'restart_count');
  await (deps.type ?? defaultType)(ready.ctx, tab.id, line);
  await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'run_resumed', payload: { tab_id: tab.id, restart: true, count } }).catch((e: unknown) =>
    log.warn({ runId: run.id, code: errorCode(e) }, 'automation: run_resumed not recorded'),
  );
  log.info({ runId: run.id, tabId: tab.id, machineId: machine.id }, 'automation: agent restarted');
  return true;
}

/**
 * A question of the run's tab that automatic work left unanswered (spec §9.1, D18 step 4), escalated:
 * an open card whose countdown failed, or that waited QUESTION_WAIT_MS with no countdown at all (the woken
 * chat found nothing); or a card that closed `expired`/`failed` with the tab still showing it (no hook since
 * it closed, the agent neither exited nor moved on). A countdown running, or one the person cancelled (the
 * card is theirs now), is left alone. A `permission` card still open after QUESTION_WAIT_MS escalates as
 * PERMISSION_NEEDED (spec §9.2). True when the run was escalated.
 */
async function escalateUnansweredQuestion(deps: FollowerDeps, run: AutomationRun, tab: Tab, log: Log): Promise<boolean> {
  const q = await deps.repos.tabQuestions.latestQuestionForTab(tab.id);
  if (!q) return false;
  // a permission card nothing answered (automationPermission escalates at once; this catches one it never
  // reached: a pause when it opened, a crash, a send that failed silently) waits for the person too
  if (q.kind === 'permission') {
    if (q.status !== 'open' || sinceMs(deps, q.created_at) < QUESTION_WAIT_MS) return false;
    await wakeOrEscalate(deps.repos, run, PERMISSION_NEEDED, log);
    return true;
  }
  if (q.kind !== 'choice') return false;
  let reason: string | null = null;
  if (q.status === 'open') {
    const auto = q.auto_answer?.status;
    if (auto === 'failed' || (!auto && sinceMs(deps, q.created_at) >= QUESTION_WAIT_MS)) reason = QUESTION_UNANSWERED;
  } else if ((q.status === 'expired' || q.status === 'failed') && q.closed_at && (tab.state === 'waiting_input' || tab.state === 'working')) {
    if (Date.parse(tab.state_at ?? '') <= Date.parse(q.closed_at)) reason = QUESTION_EXPIRED;
  }
  if (!reason) return false;
  await wakeOrEscalate(deps.repos, run, reason, log);
  return true;
}

/** One handler at a time per run. A change that arrives while a follow still settles joins it: that follow
 *  reads the tab after it anyway. */
const chains = new Map<string, Promise<void>>();
const settling = new Map<string, Promise<void>>();

/**
 * Whether a line was typed into the tab after its current state was set and less than RETYPE_AFTER_MS ago:
 * the agent has not reacted yet, so the state is not acted on again (a hook delivered twice, a sweep before
 * the agent reacted). Read from the run (`last_typed_at`), not from memory, so the colour that takes a run
 * over knows what the other one typed. Only a typed line is recorded: every other outcome (a pause,
 * automation off, a stop in its grace, a failure) is looked at again by the next sweep.
 */
function typedSinceState(run: AutomationRun, tab: Tab, now: number): boolean {
  if (!run.last_typed_at) return false;
  const typedAt = run.last_typed_at.getTime();
  return typedAt >= Date.parse(tab.state_at ?? '') && now - typedAt < RETYPE_AFTER_MS;
}

/**
 * Looks at the run's tab as it is now and does what its state asks (spec §8 step 6, D15, D17). Reads the
 * run and the tab from the database, so it works for a run this process started and for one it took over
 * from a silent instance. Only runs driven by this instance are followed: a `running` one fully, a
 * `waiting` one (parked for a person) only for the PR fallback.
 */
export function followRun(deps: FollowerDeps, runId: string, opts: { settle?: boolean } = {}): Promise<void> {
  const log = deps.log ?? noopLog;
  const joined = settling.get(runId);
  if (joined) return joined;
  const prev = chains.get(runId) ?? Promise.resolve();
  const settle = opts.settle === false ? 0 : (deps.settleMs ?? SETTLE_MS);
  const next: Promise<void> = prev
    .then(async () => {
      if (settle > 0) await new Promise((r) => setTimeout(r, settle));
      settling.delete(runId);
      if (deps.lifecycle.draining) return;
      const run = await deps.repos.automationRuns.findById(runId);
      if (!run || (run.status !== 'running' && run.status !== 'waiting') || run.claimed_by !== deps.instance || !run.tab_id) return;
      const tab = await deps.repos.tabs.findById(run.tab_id);
      if (!tab) return;
      if (!tab.state_at) {
        // start watchdog: no hook at all since the start — Claude waits on the trust question of a new
        // worktree (it comes before any hook). Parked for the person, never typed into.
        if (run.status === 'running' && sinceMs(deps, run.started_at ?? run.created_at) >= TRUST_WAIT_MS) await parkForTrust(deps.repos, run, log);
        return;
      }
      if (run.status === 'waiting' && run.waiting_reason === NEEDS_PERSON && !isAccountSwapState(tab.state_text)) {
        // the person answered: the tab reports its own state again, and the run is followed as before
        if (!(await writeRun(deps.repos, run, { status: 'running', waiting_reason: null }))) return;
        log.info({ runId, tabId: tab.id }, 'automation: run followed again after the trust question');
        run.status = 'running';
        run.waiting_reason = null;
      }
      // a question nothing automatic answered goes to the person, whatever the tab shows meanwhile (a
      // Claude question leaves the tab `working` until its notification)
      if (run.status === 'running' && (await escalateUnansweredQuestion(deps, run, tab, log))) return;
      // `working` and `waiting_background` (lesson TER-615) are the agent's own time
      if (tab.state === 'working' || tab.state === 'waiting_background') return;
      if (run.status === 'waiting') {
        // D17 in the other order: the PR was linked after the run was parked
        const pr = await openPrOfRun(deps.repos, run);
        if (pr) await finishDone(deps.repos, run, 'pull_request', pr, log);
        return;
      }
      const stopped = tab.state === 'waiting_input';
      const exited = tab.state === 'idle' && tab.state_text === AGENT_EXITED_TEXT;
      // a permission prompt is automationPermission's (answers.ts), or escalated above once it waited too long
      if (!stopped && !exited) return;
      // taken before anything is typed: a state the agent reaches in reaction is always newer than it
      const now = deps.now?.() ?? new Date();
      if (typedSinceState(run, tab, now.getTime())) return;
      const typed = stopped ? await onStopped(deps, run, tab, log) : await onExited(deps, run, tab, log);
      if (typed) await deps.repos.automationRuns.noteTyped(run.id, now);
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

/** One look at every `running` or `waiting` run this instance drives. */
export async function sweepRuns(deps: FollowerDeps): Promise<void> {
  if (deps.lifecycle.draining) return;
  const runs = await deps.repos.automationRuns.followedBy(deps.instance);
  await Promise.all(runs.map((r) => followRun(deps, r.id, { settle: false })));
}

/** A tab's state changed: when it carries an active run, follow it. */
export async function onTabChange(deps: FollowerDeps, change: TabStateChange): Promise<void> {
  if (deps.lifecycle.draining) return;
  const run = await deps.repos.automationRuns.activeByTab(change.tab.id);
  if (!run || (run.status !== 'running' && run.status !== 'waiting') || run.claimed_by !== deps.instance) return;
  await followRun(deps, run.id);
}

/**
 * Subscribes the follower to the monitor's state changes, looks at its runs again every FOLLOW_SWEEP_MS
 * and as soon as a pause is lifted (D24: a stop seen while paused is resumed afterwards). Returns the stop.
 */
export function startFollower(deps: FollowerDeps, opts: { sweepMs?: number } = {}): () => void {
  const log = deps.log ?? noopLog;
  const sweep = () => void sweepRuns(deps).catch((e: unknown) => log.warn({ code: errorCode(e) }, 'automation: follower sweep failed'));
  const offTabs = monitorBus.subscribe((change) => {
    void onTabChange(deps, change).catch((e: unknown) => log.warn({ tabId: change.tab.id, code: errorCode(e) }, 'automation: follower failed'));
  });
  const offEvents = automationBus.subscribe((e) => (e.kind === 'resumed' ? sweep() : undefined));
  const timer = setInterval(sweep, opts.sweepMs ?? FOLLOW_SWEEP_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    offTabs();
    offEvents();
  };
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
  if (i.status === 'blocked' && !i.reason?.trim()) throw new ControlError('REASON_REQUIRED', msg('Diga em reason por que o trabalho travou'));
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
