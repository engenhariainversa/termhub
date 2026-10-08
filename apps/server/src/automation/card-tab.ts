import { AGENT_EXITED_TEXT } from '../chat/agent-exited.js';
import { isAccountSwapState } from '../control/account-swap.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Tab } from '../db/repositories/types.js';
import { AT_PROMPT, RATE_LIMIT_TEXT } from '../monitor/state.js';

/**
 * A tab an earlier run of the card left open (TER-1051). The worktree is per card, so a fixer started in a
 * new tab would share it with this one, which a person may be using. `free`: the fixer may take it over.
 */
export interface CardTab {
  run: AutomationRun;
  tab: Tab;
  free: boolean;
}

/** Back at its prompt with its turn over, and able to take a line: not on a limit, a swap or an exit. */
export const atIdlePrompt = (tab: Tab): boolean =>
  tab.state !== null &&
  AT_PROMPT.includes(tab.state) &&
  tab.rate_limited_at === null &&
  !(tab.state_text ?? '').startsWith(RATE_LIMIT_TEXT) &&
  !isAccountSwapState(tab.state_text) &&
  tab.state_text !== AGENT_EXITED_TEXT;

/**
 * The newest tab still open of a card's runs that ended `done` or `blocked`, or null when none is. It is
 * free when it sits at its prompt (`atIdlePrompt`), with no open question card, and nobody submitted a
 * prompt in it since its run ended; otherwise it is busy, or a person is using it.
 */
export async function openCardTab(repos: Repositories, taskId: string): Promise<CardTab | null> {
  for (const run of await repos.automationRuns.endedInTabs(taskId)) {
    const tab = run.tab_id ? await repos.tabs.findById(run.tab_id) : undefined;
    if (!tab) continue;
    const free = atIdlePrompt(tab) && !(await repos.tabQuestions.hasOpenQuestion(tab.id)) && !(await repos.tabs.promptedSince(tab.id, run.ended_at!));
    return { run, tab, free };
  }
  return null;
}
