import { describe, expect, it } from 'vitest';
import { HISTORY_ROWS, REORDER_WINDOW_MS, decideWait, rearmOf, type HistoryRow, type WaitCurrent, type WaitEvent, type WaitOutcome } from './wait-decision.js';

const current = (over: Partial<WaitCurrent> = {}): WaitCurrent => ({ state: null, seen: false, hasActivity: false, seenAgeMs: null, ...over });
const event = (over: Partial<WaitEvent> = {}): WaitEvent => ({ kind: 'waiting_input', name: 'Stop', continuesWait: false, keepsWaitText: false, ...over });
/** One event row. `ageMs` is how long ago it was written; the history is newest first. */
const row = (kind: HistoryRow['kind'], name: string | null, ageMs = 1_000, backgroundTasks = false, subagent: HistoryRow['subagent'] = null): HistoryRow => ({ kind, event: name, ageMs, backgroundTasks, subagent });

/** Claude's idle_prompt: the one event that is only a reminder. */
const reminder = event({ name: 'Notification', continuesWait: true, keepsWaitText: true });
/** Cursor's stop or afterAgentResponse: continues a wait, and may bring the answer. */
const continuation = event({ name: 'stop', continuesWait: true });

const NEW: WaitOutcome = { action: 'record', seen: 'none', continuing: false };
const BORN: WaitOutcome = { action: 'record', seen: 'born', continuing: false };

describe('decideWait — events that are not a wait', () => {
  it('records working, idle and error as they come, with no seen mark', () => {
    for (const kind of ['working', 'idle', 'error'] as const) {
      expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop')], event({ kind, name: 'UserPromptSubmit' }))).toEqual(NEW);
    }
  });

  it('never drops anything because a session ended', () => {
    const ended = [row('idle', 'SessionEnd'), row('working', 'UserPromptSubmit', 5_000)];
    expect(decideWait(current({ state: 'idle' }), ended, event())).toEqual(NEW);
    expect(decideWait(current({ state: 'idle' }), ended, event({ kind: 'waiting_permission', name: 'PermissionRequest' }))).toEqual(NEW);
    expect(decideWait(current({ state: 'idle' }), [row('idle', 'sessionEnd')], continuation)).toEqual(NEW);
    // Codex in a tab where Claude ended: its only event is a wait
    expect(decideWait(current({ state: 'idle' }), ended, event({ name: 'agent-turn-complete' }))).toEqual(NEW);
  });
});

describe('decideWait — what tabs.db.test.ts pins today', () => {
  it('a continuation of a seen waiting_input carries the seen mark', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'afterAgentResponse')], continuation)).toEqual({ action: 'record', seen: 'carry', continuing: true });
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop')], reminder)).toEqual({ action: 'record', seen: 'carry', continuing: true });
  });

  it('a continuation of an unseen waiting_input stays unseen', () => {
    expect(decideWait(current({ state: 'waiting_input' }), [row('waiting_input', 'Stop')], continuation)).toEqual({ action: 'record', seen: 'none', continuing: true });
  });

  it('a wait that does not say it continues is a new one, even right after a seen wait (the next Codex turn)', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'agent-turn-complete')], event({ name: 'agent-turn-complete' }))).toEqual(NEW);
  });

  it('a permission prompt is always a new request', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop')], event({ kind: 'waiting_permission', name: 'PermissionRequest' }))).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_permission', seen: true }), [row('waiting_permission', 'PermissionRequest')], event({ kind: 'waiting_permission', name: 'Notification' }))).toEqual(NEW);
  });

  it('a continuation that finds the tab working opens the wait (Cursor: a lost answer, then stop)', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt')], continuation)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', null)], continuation)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [], continuation)).toEqual(NEW);
  });
});

