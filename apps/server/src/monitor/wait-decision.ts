import type { TabState } from '../db/repositories/types.js';

/**
 * What an incoming event is, for the "needs you" rule (spec 2026-09-29 one wait, one alert).
 *
 * A tab needs the person when it waits and the wait is newer than the last time they looked. Every
 * recorded event moves the wait's time, so an event that brings nothing new has to say so, or a wait
 * the person already saw lights up again. The interpreters know part of it (`continuesWait`,
 * `keepsWaitText`); the rest depends on where the tab is and how it got there, which only its own
 * row and its last events can tell. Pure: `recordEvent` reads both under its lock and asks here.
 *
 * Nothing is ever dropped because a session ended. Codex sends nothing but waits, and a second
 * session in the same tmux session can end while the first still works: a rule that guessed which
 * session an event belongs to could silence a live agent.
 */

/** Events that put a tab in `working` with no turn of the agent behind them. */
const QUIET_EVENTS: ReadonlySet<string> = new Set(['SessionStart', 'input']);

/** Events that prove the person asked for the turn that followed. */
const PROMPT_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'beforeSubmitPrompt', 'input']);

/** Events that say the tool's session ended. */
const SESSION_END_EVENTS: ReadonlySet<string> = new Set(['SessionEnd', 'sessionEnd']);

/**
 * A Codex turn that ends normally fires both its `Stop` hook and `notify` (`agent-turn-complete`): one
 * finished turn, reported twice. Each name maps to its partner (spec 2026-09-29 codex monitor hooks D4).
 */
const TURN_END_PARTNER: ReadonlyMap<string, string> = new Map([
  ['Stop', 'agent-turn-complete'],
  ['agent-turn-complete', 'Stop'],
]);

/** How many event rows, newest first, the decision reads. */
export const HISTORY_ROWS = 10;

/**
 * Two hooks fired together can arrive in either order: each is posted in the background, and the
 * hook's curl gives up after 5 s. Twice that is how late the first of a pair can be.
 */
export const REORDER_WINDOW_MS = 10_000;

export interface WaitCurrent {
  state: TabState | null;
  /** the person has seen the tab's current state (`state_seen_at >= state_at`) */
  seen: boolean;
  /** the tab has an activity: a tool call went through the light path, which writes no event row */
  hasActivity: boolean;
  /** how long ago the person last looked, or null when they never did */
  seenAgeMs: number | null;
}

/** One event row of the tab. The rows are given newest first. */
export interface HistoryRow {
  kind: TabState;
  /** the hook event name in the row's meta, or null */
  event: string | null;
  /** how long ago the row was written */
  ageMs: number;
  /** a Claude Stop that left background tasks running */
  backgroundTasks: boolean;
  /** a subagent's event (`meta.subagent`), with its id when the hook script sent one; null for the main thread */
  subagent?: SubagentRef | null;
}

/** Which subagent an event belongs to: `id` is null when an older hook script sent only the flag. */
export interface SubagentRef {
  id: string | null;
}

export interface WaitEvent {
  kind: TabState;
  /** the hook event name in the event's meta, or null */
  name: string | null;
  continuesWait: boolean;
  keepsWaitText: boolean;
  /** a subagent's event, null or absent for the main thread's */
  subagent?: SubagentRef | null;
}

export type WaitOutcome =
  | { action: 'drop'; reason: 'session_start_during_turn' | 'post_tool_after_interrupt' | 'subagent_during_wait' | 'reminder_during_background' }
  /**
   * `carry`: the person had seen the wait this one follows. `born`: a wait with nothing new in it,
   * seen from its first moment. `none`: a request the person has not seen.
   * `continuing`: the wait's own text is kept when the event has none or brings only a reminder.
   */
  | { action: 'record'; seen: 'carry' | 'born' | 'none'; continuing: boolean };

/** What the log says when a wait the person had seen is re-armed with no prompt of theirs. */
export interface Rearm {
  /** the event name of the tab's last row */
  previous: string | null;
  /** the wait the person had seen was a Stop with background tasks running */
  background: boolean;
  /** the tab's last row is a session end: the event landed after it */
  afterSessionEnd: boolean;
}

const NEW: WaitOutcome = { action: 'record', seen: 'none', continuing: false };

const isWait = (kind: TabState | null): boolean => kind === 'waiting_input' || kind === 'waiting_permission';
const isQuiet = (row: HistoryRow): boolean => row.kind === 'working' && row.event !== null && QUIET_EVENTS.has(row.event);

/**
 * The tab went to `working` with no turn behind it: its last row is quiet, and so is everything
 * back to the last wait (a session end in between is `idle`, and counts as nothing). A prompt or a
 * tool call on the way means a turn was running — a session start in the middle of a turn is what
 * a compaction sends.
 */
function noTurnSinceLastWait(history: HistoryRow[]): boolean {
  const last = history[0];
  if (!last || !isQuiet(last)) return false;
  for (const row of history) {
    if (isQuiet(row) || row.kind === 'idle') continue;
    return isWait(row.kind);
  }
  // Nothing but quiet rows: a session nobody asked anything — unless the rows that are kept ran
  // out, and a prompt may sit just beyond them.
  return history.length < HISTORY_ROWS;
}

/** The newest `waiting_input` row of the history, if the kept rows reach one. */
function lastWaitInputRow(history: HistoryRow[]): HistoryRow | undefined {
  return history.find((row) => row.kind === 'waiting_input');
}

