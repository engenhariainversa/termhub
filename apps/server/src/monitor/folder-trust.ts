import type { FastifyBaseLogger } from 'fastify';
import { agentRpc, versionAtLeast } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import { recordEvent } from '../automation/events.js';
import { failureLabel } from '../chat/service.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab, TabState } from '../db/repositories/types.js';
import { sendKeyToSession } from '../terminal/session-ops.js';
import { publishTabChange } from './ingest.js';
import { SCREEN_STATE_LINES } from './screen-state.js';
import { lastNonBlankLines } from '../chat/permission-dialog.js';
import { cliDialogOf } from './cli-dialogs.js';
import { trustPromptText } from './state.js';
import { TRUST_CLI_LABEL, trustDialogOf } from './trust-dialogs.js';

/*
 * The agent CLI's folder trust dialog in a project's own folder (TER-1117; every CLI, TER-1122). A folder Claude Code never opened
 * (a project just linked, a new machine, an account that never ran there) stops on "Is this a project you
 * created or one you trust?" before any hook fires: the tab reported nothing, or `working` from the input
 * that started it, and looked busy while it waited. The folder of a project ↔ machine link is one the person
 * chose, so the server answers "Yes" there itself (the project can turn that off in Setup, `agent.
 * trust_project_folder`) and records it in the feed; anywhere else (a folder outside the link, the option
 * off, the "No" option selected) the tab becomes `trust_prompt` at once, which pushes and wakes the chat.
 * Worktrees of automatic work keep their own rule (automation/trust.ts). TER-1122: Codex, Cursor and Gemini ask
 * the same thing in their own words (trust-dialogs.ts) and get the same answer; a dialog that would also change
 * the CLI's permissions (Codex's older "without asking for approval") is never answered, only reported. The
 * screen is compared and dropped, never logged.
 *
 * TER-1148: the folder also counts as the project's when the tab's `cwd` names it (the link's folder spelled
 * out) and when it is the worktree of the tab's automatic run; before Claude Code starts or resumes there
 * (start_agent, an account swap, a resume after the agent exited) the folder is marked trusted in every
 * Claude account of the machine (`pretrustFolder`, agent 0.38.0), since the trust is kept per account; and a
 * dialog whose cursor starts on "No" gets the selection moved up to the trust option first, Enter only once
 * the screen shows it there.
 *
 * TER-1162: Codex's "Hooks need review" (a CLI dialog, cli-dialogs.ts) holds a new tab the same way, before its
 * first message and before any hook, whenever any hook is new or changed — termhub's after an update, a plugin's
 * as much. Under the same option, in the same folders, the server picks "Trust all and continue" (the person's
 * decision on that card: every pending hook, a plugin's too) and the feed says so each time. Option off or
 * another folder: the tab stays `cli_dialog` (TER-1166) and the conversation offers the same answer as a button.
 */

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface FolderTrustDeps {
  capture: (machine: Machine, session: string, lines: number) => Promise<string>;
  sendEnter: (machine: Machine, session: string) => Promise<void>;
  /** Moves the dialog's selection one option up (TER-1148). */
  sendUp: (machine: Machine, session: string) => Promise<void>;
  /** Moves it one option down (TER-1162: Codex's hooks review starts on "Review hooks", above the trust option). */
  sendDown: (machine: Machine, session: string) => Promise<void>;
  /** A short wait for the CLI to redraw after a key. */
  pause: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultTrustDeps: FolderTrustDeps = {
  capture: captureScreen,
  sendEnter: (machine, session) => sendKeyToSession(machine, session, 'Enter'),
  sendUp: (machine, session) => sendKeyToSession(machine, session, 'Up'),
  sendDown: (machine, session) => sendKeyToSession(machine, session, 'Down'),
  pause: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/**
 * When, after an agent start, its tab's screen is read for the dialog: it shows within a second or two, but
 * a slow start (a setup command, a cold disk) takes longer, and the sweeps only come minutes later.
 */
export const LAUNCH_CHECKS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 90_000, 180_000] as const;
/** How many times the selection is moved up towards the trust option before the dialog is left to the person. */
const MAX_MOVES = 3;
/** The wait after each move before the screen is read again. */
const MOVE_SETTLE_MS = 400;
/** An Enter sent to a tab's dialog is not sent again for this long (the launch check and a sweep may both see it). */
const ANSWERED_HOLD_MS = 15_000;
/** The states a tab may have when the dialog is found: the one before the start, or the start's own `working`. */
const BEFORE_DIALOG: readonly (TabState | null)[] = [null, 'working', 'waiting_input', 'waiting_permission', 'finished', 'idle', 'error', 'blocked', 'waiting_background', 'auth_required'];

const answered = new Map<string, number>();

type TrustRepos = Pick<Repositories, 'projectSetup' | 'projectMachines' | 'automationRuns'>;

/** Which folder of the project the tab's session runs in: the link's own folder, or the worktree of the tab's run. */
export type TrustedFolder = { kind: 'project' | 'worktree'; path: string };

const sameFolder = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * The folder the server may trust for this tab, or null: the project did not turn it off (`agent.
 * trust_project_folder`) and the tab runs in the project ↔ machine link's folder (`cwd` null, or the same
 * path) or in the worktree termhub made for the tab's automatic run. Any other folder is the person's call.
 */