describe('decideWait — a reminder never opens an alert by itself', () => {
  it('over a permission wait, it takes the tab to waiting_input and carries the seen mark', () => {
    // an Esc on the dialog sends no Stop: the reminder is what says Claude is back at its prompt
    expect(decideWait(current({ state: 'waiting_permission', seen: true }), [row('waiting_permission', 'Notification')], reminder)).toEqual({ action: 'record', seen: 'carry', continuing: false });
  });

  it('over a permission wait the person has not seen, it stays unseen', () => {
    expect(decideWait(current({ state: 'waiting_permission' }), [row('waiting_permission', 'PermissionRequest')], reminder)).toEqual(NEW);
  });

  it('is born seen after /clear: a wait, the session end, the session start', () => {
    const cleared = [row('working', 'SessionStart'), row('idle', 'SessionEnd', 1_100), row('waiting_input', 'Stop', 90_000)];
    expect(decideWait(current({ state: 'working' }), cleared, reminder)).toEqual(BORN);
  });

  it('is born seen after a reply typed from termhub that started no turn', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'input'), row('waiting_input', 'Stop', 5_000)], reminder)).toEqual(BORN);
  });

  it('is born seen on a session that was never asked anything', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'SessionStart')], reminder)).toEqual(BORN);
  });

  it('alerts when a turn was running: the Stop was lost and this is what ends it', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'UserPromptSubmit'), row('waiting_input', 'Stop', 9_000)], reminder)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', 'PreToolUse'), row('waiting_input', 'Stop', 9_000)], reminder)).toEqual(NEW);
  });

  it('alerts after a compaction in the middle of a turn: the session start is quiet, what came before it is not', () => {
    const compacted = [row('working', 'SessionStart'), row('working', 'UserPromptSubmit', 60_000), row('waiting_input', 'Stop', 90_000)];
    expect(decideWait(current({ state: 'working' }), compacted, reminder)).toEqual(NEW);
    const afterTools = [row('working', 'SessionStart'), row('working', 'PreToolUse', 60_000), row('waiting_input', 'Stop', 90_000)];
    expect(decideWait(current({ state: 'working' }), afterTools, reminder)).toEqual(NEW);
  });

  it('alerts when tool calls followed a quiet event: the light path leaves no row, only the activity', () => {
    expect(decideWait(current({ state: 'working', hasActivity: true }), [row('working', 'SessionStart'), row('waiting_input', 'Stop', 9_000)], reminder)).toEqual(NEW);
  });

  it('alerts when nothing is known about the working state', () => {
    expect(decideWait(current({ state: 'working' }), [], reminder)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', null)], reminder)).toEqual(NEW);
  });

  it('alerts when an error sits between the quiet row and the last wait', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'SessionStart'), row('error', 'StopFailure', 5_000), row('waiting_input', 'Stop', 9_000)], reminder)).toEqual(NEW);
  });

  it('is born seen on an idle tab', () => {
    expect(decideWait(current({ state: 'idle' }), [row('idle', 'SessionEnd')], reminder)).toEqual(BORN);
  });

  it('alerts on a tab in error or with no state, as today', () => {
    expect(decideWait(current({ state: 'error' }), [row('error', 'StopFailure')], reminder)).toEqual(NEW);
    expect(decideWait(current({ state: null }), [], reminder)).toEqual(NEW);
  });

  it('only a reminder is born seen: a Cursor continuation after a quiet start is a new wait', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'SessionStart')], continuation)).toEqual(NEW);
  });

  it('alerts when the rows that are kept ran out before a wait was found: a prompt may sit just beyond them', () => {
    const full = Array.from({ length: HISTORY_ROWS }, (_, i) => row('working', 'SessionStart', 1_000 * (i + 1)));
    expect(decideWait(current({ state: 'working' }), full, reminder)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), full.slice(1), reminder)).toEqual(BORN);
  });

  it('never treats a permission event as a reminder, whatever it is flagged with', () => {
    const flagged = event({ kind: 'waiting_permission', name: 'Notification', continuesWait: true, keepsWaitText: true });
    expect(decideWait(current({ state: 'idle' }), [row('idle', 'SessionEnd')], flagged)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', 'SessionStart')], flagged)).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_permission', seen: true }), [row('waiting_permission', 'PermissionRequest')], flagged)).toEqual(NEW);
  });
});

describe('decideWait — a Cursor session start that arrives after its own prompt', () => {
  const sessionStart = event({ kind: 'idle', name: 'sessionStart' });

  it('is dropped while the prompt is fresh: the two hooks were posted together', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt', 200)], sessionStart)).toEqual({ action: 'drop', reason: 'session_start_during_turn' });
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt', REORDER_WINDOW_MS)], sessionStart)).toEqual({ action: 'drop', reason: 'session_start_during_turn' });
  });

  it('is recorded once the prompt is older than the window: that session is a new one', () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt', REORDER_WINDOW_MS + 1)], sessionStart)).toEqual(NEW);
  });

  it('is recorded when the tab is not working, or works for another reason', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'stop')], sessionStart)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', 'PreToolUse', 200)], sessionStart)).toEqual(NEW);
    expect(decideWait(current({ state: null }), [], sessionStart)).toEqual(NEW);
  });

  it("does not touch Claude's SessionStart, which is a working event", () => {
    expect(decideWait(current({ state: 'working' }), [row('working', 'beforeSubmitPrompt', 200)], event({ kind: 'working', name: 'SessionStart' }))).toEqual(NEW);
  });
});

