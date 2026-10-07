import { captureScreen } from '../agent/screen.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { sendKeyToSession } from '../terminal/session-ops.js';

/*
 * Claude Code's "Quick safety check: Is this a project you created or one you trust?" (TER-1025). It comes
 * before any hook in a folder Claude has not seen, and after an account swap (trust is kept per account).
 * An automatic run always works in a worktree termhub itself made for it, so the server answers it: the
 * new agent pre-accepts the worktree, and this covers older agents and accounts it did not reach.
 */

/** The answer the question opens on (Claude Code 2.1.x: "1. Yes, I trust this folder" / "2. No, exit"). */
const YES_SELECTED = /❯\s*1\.\s*Yes, I trust this folder/;
const ASKS = /one you trust|trust this folder/i;

/**
 * Whether the screen shows the trust question with its "Yes" option selected — only then is Enter the
 * answer; any other screen (the "No" option selected, a different dialog) is left for the person.
 */
export function showsTrustQuestion(screen: string): boolean {
  return ASKS.test(screen) && screen.split('\n').some((line) => YES_SELECTED.test(line));
}

/** Lines of the screen read: the question fills less than a screen. */
const SCREEN_LINES = 60;

/**
 * Reads the run's tab and, when it shows the trust question, presses Enter on "Yes". Only for a run with
 * its own worktree (a folder termhub made); the caller checks the pause first (D24). True when Enter went.
 * The screen is compared and dropped, never logged (terminal content).
 */
export function acceptTrustQuestion(repos: Repositories): (run: AutomationRun, tab: Tab) => Promise<boolean> {
  return async (run, tab) => {
    if (!run.worktree_path || !tab.tmux_session) return false;
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine) return false;
    const screen = await captureScreen(machine, tab.tmux_session, SCREEN_LINES).catch(() => null);
    if (!screen || !showsTrustQuestion(screen)) return false;
    await sendKeyToSession(machine, tab.tmux_session, 'Enter');
    return true;
  };
}