export async function trustedFolderOf(repos: TrustRepos, tab: Pick<Tab, 'id' | 'cwd' | 'project_id' | 'machine_id'>): Promise<TrustedFolder | null> {
  if (!(await repos.projectSetup.get(tab.project_id)).data.agent.trust_project_folder) return null;
  const link = await repos.projectMachines.find(tab.project_id, tab.machine_id);
  if (tab.cwd === null) return link ? { kind: 'project', path: link.cwd } : null;
  if (link && sameFolder(tab.cwd, link.cwd)) return { kind: 'project', path: tab.cwd };
  const run = await repos.automationRuns.latestByTab(tab.id);
  if (run?.worktree_path && run.project_id === tab.project_id && sameFolder(tab.cwd, run.worktree_path)) return { kind: 'worktree', path: tab.cwd };
  return null;
}

/** The first agent release that answers `claude.trustFolder` (TER-1148). */
export const TRUST_FOLDER_MIN_AGENT_VERSION = '0.38.0';

/**
 * Right before Claude Code starts or resumes in a tab (TER-1148): its folder, when the server may trust it
 * (`trustedFolderOf`), is marked trusted in every Claude account of the machine — the trust is per account,
 * so a resume under another account would ask again. Only on an agent machine new enough to answer; an older
 * one, an ssh machine or a failed call leave it to the screen (`followLaunch`). `configDirs`: the accounts
 * termhub knows of there. Best effort; never throws. True when the agent marked it.
 */
export async function pretrustFolder(
  repos: TrustRepos,
  log: Log,
  tab: Pick<Tab, 'id' | 'cwd' | 'project_id' | 'machine_id'>,
  machine: Machine,
  configDirs: readonly (string | null)[] = [],
  rpc: (machine: Machine, dir: string, configDirs: string[]) => Promise<number> = trustFolderRpc,
): Promise<boolean> {
  try {
    if (machine.type !== 'agent') return false;
    const version = agents.info(machine.id)?.agent_version ?? machine.agent_version;
    if (!version || !versionAtLeast(version, TRUST_FOLDER_MIN_AGENT_VERSION)) return false;
    const folder = await trustedFolderOf(repos, tab);
    if (!folder) return false;
    const dirs = [...new Set(configDirs.filter((d): d is string => !!d))].slice(0, 16);
    const changed = await rpc(machine, folder.path, dirs);
    log.info({ tabId: tab.id, machineId: machine.id, folder: folder.kind, changed }, 'monitor: folder trusted before the agent start');
    return true;
  } catch (err) {
    log.warn({ tabId: tab.id, machineId: machine.id, code: failureLabel(err) }, 'monitor: folder not trusted before the agent start');
    return false;
  }
}