describe('rearmOf — a wait alerts although the person had seen the last one and asked for nothing since', () => {
  it('reports an answer nobody asked for, and that the seen wait had background tasks', () => {
    const history = [row('working', 'PreToolUse', 1_000), row('waiting_input', 'Stop', 60_000, true)];
    expect(rearmOf(current({ state: 'working', seenAgeMs: 30_000 }), history, event(), NEW)).toEqual({ previous: 'PreToolUse', background: true, afterSessionEnd: false });
  });

  it('reports a wait that follows a seen wait directly (the next Codex turn)', () => {
    const history = [row('waiting_input', 'agent-turn-complete', 60_000)];
    expect(rearmOf(current({ state: 'waiting_input', seen: true, seenAgeMs: 30_000 }), history, event({ name: 'agent-turn-complete' }), NEW)).toEqual({ previous: 'agent-turn-complete', background: false, afterSessionEnd: false });
  });

  it('reports a wait that lands after the session ended', () => {
    const history = [row('idle', 'SessionEnd', 2_000), row('waiting_input', 'Stop', 60_000)];
    expect(rearmOf(current({ state: 'idle', seenAgeMs: 30_000 }), history, event(), NEW)).toEqual({ previous: 'SessionEnd', background: false, afterSessionEnd: true });
  });

  it('is silent when the person asked for the turn', () => {
    for (const prompt of ['UserPromptSubmit', 'beforeSubmitPrompt', 'input']) {
      const history = [row('working', prompt, 5_000), row('waiting_input', 'Stop', 60_000)];
      expect(rearmOf(current({ state: 'working', seenAgeMs: 30_000 }), history, event(), NEW)).toBeNull();
    }
  });

  it('is silent for a turn of the person that had a permission prompt approved on the way', () => {
    const history = [row('working', 'PreToolUse', 1_000), row('waiting_permission', 'Notification', 4_000), row('waiting_permission', 'PermissionRequest', 4_100), row('working', 'UserPromptSubmit', 9_000), row('waiting_input', 'Stop', 60_000)];
    expect(rearmOf(current({ state: 'working', seenAgeMs: 3_000 }), history, event(), NEW)).toBeNull();
  });

  it('is silent when the last wait had not been seen', () => {
    const history = [row('waiting_input', 'agent-turn-complete', 60_000)];
    expect(rearmOf(current({ state: 'waiting_input', seenAgeMs: 90_000 }), history, event(), NEW)).toBeNull();
    expect(rearmOf(current({ state: 'waiting_input', seenAgeMs: null }), history, event(), NEW)).toBeNull();
  });

  it('counts a look at the very moment of the wait as seen', () => {
    expect(rearmOf(current({ state: 'waiting_input', seen: true, seenAgeMs: 60_000 }), [row('waiting_input', 'Stop', 60_000)], event(), NEW)).not.toBeNull();
  });

  it('is silent for the first wait of a tab, and when no wait is in the rows that are kept', () => {
    expect(rearmOf(current({ seenAgeMs: null }), [], event(), NEW)).toBeNull();
    expect(rearmOf(current({ state: 'working', seenAgeMs: 1_000 }), [row('working', 'PreToolUse')], event(), NEW)).toBeNull();
  });

  it('is silent when the event does not alert: not a wait, seen from the start, or dropped', () => {
    const history = [row('waiting_input', 'Stop', 60_000)];
    const seen = current({ state: 'waiting_input', seen: true, seenAgeMs: 30_000 });
    expect(rearmOf(seen, history, event({ kind: 'working', name: 'PreToolUse' }), NEW)).toBeNull();
    expect(rearmOf(seen, history, reminder, { action: 'record', seen: 'carry', continuing: true })).toBeNull();
    expect(rearmOf(seen, history, reminder, BORN)).toBeNull();
    expect(rearmOf(seen, history, event({ kind: 'idle', name: 'sessionStart' }), { action: 'drop', reason: 'session_start_during_turn' })).toBeNull();
  });
});