/** Two refs of the same subagent: the same id, or at least one of them from a script that names nobody. */
const sameSubagent = (a: SubagentRef, b: SubagentRef): boolean => a.id === null || b.id === null || a.id === b.id;

/**
 * Whether the wait the tab is in was opened by this subagent's own permission prompt. The
 * `Notification` rows on top are passed over: they only announce the prompt below them.
 */
function waitOwnedBy(history: HistoryRow[], subagent: SubagentRef): boolean {
  for (const row of history) {
    if (row.event === 'Notification') continue;
    return isWait(row.kind) && !!row.subagent && sameSubagent(row.subagent, subagent);
  }
  return false;
}

export function decideWait(current: WaitCurrent, history: HistoryRow[], event: WaitEvent): WaitOutcome {
  const last = history[0] ?? null;

  // A subagent left running in the background keeps calling tools after its main thread ended the
  // turn (a Stop with background tasks), asked a question or opened a permission dialog (TER-615).
  // The tab is where its main thread is: that wait is still the person's to answer, and nothing the
  // main thread sends later would take the tab out of working again. Only the subagent whose own
  // prompt the tab waits on is back at work when it calls a tool: the person approved it. A main thread
  // that waits on its own background work (TER-644) stays there too: those tool calls are that work.
  if (event.kind === 'working' && event.subagent && (isWait(current.state) || current.state === 'waiting_background') && !waitOwnedBy(history, event.subagent)) {
    return { action: 'drop', reason: 'subagent_during_wait' };
  }

  // Claude's idle_prompt fires a minute after any Stop, also one that left background work running. That
  // turn did not end in a question: the tab still waits on its work, not on the person (TER-644).
  if (event.continuesWait && event.keepsWaitText && event.kind === 'waiting_input' && current.state === 'waiting_background') {
    return { action: 'drop', reason: 'reminder_during_background' };
  }

  // Cursor's launch with a prompt fires sessionStart and beforeSubmitPrompt together. When the
  // prompt lands first, the session start must not take the tab out of the turn it announces.
  if (event.kind === 'idle' && event.name === 'sessionStart' && current.state === 'working' && last?.event === 'beforeSubmitPrompt' && last.ageMs <= REORDER_WINDOW_MS) {
    return { action: 'drop', reason: 'session_start_during_turn' };
  }

  // Codex: an Esc denied an approval, and the tool's PostToolUse arrives after the Interrupt that
  // already ended the turn. It is that turn's tail, not a new one (a new turn starts with a prompt or
  // a PreToolUse). After an approval the tab is waiting_permission, and the PostToolUse is recorded.
  // A wait opened by a PreToolUse is a `request_user_input` question: its PostToolUse says the person
  // answered and Codex works again, so it is recorded (and closes the question card). An Esc on that
  // question writes an Interrupt row first, which makes it the latest wait again and drops the tail.
  if (event.kind === 'working' && event.name === 'PostToolUse' && current.state === 'waiting_input' && lastWaitInputRow(history)?.event !== 'PreToolUse') {
    return { action: 'drop', reason: 'post_tool_after_interrupt' };
  }

  if (!isWait(event.kind)) return NEW;

  // Codex's Stop and its notify are one finished turn, in either order. Only across the two names:
  // two notifies in a row (a machine whose hooks are not trusted) are two turns, two waits.
  const partner = event.name === null ? undefined : TURN_END_PARTNER.get(event.name);
  if (partner && event.kind === 'waiting_input' && current.state === 'waiting_input' && last?.event === partner && last.ageMs <= REORDER_WINDOW_MS) {
    return { action: 'record', seen: current.seen ? 'carry' : 'none', continuing: true };
  }

  if (event.continuesWait && event.kind === 'waiting_input' && current.state === 'waiting_input') {
    return { action: 'record', seen: current.seen ? 'carry' : 'none', continuing: true };
  }

  // A reminder (Claude's idle_prompt) is news only when it is the first sign that a turn ended.
  if (event.continuesWait && event.keepsWaitText && event.kind === 'waiting_input') {
    // The dialog is gone and Claude is back at its prompt (an Esc sends no Stop): the state is
    // corrected, and a prompt the person had seen does not alert again.
    if (current.state === 'waiting_permission') return { action: 'record', seen: current.seen ? 'carry' : 'none', continuing: false };
    if (current.state === 'idle') return { action: 'record', seen: 'born', continuing: false };
    if (current.state === 'working' && !current.hasActivity && noTurnSinceLastWait(history)) return { action: 'record', seen: 'born', continuing: false };
  }

  return NEW;
}

/**
 * Whether this event re-arms a wait the person had seen, with no prompt of theirs since: the last
 * `waiting_input` row is at or before their last look, and no prompt event came after it. Permission
 * rows are passed over — a turn of the person with a prompt approved on the way is not a re-arm.
 */
export function rearmOf(current: WaitCurrent, history: HistoryRow[], event: WaitEvent, outcome: WaitOutcome): Rearm | null {
  if (outcome.action !== 'record' || outcome.seen !== 'none' || !isWait(event.kind)) return null;
  if (current.seenAgeMs === null) return null;
  const last = history[0] ?? null;
  for (const row of history) {
    if (row.event !== null && PROMPT_EVENTS.has(row.event)) return null;
    if (row.kind !== 'waiting_input') continue;
    if (current.seenAgeMs > row.ageMs) return null; // their last look is older than that wait
    return { previous: last?.event ?? null, background: row.backgroundTasks, afterSessionEnd: last !== null && last.event !== null && SESSION_END_EVENTS.has(last.event) };
  }
  return null;
}