async function trustFolderRpc(machine: Machine, dir: string, configDirs: string[]): Promise<number> {
  return (await agentRpc(machine, 'claude.trustFolder', { dir, ...(configDirs.length ? { config_dirs: configDirs } : {}) })).changed;
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
  let dialog = trustDialogOf(screen);
  const folder = dialog && !dialog.changesPermissions ? await trustedFolderOf(repos, tab) : null;
  // TER-1148: the cursor may start on "No, exit"; Enter there would close the agent, so it is moved up first
  for (let moves = 0; folder && dialog && !dialog.selected && !dialog.changesPermissions && moves < MAX_MOVES; moves++) {
    await deps.sendUp(machine, tab.tmux_session);
    await deps.pause(MOVE_SETTLE_MS);
    dialog = trustDialogOf(await deps.capture(machine, tab.tmux_session, SCREEN_STATE_LINES + 20));
  }
  // the dialog went away while the selection moved: nothing left to settle
  if (!dialog && folder) return 'unchanged';
  if (dialog?.acceptable && folder) {
    await deps.sendEnter(machine, tab.tmux_session);
    if (answered.size > 1000) answered.clear();
    answered.set(tab.id, deps.now());
    log.info({ tabId: tab.id, machineId: machine.id, cli: dialog.cli, folder: folder.kind }, 'monitor: trust dialog answered in the project folder');
    await recordEvent(repos, { project_id: tab.project_id, kind: 'trust_auto_accepted', payload: { tab_id: tab.id, tab_name: tab.name, folder: folder.kind, cli: dialog.cli } }).catch((err: unknown) =>
      log.warn({ tabId: tab.id, code: failureLabel(err) }, 'monitor: trust_auto_accepted not recorded'),
    );
    return 'accepted';
  }
  if (tab.state === 'trust_prompt') return 'unchanged';
  const cli = dialog?.cli ?? 'claude';
  const { tab: updated, event } = await repos.tabs.recordEvent(tab.id, {
    kind: 'trust_prompt',
    tool: cli,
    text: trustPromptText(TRUST_CLI_LABEL[cli]),
    meta: { event: 'ScreenCheck', screen: 'trust' },
    ifStateAt: tab.state_at,
    ifStateIn,
  });
  log.info({ tabId: tab.id, machineId: machine.id, cli, recorded: event !== null }, 'monitor: tab waits on the trust dialog');
  if (!event) return 'unchanged';
  publishTabChange(updated, tab.project_id, machine);
  return 'reported';
}

/** The id cli-dialogs.ts gives Codex's "Hooks need review" (TER-1166). */
export const HOOKS_REVIEW_DIALOG = 'codex_hooks_review';
/** Its trust option, "2. Trust all and continue" (Codex 0.159.3 and 0.164.0, fixtures/cli-dialogs). */
const HOOKS_TRUST_OPTION = /^\s*(?:›\s*)?2\.\s*Trust all and continue\b/;
/** The option the selection mark is on, by its number. */
const CODEX_MARKED = /^\s*›\s*(\d)\.\s/;

/**
 * Where the selection of Codex's hooks review shown on `screen` is: `trust` on "Trust all and continue", `above`
 * or `below` it, null when the screen shows no review (or one whose trust option is not where it was checked).
 */
export function hooksReviewSelection(screen: string): 'trust' | 'above' | 'below' | null {
  if (cliDialogOf(screen)?.id !== HOOKS_REVIEW_DIALOG) return null;
  const lines = lastNonBlankLines(screen, 30).split('\n');
  if (!lines.some((l) => HOOKS_TRUST_OPTION.test(l))) return null;
  let marked: number | null = null;
  for (const l of lines) {
    const m = CODEX_MARKED.exec(l);
    if (m) marked = Number(m[1]);
  }
  if (marked === null) return null;
  return marked === 2 ? 'trust' : marked < 2 ? 'above' : 'below';
}

