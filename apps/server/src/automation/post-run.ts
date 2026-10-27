import { sanitisePromptText } from '../chat/tab-question-context.js';
import type { PostRunBlockWake, PostRunWaker } from '../chat/wake.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { recordEvent } from './events.js';
import { isPaused } from './pause.js';

/*
 * A tab whose automatic run already ended (TER-1112). The tab stays open with the hard-lock guard on, and the
 * person or the chat may still type into it; nothing followed it any more, so a block there reached nobody.
 * Here: a new prompt in such a tab reopens a run of its card (the follower and the guard's feed apply again),
 * and a block there is recorded against the tab's last run and wakes the project's chat.
 */

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/** The ended statuses a typed prompt reopens: a run that finished or was handed to the person. A cancelled run
 *  (its card untagged, its tab closed) or one that never started is left alone. */
const REOPENABLE: ReadonlySet<string> = new Set(['done', 'blocked']);

/** The tab's latest run when it already ended and belongs to the tab's project, or null (an active run, a tab
 *  that never ran automatic work). */
export async function endedRunOfTab(repos: Repositories, tab: Pick<Tab, 'id' | 'project_id'>): Promise<AutomationRun | null> {
  if (await repos.automationRuns.activeByTab(tab.id)) return null;
  const run = await repos.automationRuns.latestByTab(tab.id);
  return run && run.project_id === tab.project_id && run.task_id ? run : null;
}

/**
 * Whether a submitted prompt is a request someone typed: a slash command (`/clear`, `/compact`) or a prompt the
 * CLI queued itself (a background task's `<task-notification>`) is not, and reopens nothing. Read in memory
 * only; the prompt is never stored or logged.
 */
export function isTypedRequest(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false;
  const text = prompt.trimStart();
  return text.length > 0 && !text.startsWith('/') && !text.startsWith('<');
}

export interface ReopenDeps {
  repos: Repositories;
  /** this process's instance: it drives the reopened run, like a run it started */
  instance: string;
  lifecycle: { readonly draining: boolean };
  log?: Log;
  now?: () => Date;
}

/**
 * A prompt was typed into a tab whose run ended (TER-1112): a new run of the card takes the tab over, on the
 * same branch, worktree, account and allow list, already `running` (the prompt is on its way). The follower
 * then resumes, wakes or escalates it like any run, and the agent reports with `report_card` again. Recorded as
 * `run_resumed` (`reopened: true`). Nothing happens while draining, with the project's automation off or
 * paused, on a card that is gone, untagged or done, or when the card already has an active run (the claim is
 * the database's: two prompts at once reopen once). Null then. Never throws.
 */
export async function reopenRunInTab(deps: ReopenDeps, tab: Pick<Tab, 'id' | 'project_id' | 'machine_id' | 'ai_account_id'>): Promise<AutomationRun | null> {
  const { repos } = deps;
  const log = deps.log;
  try {
    if (deps.lifecycle.draining) return null;
    const prev = await endedRunOfTab(repos, tab);
    if (!prev?.task_id || !REOPENABLE.has(prev.status)) return null;
    const [project, setup, task] = await Promise.all([repos.projects.findById(prev.project_id), repos.projectSetup.get(prev.project_id), repos.tasks.findById(prev.task_id)]);
    if (!project?.owner_id || !setup.data.automation.enabled || !task || !task.auto || task.status === 'done') return null;
    if (await isPaused(repos, project.owner_id, project.id)) return null;
    const run = await repos.automationRuns.claim({ project_id: prev.project_id, task_id: prev.task_id, role: prev.role, instance: deps.instance });
    if (!run) return null;
    const at = deps.now?.() ?? new Date();
    const written = await repos.automationRuns.update(run.id, deps.instance, {
      status: 'running',
      tab_id: tab.id,
      machine_id: tab.machine_id,
      account_id: tab.ai_account_id ?? prev.account_id,
      branch: prev.branch,
      worktree_path: prev.worktree_path,
      allowed_tools: prev.allowed_tools ?? undefined,
      started_at: at,
    });
    if (!written) return null;
    // the stop that ends this prompt's turn is fresh, not an old one to resume at once
    await repos.automationRuns.noteTyped(run.id, at);
    await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'run_resumed', payload: { tab_id: tab.id, by: 'prompt', reopened: true, previous_run_id: prev.id } }).catch((e: unknown) =>
      log?.warn({ runId: run.id, code: codeOf(e) }, 'automation: run_resumed not recorded'),
    );
    log?.info({ runId: run.id, previousRunId: prev.id, taskId: run.task_id, tabId: tab.id }, 'automation: run reopened by a prompt in an ended tab');
    return { ...run, status: 'running', tab_id: tab.id, branch: prev.branch };
  } catch (e) {
    log?.warn({ tabId: tab.id, code: codeOf(e) }, 'automation: run not reopened');
    return null;
  }
}

/**
 * What the agent reads next to the prompt that reopened its run (the hook's `additionalContext`, like the
 * origin note): model-facing English. The card's title is data, sanitised and quoted.
 */
export function reopenedRunNote(run: Pick<AutomationRun, 'id' | 'branch'>, card: { ref: string; title: string }): string {
  return [
    `termhub automatic work note: this message reopened automatic work on card ${sanitisePromptText(card.ref)} («${sanitisePromptText(card.title)}»), run ${run.id}${run.branch ? `, on branch ${sanitisePromptText(run.branch)}` : ''}.`,
    "termhub follows this tab again and the project's automation policy applies.",
    'When this request is done, push to the same branch and call report_card: status done with the pull request URL, or blocked with the reason if you cannot go on.',
  ].join(' ');
}

/**
 * A block in a tab whose run ended (TER-1112): the guard stopped a tool, or the agent called `report_card
 * blocked`. Wakes the project's chat through the waker (its automation budget, and one wake per tab in a
 * while). False when nobody was woken. Never throws.
 */
export async function wakeForPostRunBlock(
  repos: Repositories,
  waker: PostRunWaker | undefined,
  run: AutomationRun,
  tab: Pick<Tab, 'id' | 'name'>,
  what: Pick<PostRunBlockWake, 'cause' | 'tool' | 'reason'>,
  log?: Log,
): Promise<boolean> {
  if (!waker || !run.task_id) return false;
  try {
    const [project, task] = await Promise.all([repos.projects.findById(run.project_id), repos.tasks.findById(run.task_id)]);
    // not held back by a pause (D24): the chat only tells the person, nothing is typed
    if (!project?.owner_id || !task) return false;
    const woke = await waker.wakeForPostRunBlock({ ownerId: project.owner_id, projectId: project.id, runId: run.id, tabId: tab.id, cardRef: task.ref, cardTitle: task.title, tabName: tab.name ?? null, ...what });
    log?.info({ runId: run.id, tabId: tab.id, cause: what.cause, woke }, 'automation: chat woken for a block after the run');
    return woke;
  } catch (e) {
    log?.warn({ runId: run.id, code: codeOf(e) }, 'automation: post-run block wake failed');
    return false;
  }
}

const codeOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code.slice(0, 64) : 'INTERNAL';
};
