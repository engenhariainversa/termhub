import type { FastifyBaseLogger } from 'fastify';
import { captureScreen } from '../agent/screen.js';
import { recordEvent } from '../automation/events.js';
import { showsTrustQuestion } from '../automation/trust.js';
import { failureLabel } from '../chat/service.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab, TabState } from '../db/repositories/types.js';
import { sendKeyToSession } from '../terminal/session-ops.js';
import { publishTabChange } from './ingest.js';
import { SCREEN_STATE_LINES, claudeScreenState } from './screen-state.js';
import { TRUST_PROMPT_TEXT } from './state.js';

/*
 * Claude Code's folder trust dialog in a project's own folder (TER-1117). A folder Claude Code never opened
 * (a project just linked, a new machine, an account that never ran there) stops on "Is this a project you
 * created or one you trust?" before any hook fires: the tab reported nothing, or `working` from the input
 * that started it, and looked busy while it waited. The folder of a project ↔ machine link is one the person
 * chose, so the server answers "Yes" there itself (the project can turn that off in Setup, `agent.
 * trust_project_folder`) and records it in the feed; anywhere else (a folder outside the link, the option
 * off, the "No" option selected) the tab becomes `trust_prompt` at once, which pushes and wakes the chat.
 * Worktrees of automatic work keep their own rule (automation/trust.ts). Claude Code only: Codex's screen has
 * no rule here. The screen is compared and dropped, never logged.
 */

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface FolderTrustDeps {
  capture: (machine: Machine, session: string, lines: number) => Promise<string>;
  sendEnter: (machine: Machine, session: string) => Promise<void>;
  now: () => number;
}

export const defaultTrustDeps: FolderTrustDeps = {
  capture: captureScreen,
  sendEnter: (machine, session) => sendKeyToSession(machine, session, 'Enter'),
  now: () => Date.now(),
};

/** When, after an agent start, its tab's screen is read for the dialog: it shows within a second or two. */
export const LAUNCH_CHECKS_MS = [2_000, 5_000, 10_000, 20_000, 40_000] as const;
/** An Enter sent to a tab's dialog is not sent again for this long (the launch check and a sweep may both see it). */
const ANSWERED_HOLD_MS = 15_000;
/** The states a tab may have when the dialog is found: the one before the start, or the start's own `working`. */
const BEFORE_DIALOG: readonly (TabState | null)[] = [null, 'working', 'waiting_input', 'waiting_permission', 'finished', 'idle', 'error', 'blocked', 'waiting_background', 'auth_required'];

const answered = new Map<string, number>();

/**
 * Whether the server answers the dialog in this tab: its session runs in the project's own folder (`cwd`
 * null; a card's worktree has its own) and the project did not turn it off.
 */
export async function trustsProjectFolder(repos: Pick<Repositories, 'projectSetup'>, tab: Pick<Tab, 'cwd' | 'project_id'>): Promise<boolean> {
  if (tab.cwd !== null) return false;
  return (await repos.projectSetup.get(tab.project_id)).data.agent.trust_project_folder;
}

export type TrustOutcome = 'accepted' | 'reported' | 'unchanged';

/**
 * The tab's screen (`screen`, already read) shows the trust dialog: in the project's folder with "Yes"
 * selected, Enter goes and the feed gets `trust_auto_accepted`; otherwise the tab becomes `trust_prompt`
 * (only if its state did not move since it was read, `tab.state_at`) and the change is published.
 */
export async function settleTrustDialog(
  repos: Repositories,
  log: Log,
  tab: Tab & { tmux_session: string },
  machine: Machine,
  screen: string,
  deps: FolderTrustDeps = defaultTrustDeps,
  ifStateIn: readonly (TabState | null)[] = BEFORE_DIALOG,
): Promise<TrustOutcome> {
  const last = answered.get(tab.id);
  if (last !== undefined && deps.now() - last < ANSWERED_HOLD_MS) return 'unchanged';
  if (showsTrustQuestion(screen) && (await trustsProjectFolder(repos, tab))) {
    await deps.sendEnter(machine, tab.tmux_session);
    if (answered.size > 1000) answered.clear();
    answered.set(tab.id, deps.now());
    log.info({ tabId: tab.id, machineId: machine.id }, 'monitor: trust dialog answered in the project folder');
    await recordEvent(repos, { project_id: tab.project_id, kind: 'trust_auto_accepted', payload: { tab_id: tab.id, tab_name: tab.name, folder: 'project' } }).catch((err: unknown) =>
      log.warn({ tabId: tab.id, code: failureLabel(err) }, 'monitor: trust_auto_accepted not recorded'),
    );
    return 'accepted';
  }
  if (tab.state === 'trust_prompt') return 'unchanged';
  const { tab: updated, event } = await repos.tabs.recordEvent(tab.id, {
    kind: 'trust_prompt',
    tool: 'claude',
    text: TRUST_PROMPT_TEXT,
    meta: { event: 'ScreenCheck', screen: 'trust' },
    ifStateAt: tab.state_at,
    ifStateIn,
  });
  log.info({ tabId: tab.id, machineId: machine.id, recorded: event !== null }, 'monitor: tab waits on the trust dialog');
  if (!event) return 'unchanged';
  publishTabChange(updated, tab.project_id, machine);
  return 'reported';
}

/**
 * Right after termhub typed a Claude Code line into a tab (start_agent, "Iniciar sessão"), reads its screen
 * a few times (`LAUNCH_CHECKS_MS`) for the trust dialog and settles it, instead of leaving it to the sweeps
 * (minutes later). Stops once the dialog was settled or the tab is gone. Fire and forget; never throws.
 */
export function followLaunch(repos: Repositories, log: Log, tabId: string, machine: Machine, deps: FolderTrustDeps = defaultTrustDeps, schedule: (fn: () => void, ms: number) => void = later): void {
  const step = (i: number) => {
    if (i >= LAUNCH_CHECKS_MS.length) return;
    const wait = LAUNCH_CHECKS_MS[i]! - (i > 0 ? LAUNCH_CHECKS_MS[i - 1]! : 0);
    schedule(() => {
      void checkLaunch(repos, log, tabId, machine, deps)
        .then((done) => {
          if (!done) step(i + 1);
        })
        .catch((err: unknown) => log.warn({ tabId, code: failureLabel(err) }, 'monitor: launch trust check failed'));
    }, wait);
  };
  step(0);
}

function later(fn: () => void, ms: number): void {
  setTimeout(fn, ms).unref();
}

/** One read of a just-started tab; true when nothing more is to be done (settled, or the tab is gone). */
export async function checkLaunch(repos: Repositories, log: Log, tabId: string, machine: Machine, deps: FolderTrustDeps = defaultTrustDeps): Promise<boolean> {
  const tab = await repos.tabs.findById(tabId);
  if (!tab || !tab.tmux_session) return true;
  if (tab.state === 'trust_prompt') return true;
  const screen = await deps.capture(machine, tab.tmux_session, SCREEN_STATE_LINES + 20);
  if (claudeScreenState(screen) !== 'trust') return false;
  return (await settleTrustDialog(repos, log, tab as Tab & { tmux_session: string }, machine, screen, deps)) !== 'unchanged';
}

/** Tests only: forgets the Enters already sent. */
export function resetAnsweredForTests(): void {
  answered.clear();
}