describe('decideWait — Codex: one finished turn, one alert (spec 2026-09-29 codex monitor hooks D4, D5)', () => {
  const stop = event({ name: 'Stop' });
  const notify = event({ name: 'agent-turn-complete' });
  const CONTINUES_SEEN: WaitOutcome = { action: 'record', seen: 'carry', continuing: true };
  const CONTINUES_UNSEEN: WaitOutcome = { action: 'record', seen: 'none', continuing: true };

  it('a notify right after its Stop continues that wait', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop', 500)], notify)).toEqual(CONTINUES_SEEN);
    expect(decideWait(current({ state: 'waiting_input' }), [row('waiting_input', 'Stop', 500)], notify)).toEqual(CONTINUES_UNSEEN);
  });

  it('a Stop right after its notify (the other order) continues that wait', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'agent-turn-complete', 500)], stop)).toEqual(CONTINUES_SEEN);
    expect(decideWait(current({ state: 'waiting_input' }), [row('waiting_input', 'agent-turn-complete', 500)], stop)).toEqual(CONTINUES_UNSEEN);
  });

  it('pairs up to the reorder window, not beyond it', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop', REORDER_WINDOW_MS)], notify)).toEqual(CONTINUES_SEEN);
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop', REORDER_WINDOW_MS + 1)], notify)).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'agent-turn-complete', REORDER_WINDOW_MS + 1)], stop)).toEqual(NEW);
  });

  it('two notifies in a row stay two waits (a machine whose hooks are not trusted)', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'agent-turn-complete', 500)], notify)).toEqual(NEW);
  });

  it('two Stops in a row stay two waits', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Stop', 500)], stop)).toEqual(NEW);
  });

  it('pairs only while the tab still waits for input', () => {
    expect(decideWait(current({ state: 'working' }), [row('waiting_input', 'Stop', 500)], notify)).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_permission', seen: true }), [row('waiting_input', 'Stop', 500)], notify)).toEqual(NEW);
  });

  it('pairs only with the last row', () => {
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Interrupt', 200), row('waiting_input', 'Stop', 500)], notify)).toEqual(NEW);
  });

  it('drops a PostToolUse that lands on a waiting_input tab: the late tail of an Esc', () => {
    const post = event({ kind: 'working', name: 'PostToolUse' });
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Interrupt', 200)], post)).toEqual({ action: 'drop', reason: 'post_tool_after_interrupt' });
    expect(decideWait(current({ state: 'waiting_input' }), [row('waiting_input', 'Stop', 200)], post)).toEqual({ action: 'drop', reason: 'post_tool_after_interrupt' });
  });

  it('records the PostToolUse of an answered Codex question: the question was the wait, not an Esc', () => {
    const post = event({ kind: 'working', name: 'PostToolUse' });
    expect(decideWait(current({ state: 'waiting_input' }), [row('waiting_input', 'PreToolUse', 5_000)], post)).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'PreToolUse', 5_000)], post)).toEqual(NEW);
  });

  it('still drops the PostToolUse when the question was dismissed with an Esc', () => {
    const post = event({ kind: 'working', name: 'PostToolUse' });
    expect(decideWait(current({ state: 'waiting_input' }), [row('waiting_input', 'Interrupt', 200), row('waiting_input', 'PreToolUse', 5_000)], post)).toEqual({ action: 'drop', reason: 'post_tool_after_interrupt' });
  });

  it('records a PostToolUse after an approval: the tab is working again', () => {
    const post = event({ kind: 'working', name: 'PostToolUse' });
    expect(decideWait(current({ state: 'waiting_permission', seen: true }), [row('waiting_permission', 'PermissionRequest', 2_000)], post)).toEqual(NEW);
    expect(decideWait(current({ state: 'working' }), [row('working', 'PreToolUse', 2_000)], post)).toEqual(NEW);
  });

  it('records a PreToolUse on a waiting_input tab (a new turn, not a tail)', () => {
    expect(decideWait(current({ state: 'waiting_input' }), [row('waiting_input', 'Stop', 200)], event({ kind: 'working', name: 'PreToolUse' }))).toEqual(NEW);
  });
});

