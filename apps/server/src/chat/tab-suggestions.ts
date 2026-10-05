import type { FastifyBaseLogger } from 'fastify';
import { versionAtLeast } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { captureStyledScreen } from '../agent/screen.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { AT_PROMPT, STATE_TEXT_MAX } from '../monitor/state.js';
import { promptSuggestion } from '../terminal/ansi.js';
import { failureLabel } from './service.js';
import { ANSWER_TEXT_MAX, CONTROL_CHARS_RE, FORMAT_CHARS_RE, globalOf, sliceUnits } from './tab-question-payload.js';
import { publishTabQuestions } from './tab-questions.js';

/**
 * How long after Claude's `Stop` the prompt is read: the suggestion is drawn shortly after the turn ends
 * (seen 1.46–2.80 s later), so the wait keeps a margin over that (spec §3, §6.1).
 */
export const SUGGESTION_DELAY_MS = 5000;
/** The input box sits at the bottom of the pane. */
export const SUGGESTION_CAPTURE_LINES = 15;
export const SUGGESTION_MAX = ANSWER_TEXT_MAX;
/** The first agent release whose `tmux.capture` keeps attributes (`escapes`): an older one answers plain text, so the RPC is skipped (spec 2026-09-26 §5.5). */
export const STYLED_CAPTURE_MIN_AGENT_VERSION = '0.5.2';
/** Claude Code's `Notification idle_prompt` text: never a context (defensive since TER-203 — the context now comes from the Stop). */
export const CLAUDE_IDLE_MESSAGE = 'Claude is waiting for your input';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

const CONTROL_CHARS = globalOf(CONTROL_CHARS_RE);
/** What a context drops: every C0 control but the newline, DEL, C1, and the bidi / format controls. */
const CONTEXT_DROP = new RegExp(`[\\x00-\\x09\\x0b-\\x1f\\x7f-\\x9f]|${FORMAT_CHARS_RE.source}`, 'g');

/** One line of plain text, ≤ 2000 UTF-16 units (never half a pair), control characters (C0, DEL, C1) stripped; null when nothing is left. */
export function cleanSuggestion(text: string | null): string | null {
  if (text === null) return null;
  const clean = sliceUnits(text.replace(CONTROL_CHARS, '').trim(), SUGGESTION_MAX).trim();
  return clean === '' ? null : clean;
}

/**
 * The agent's last message as a suggestion card shows it (spec 2026-09-26 §6.2): newlines kept (CRLF read
 * as one), a tab read as a space, every other control and bidi/format character removed, runs of more than
 * two blank lines collapsed to two, capped at `STATE_TEXT_MAX` without splitting a pair. Null when nothing
 * is left, or when it is only Claude's generic idle message. Never logged.
 */
export function cleanContext(text: string | null): string | null {
  if (text === null) return null;
  const clean = sliceUnits(cleanMessage(text), STATE_TEXT_MAX).trim();
  return clean === '' || clean === CLAUDE_IDLE_MESSAGE ? null : clean;
}

/** `cleanContext`'s cleaning, with no cap. */
function cleanMessage(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTEXT_DROP, '')
    .replace(/\n(?:[ ]*\n){3,}/g, '\n\n\n')
    .trim();
}

/**
 * The last `max` UTF-16 units of `text` (never half a pair). A longer text is cut at the first
 * paragraph boundary inside that tail, or at a line break when it has none; with neither, the cut
 * is marked with a leading "…" that fits in `max`.
 */
export function tailOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const from = (budget: number): string => {
    let start = text.length - budget;
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start += 1; // a low surrogate: its pair stays out
    return text.slice(start);
  };
  const tail = from(max);
  for (const boundary of [/\n[ ]*\n/, /\n/]) {
    const match = boundary.exec(tail);
    if (match) {
      const rest = tail.slice(match.index + match[0].length).trim();
      if (rest !== '') return rest;
    }
  }
  return `…${from(max - 1).trimStart()}`;
}

/** The suggestion on the tab's prompt now, or null — also for a machine that cannot keep attributes. Never logged. */
export async function readSuggestion(machine: Machine, session: string): Promise<string | null> {
  const { text, styled } = await captureStyledScreen(machine, session, SUGGESTION_CAPTURE_LINES);
  return styled ? cleanSuggestion(promptSuggestion(text)) : null;
}

/** What the Claude `Stop` that schedules a check says about itself (spec 2026-09-26 TER-203 §4.2). */
export interface StopFacts {
  /** Its `last_assistant_message`, as interpreted (null when it sent none). */
  context: string | null;
  /** How many of its `background_tasks` still run. */
  backgroundTasks: number;
}

/**
 * The delayed half of a Claude `Stop` (spec §6.1): when the tab still waits for input and its prompt
 * shows a suggestion, a row opens in the project owner's most recently active conversation — the same
 * owner rule as a question — and the card reaches every screen showing it. `context` is that `Stop`'s own
 * message, already cleaned by `scheduleTabSuggestion` (spec 2026-09-26 TER-203 §4.2): the tab row is not
 * read for it, since anything that reached the row in between would be the wrong message. An agent older
 * than 0.5.2 cannot keep attributes and is not asked. `still` is false once another hook event of the tab
 * arrived (the screen moved on). Never throws; logs ids and counts only.
 */
