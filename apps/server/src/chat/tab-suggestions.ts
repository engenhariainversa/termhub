import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import { captureStyledScreen } from '../agent/screen.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { promptSuggestion } from '../terminal/ansi.js';
import { failureLabel } from './service.js';
import { ANSWER_TEXT_MAX } from './tab-question-payload.js';
import { publishTabQuestions } from './tab-questions.js';

/**
 * How long after Claude's `Stop` the prompt is read: the suggestion is drawn shortly after the turn ends
 * (seen 1.46–2.80 s later), so the wait keeps a margin over that (spec §3, §6.1).
 */
export const SUGGESTION_DELAY_MS = 5000;
/** The input box sits at the bottom of the pane. */
export const SUGGESTION_CAPTURE_LINES = 15;
export const SUGGESTION_MAX = ANSWER_TEXT_MAX;

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** One line of plain text, ≤ 2000 chars, control characters stripped; null when nothing is left. */
export function cleanSuggestion(text: string | null): string | null {
  if (text === null) return null;
  const clean = text.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, SUGGESTION_MAX).trim();
  return clean === '' ? null : clean;
}

/** The suggestion on the tab's prompt now, or null — also for a machine that cannot keep attributes. Never logged. */
export async function readSuggestion(machine: Machine, session: string): Promise<string | null> {
  const { text, styled } = await captureStyledScreen(machine, session, SUGGESTION_CAPTURE_LINES);
  return styled ? cleanSuggestion(promptSuggestion(text)) : null;
}

/**
 * The delayed half of a Claude `Stop` (spec §6.1): when the tab still waits for input and its prompt
 * shows a suggestion, a row opens in the project owner's most recently active conversation — the same
 * owner rule as a question — and the card reaches every screen showing it. `still` is false once another
 * hook event of the tab arrived (the screen moved on). Never throws; logs ids and counts only.
 */
export async function checkTabSuggestion(repos: Repositories, log: Log, tabId: string, still: () => boolean = () => true): Promise<void> {
  try {
    const tab = await repos.tabs.findById(tabId);
    if (!tab || tab.kind !== 'terminal' || !tab.tmux_session || tab.state !== 'waiting_input') return;
    const owner = (await repos.projects.findById(tab.project_id))?.owner_id;
    const conversation = owner ? await repos.chat.findLatestActiveForProject(tab.project_id, owner) : undefined;
    if (!conversation) return;
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine || (machine.type === 'agent' && !agents.isOnline(machine.id))) return;
    const text = await readSuggestion(machine, tab.tmux_session);
    // Claude Code also suggests slash commands ("/compact"); sending refuses a leading / or !, so no card.
    if (text === null || /^[/!]/.test(text) || !still()) return;
    const { question, closed } = await repos.tabQuestions.open({ tab_id: tab.id, project_id: tab.project_id, conversation_id: conversation.id, kind: 'suggestion', payload: { text }, tool_use_id: null });
    await publishTabQuestions(repos, 'tab_question_closed', closed);
    if (question) {
      await publishTabQuestions(repos, 'tab_question', [question]);
      log.info({ tabId: tab.id, tabQuestionId: question.id, kind: 'suggestion', chars: text.length }, 'tab suggestion opened');
    }
  } catch (err) {
    log.warn({ tabId, code: failureLabel(err) }, 'tab suggestion check failed');
  }
}

/** One pending check per tab. In-process: only the active color receives hooks. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Any hook event of the tab: a check still waiting (or reading the screen) opens nothing. */
export function cancelTabSuggestion(tabId: string): void {
  const timer = pending.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pending.delete(tabId);
}

/** After a Claude `Stop`: fire-and-forget, never delays the hook POST. A second Stop restarts the wait. */
export function scheduleTabSuggestion(repos: Repositories, log: Log, tabId: string): void {
  cancelTabSuggestion(tabId);
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    const still = () => pending.get(tabId) === timer;
    void checkTabSuggestion(repos, log, tabId, still).finally(() => {
      if (still()) pending.delete(tabId);
    });
  }, SUGGESTION_DELAY_MS);
  timer.unref?.();
  pending.set(tabId, timer);
}

/** The server is closing: no check runs against a closed database. */
export function stopTabSuggestions(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