describe('decideWait — a subagent in the background never takes the tab out of its main thread\'s wait (TER-615)', () => {
  /** A subagent's tool call: `id` is its agent id, null when an older hook script sent only the flag. */
  const subagentTool = (id: string | null = 'a1', name = 'PreToolUse') => event({ kind: 'working', name, subagent: { id } });
  const DROP: WaitOutcome = { action: 'drop', reason: 'subagent_during_wait' };

  it('drops a subagent tool call that lands after the Stop of a turn that left it running', () => {
    const history = [row('waiting_input', 'Stop', 500, true), row('working', 'UserPromptSubmit', 30_000)];
    expect(decideWait(current({ state: 'waiting_input' }), history, subagentTool())).toEqual(DROP);
    expect(decideWait(current({ state: 'waiting_input' }), history, subagentTool(null))).toEqual(DROP);
    // and after the idle_prompt that reminds of the same wait
    expect(decideWait(current({ state: 'waiting_input', seen: true }), [row('waiting_input', 'Notification'), ...history], subagentTool())).toEqual(DROP);
  });

  it('drops it while the main thread asks a question or waits for a permission (the hulk case: SubagentHandback after the question)', () => {
    const history = [row('waiting_permission', 'Notification', 15_000), row('working', 'PreToolUse', 21_000), row('working', 'UserPromptSubmit', 60_000)];
    expect(decideWait(current({ state: 'waiting_permission' }), history, subagentTool(null))).toEqual(DROP);
    const mainDialog = [row('waiting_permission', 'Notification', 1_000), row('waiting_permission', 'PermissionRequest', 1_500)];
    expect(decideWait(current({ state: 'waiting_permission' }), mainDialog, subagentTool('a1'))).toEqual(DROP);
  });

  it('records the tool call that follows that same subagent\'s own permission prompt (the person approved it)', () => {
    const own = [row('waiting_permission', 'Notification', 1_000), row('waiting_permission', 'PermissionRequest', 1_500, false, { id: 'a1' }), row('waiting_input', 'Stop', 9_000, true)];
    expect(decideWait(current({ state: 'waiting_permission' }), own, subagentTool('a1'))).toEqual(NEW);
    // an older script names nobody: the flag alone is enough to pair them
    const flagOnly = [row('waiting_permission', 'PermissionRequest', 1_500, false, { id: null })];
    expect(decideWait(current({ state: 'waiting_permission' }), flagOnly, subagentTool(null))).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_permission' }), flagOnly, subagentTool('a1'))).toEqual(NEW);
  });

  it('drops a tool call of another subagent than the one whose prompt is open', () => {
    const other = [row('waiting_permission', 'PermissionRequest', 1_500, false, { id: 'a2' })];
    expect(decideWait(current({ state: 'waiting_permission' }), other, subagentTool('a1'))).toEqual(DROP);
  });

  it('leaves a subagent\'s own wait and every main-thread event alone', () => {
    const history = [row('waiting_input', 'Stop', 500, true)];
    expect(decideWait(current({ state: 'waiting_input' }), history, event({ kind: 'waiting_permission', name: 'PermissionRequest', subagent: { id: 'a1' } }))).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_input' }), history, event({ kind: 'working', name: 'UserPromptSubmit' }))).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_input' }), history, event({ kind: 'working', name: 'PreToolUse' }))).toEqual(NEW);
    // a working tab takes the subagent's tool call as it always did
    expect(decideWait(current({ state: 'working' }), [row('working', 'UserPromptSubmit')], subagentTool())).toEqual(NEW);
  });
});

describe('decideWait — a main thread waiting on its own background work (TER-644)', () => {
  const background = [row('waiting_background', 'Stop', 500, true), row('working', 'UserPromptSubmit', 30_000)];

  it('drops the tool calls of the subagents it waits on', () => {
    for (const id of ['a1', null]) {
      expect(decideWait(current({ state: 'waiting_background' }), background, event({ kind: 'working', name: 'PreToolUse', subagent: { id } }))).toEqual({ action: 'drop', reason: 'subagent_during_wait' });
    }
  });

  it('drops the idle_prompt that follows that Stop: the turn did not end in a question', () => {
    expect(decideWait(current({ state: 'waiting_background' }), background, reminder)).toEqual({ action: 'drop', reason: 'reminder_during_background' });
  });

  it('records what moves it on: the main thread back at work, the real end of the work, a permission prompt', () => {
    expect(decideWait(current({ state: 'waiting_background' }), background, event({ kind: 'working', name: 'PreToolUse' }))).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_background' }), background, event({ kind: 'waiting_input', name: 'Stop' }))).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_background' }), background, event({ kind: 'waiting_permission', name: 'PermissionRequest', subagent: { id: 'a1' } }))).toEqual(NEW);
    expect(decideWait(current({ state: 'waiting_background' }), background, event({ kind: 'idle', name: 'SessionEnd' }))).toEqual(NEW);
  });

  it('a Stop that leaves background work is no wait to re-arm', () => {
    const outcome = decideWait(current({ state: 'working', seenAgeMs: 30_000 }), [row('working', 'PreToolUse', 500), row('waiting_input', 'Stop', 60_000)], event({ kind: 'waiting_background', name: 'Stop' }));
    expect(outcome).toEqual(NEW);
    expect(rearmOf(current({ state: 'working', seenAgeMs: 30_000 }), [row('working', 'PreToolUse', 500), row('waiting_input', 'Stop', 60_000)], event({ kind: 'waiting_background', name: 'Stop' }), outcome)).toBeNull();
  });
});