export async function checkTabSuggestion(repos: Repositories, log: Log, tabId: string, context: string, still: () => boolean = () => true): Promise<void> {
  try {
    const tab = await repos.tabs.findById(tabId);
    // A turn that ended with a report (`finished`, TER-972) is back at its prompt too: its suggestion opens.
    if (!tab || tab.kind !== 'terminal' || !tab.tmux_session || !tab.state || !AT_PROMPT.includes(tab.state)) return;
    const owner = (await repos.projects.findById(tab.project_id))?.owner_id;
    const conversation = owner ? await repos.chat.findLatestActiveForProject(tab.project_id, owner) : undefined;
    if (!conversation) return;
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine || (machine.type === 'agent' && !agents.isOnline(machine.id))) return;
    if (machine.type === 'agent') {
      // An unknown version still tries: its plain answer (`styled: false`) opens nothing anyway.
      const version = agents.info(machine.id)?.agent_version;
      if (version && !versionAtLeast(version, STYLED_CAPTURE_MIN_AGENT_VERSION)) return;
    }
    const text = await readSuggestion(machine, tab.tmux_session);
    // Claude Code also suggests slash commands ("/compact"); sending refuses a leading / or !, so no card.
    if (text === null || /^[/!]/.test(text) || !still()) return;
    const { question, closed } = await repos.tabQuestions.open({ tab_id: tab.id, project_id: tab.project_id, conversation_id: conversation.id, kind: 'suggestion', payload: { text, context }, tool_use_id: null, agent_id: null });
    await publishTabQuestions(repos, 'tab_question_closed', closed);
    if (question) {
      await publishTabQuestions(repos, 'tab_question', [question]);
      log.info({ tabId: tab.id, tabQuestionId: question.id, kind: 'suggestion', chars: text.length, contextChars: context.length }, 'tab suggestion opened');
    }
  } catch (err) {
    log.warn({ tabId, code: failureLabel(err) }, 'tab suggestion check failed');
  }
}

/** A reply card only opens on a question: the message's last paragraph ends with a question mark (ASCII or fullwidth). */
const endsWithQuestion = (context: string): boolean => /[?？]$/.test(context.split(/\n\s*\n/).pop()!.trim());

/**
 * A Codex `Stop` whose message ends in a question (Codex has no dimmed suggestion to read): a
 * `suggestion` row with an empty text and the cleaned message's tail as its context opens in the owner's
 * latest active conversation, so the person can answer from the chat. Called after `noteHookEvent`
 * (a Stop closes the open cards); the paired `notify` does not close it. Only for an owner who opted in
 * (`chatCodexReplies`, off by default). Never throws; logs ids and counts only.
 */
export async function openCodexReply(repos: Repositories, log: Log, tabId: string, message: string | null): Promise<void> {
  try {
    // `message` is the whole final message: the question sits at its end, so a long one is read by its
    // last paragraph and kept by its tail (at most STATE_TEXT_MAX), never by its start.
    const clean = message === null ? '' : cleanMessage(message);
    if (clean === '' || !endsWithQuestion(clean)) return;
    const context = tailOf(clean, STATE_TEXT_MAX);
    const tab = await repos.tabs.findById(tabId);
    if (!tab || tab.kind !== 'terminal' || !tab.tmux_session || tab.state !== 'waiting_input') return;
    const owner = (await repos.projects.findById(tab.project_id))?.owner_id;
    const conversation = owner ? await repos.chat.findLatestActiveForProject(tab.project_id, owner) : undefined;
    if (!conversation) return;
    // Opt-in: the prose reply card only opens for an owner who turned "Responder perguntas do Codex pelo chat" on.
    if (!(await repos.users.chatCodexReplies(owner!))) return;
    const { question, closed } = await repos.tabQuestions.open({ tab_id: tab.id, project_id: tab.project_id, conversation_id: conversation.id, kind: 'suggestion', payload: { text: '', context, agent: 'codex' }, tool_use_id: null, agent_id: null });
    await publishTabQuestions(repos, 'tab_question_closed', closed);
    if (question) {
      await publishTabQuestions(repos, 'tab_question', [question]);
      log.info({ tabId: tab.id, tabQuestionId: question.id, kind: 'suggestion', agent: 'codex', contextChars: context.length }, 'codex reply card opened');
    }
  } catch (err) {
    log.warn({ tabId, code: failureLabel(err) }, 'codex reply card failed');
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

/**
 * After a Claude `Stop`: fire-and-forget, never delays the hook POST. A second Stop restarts the wait —
 * and a Stop that opens nothing still cancels the previous one's check. No card for a Stop whose tab has
 * background work running (it resumes by itself on the next task notification) or that carries no message
 * (a card could not say what it answers) — spec 2026-09-26 TER-203 §3.
 */
export function scheduleTabSuggestion(repos: Repositories, log: Log, tabId: string, stop: StopFacts): void {
  cancelTabSuggestion(tabId);
  if (stop.backgroundTasks > 0) {
    log.info({ tabId, reason: 'background', count: stop.backgroundTasks }, 'tab suggestion skipped');
    return;
  }
  const context = cleanContext(stop.context);
  if (context === null) {
    log.info({ tabId, reason: 'no_context' }, 'tab suggestion skipped');
    return;
  }
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    const still = () => pending.get(tabId) === timer;
    void checkTabSuggestion(repos, log, tabId, context, still).finally(() => {
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