/**
 * Answers Codex's hooks review shown on `screen` with "Trust all and continue": the selection is moved onto it
 * (it starts on "Review hooks"), and Enter goes only once the screen shows it there, so a stray key can never
 * confirm "Review hooks" or "Continue without trusting". False when there is no review, or the selection did
 * not land on the trust option.
 */
export async function answerHooksReview(machine: Machine, session: string, screen: string, deps: FolderTrustDeps = defaultTrustDeps): Promise<boolean> {
  let at = hooksReviewSelection(screen);
  for (let moves = 0; (at === 'above' || at === 'below') && moves < MAX_MOVES; moves++) {
    await (at === 'above' ? deps.sendDown : deps.sendUp)(machine, session);
    await deps.pause(MOVE_SETTLE_MS);
    at = hooksReviewSelection(await deps.capture(machine, session, SCREEN_STATE_LINES + 20));
  }
  if (at !== 'trust') return false;
  await deps.sendEnter(machine, session);
  return true;
}

/**
 * The tab's screen (`screen`, already read) shows Codex's hooks review: in a folder the server may trust
 * (`trustedFolderOf`, the same option as the folder dialog) it is answered "Trust all and continue" and the feed
 * gets `trust_auto_accepted` with `hooks: true`. `off`: the option is off or the folder is not the project's —
 * the caller leaves the tab to the person (`cli_dialog`). `unchanged`: answered a moment ago, or the selection
 * never reached the trust option.
 */
export async function settleHooksReview(
  repos: Repositories,
  log: Log,
  tab: Tab & { tmux_session: string },
  machine: Machine,
  screen: string,
  deps: FolderTrustDeps = defaultTrustDeps,
): Promise<'accepted' | 'off' | 'unchanged'> {
  if (!hooksReviewSelection(screen)) return 'unchanged';
  const key = `${tab.id}:hooks`;
  const last = answered.get(key);
  if (last !== undefined && deps.now() - last < ANSWERED_HOLD_MS) return 'unchanged';
  const folder = await trustedFolderOf(repos, tab);
  if (!folder) return 'off';
  if (!(await answerHooksReview(machine, tab.tmux_session, screen, deps))) return 'unchanged';
  if (answered.size > 1000) answered.clear();
  answered.set(key, deps.now());
  log.info({ tabId: tab.id, machineId: machine.id, folder: folder.kind }, 'monitor: Codex hooks review answered in the project folder');
  await recordEvent(repos, { project_id: tab.project_id, kind: 'trust_auto_accepted', payload: { tab_id: tab.id, tab_name: tab.name, folder: folder.kind, cli: 'codex', hooks: true } }).catch((err: unknown) =>
    log.warn({ tabId: tab.id, code: failureLabel(err) }, 'monitor: trust_auto_accepted not recorded'),
  );
  return 'accepted';
}

/**
 * Right after termhub typed an agent CLI's line into a tab (start_agent, "Iniciar sessão"), reads its screen
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
  const target = tab as Tab & { tmux_session: string };
  const dialog = trustDialogOf(screen);
  if (!dialog) {
    // TER-1162: Codex's hooks review, at launch or right after its folder dialog
    if (!hooksReviewSelection(screen)) return false;
    return (await settleHooksReview(repos, log, target, machine, screen, deps)) !== 'unchanged';
  }
  const outcome = await settleTrustDialog(repos, log, target, machine, screen, deps);
  // TER-1162: Codex's hooks review may come right after its folder dialog: keep reading
  if (outcome === 'accepted' && dialog.cli === 'codex') return false;
  return outcome !== 'unchanged';
}

/** Tests only: forgets the Enters already sent. */
export function resetAnsweredForTests(): void {
  answered.clear();
}
