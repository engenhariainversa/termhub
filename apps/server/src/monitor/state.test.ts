import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_TEXT_MAX, interpretHookEvent, needsYou } from './state.js';

describe('interpretHookEvent — claude', () => {
  it('maps permission and idle notifications to waiting states with the message', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })).toEqual({
      kind: 'waiting_permission',
      text: 'Claude needs your permission to use Bash',
      meta: { event: 'Notification', type: 'permission_prompt' },
    });
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })?.kind).toBe('waiting_input');
  });

  it('ignores notifications nobody has to act on', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok' })).toBeNull();
  });

  it('marks the tab busy on prompt submit without keeping the prompt', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'secret plans' })).toEqual({ kind: 'working', text: null, meta: { event: 'UserPromptSubmit' } });
  });

  it('treats a finished turn as waiting for the person, like Codex', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop', stop_hook_active: false })).toEqual({ kind: 'waiting_input', text: null, meta: { event: 'Stop' } });
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: '  Pronto. Posso seguir?  ' })?.text).toBe('Pronto. Posso seguir?');
  });

  it('marks the tab idle when the session ends', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'SessionEnd', reason: 'exit' })).toEqual({ kind: 'idle', text: null, meta: { event: 'SessionEnd', reason: 'exit' } });
  });

  it('caps the message', () => {
    const r = interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'x'.repeat(5000) });
    expect(r?.text?.length).toBe(STATE_TEXT_MAX);
  });

  it('returns null for unknown events and non-objects', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'SubagentStop' })).toBeNull();
    expect(interpretHookEvent('claude', 'nope')).toBeNull();
  });

  it('marks only idle_prompt as continuing the wait the Stop before it opened', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })?.continuesWait).toBe(true);
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop' })?.continuesWait).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'Pick one' })?.continuesWait).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow?' })?.continuesWait).toBeUndefined();
  });

  it('maps PreToolUse to working with the tool\'s activity, keeping nothing of the tool input', () => {
    const withInput = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/secret', new_string: 'x' } });
    const without = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    expect(withInput).toEqual({ kind: 'working', text: null, activity: 'coding', verb: null, meta: { event: 'PreToolUse', tool: 'Edit' } });
    expect(withInput).toEqual(without);
    expect(JSON.stringify(withInput)).not.toContain('secret');
  });

  it('maps a PreToolUse without a tool name to plain working', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'PreToolUse' })).toEqual({ kind: 'working', text: null, activity: 'working', verb: null, meta: { event: 'PreToolUse', tool: null } });
  });

  it('carries the spinner verb of a PreToolUse when it is a plain word, and drops anything else', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Edit', verb: 'Moonwalking' })).toEqual({ kind: 'working', text: null, activity: 'coding', verb: 'Moonwalking', meta: { event: 'PreToolUse', tool: 'Edit' } });
    expect(interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Edit' })?.verb).toBeNull();
    for (const bad of ['', 'X', 'Two words', 'Ev"il', 'Construção', 'A'.repeat(25), 42, null, { a: 1 }, 'Brewing…']) {
      expect(interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Edit', verb: bad })?.verb).toBeNull();
    }
    expect(interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Edit', verb: 'A'.repeat(24) })?.verb).toBe('A'.repeat(24));
  });

  it('leaves activity undefined on every other event', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'UserPromptSubmit' })?.activity).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop' })?.activity).toBeUndefined();
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete' })?.activity).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'UserPromptSubmit', verb: 'Brewing' })?.verb).toBeUndefined();
  });
});

describe('interpretHookEvent — codex', () => {
  it('maps agent-turn-complete to waiting_input (its only "needs you" signal) with the last assistant message', () => {
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': 'Done. Want me to run the tests?', 'input-messages': ['private'] })).toEqual({
      kind: 'waiting_input',
      text: 'Done. Want me to run the tests?',
      meta: { event: 'agent-turn-complete' },
    });
  });

  it('ignores other notify types', () => {
    expect(interpretHookEvent('codex', { type: 'something-else' })).toBeNull();
  });

  // captured from codex-cli 0.155.1: the side turn that names a new conversation
  const TITLE_PROMPT =
    "Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\nresponda apenas: um";
  const titleTurn = { type: 'agent-turn-complete', 'thread-id': 'side', client: 'codex-tui', 'input-messages': [TITLE_PROMPT], 'last-assistant-message': '{"title":"Responder apenas um"}' };

  it('ignores the turn Codex runs on a side thread to title the conversation', () => {
    expect(interpretHookEvent('codex', titleTurn)).toBeNull();
    expect(interpretHookEvent('codex', { ...titleTurn, 'last-assistant-message': ' { "title" : "x" } ' })).toBeNull();
  });

  it('keeps a real answer shaped like a title: the person asked for it, and the tab must say Codex finished', () => {
    const asked = { type: 'agent-turn-complete', 'thread-id': 'main', 'input-messages': ['me devolva um JSON com o título do PR'], 'last-assistant-message': '{"title":"Fix login"}' };
    expect(interpretHookEvent('codex', asked)?.text).toBe('{"title":"Fix login"}');
    expect(interpretHookEvent('codex', { ...asked, 'input-messages': undefined })?.kind).toBe('waiting_input');
  });

  it('needs both signals: the title prompt as the only input, and the title-shaped answer', () => {
    // the title prompt with an ordinary answer, or among the person's own messages
    expect(interpretHookEvent('codex', { ...titleTurn, 'last-assistant-message': 'Pronto.' })?.text).toBe('Pronto.');
    expect(interpretHookEvent('codex', { ...titleTurn, 'input-messages': ['um', TITLE_PROMPT] })?.kind).toBe('waiting_input');
    expect(interpretHookEvent('codex', { ...titleTurn, 'input-messages': [TITLE_PROMPT, 'dois'] })?.kind).toBe('waiting_input');
    expect(interpretHookEvent('codex', { ...titleTurn, 'input-messages': 'not a list' })?.kind).toBe('waiting_input');
  });

  it('keeps an answer that only looks like JSON', () => {
    for (const answer of ['{"title":"x","body":"y"}', '{"title":1}', '{"title":', '["title"]', '{}']) {
      expect(interpretHookEvent('codex', { ...titleTurn, 'last-assistant-message': answer })?.text).toBe(answer);
    }
  });

  it('treats every finished turn as a new wait: Codex has no working signal between turns', () => {
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': 'dois' })?.continuesWait).toBeUndefined();
  });
});

describe('interpretHookEvent — cursor', () => {
  // shapes captured from cursor-agent 2026.09.18 (ids shortened, personal fields dropped)
  const base = { conversation_id: 'c1', generation_id: 'g1', cursor_version: '2026.09.18', user_email: 'someone@example.com', workspace_roots: ['/w'] };

  it('marks the tab busy on session start and on each prompt, without keeping the prompt', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'sessionStart', is_background_agent: false })).toEqual({ kind: 'working', text: null, meta: { event: 'sessionStart' } });
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'secret plans', attachments: [] })).toEqual({
      kind: 'working',
      text: null,
      meta: { event: 'beforeSubmitPrompt' },
    });
  });

  it('treats the final answer of a turn as waiting for the person, with the answer as the question', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'afterAgentResponse', text: '  Pronto. Posso seguir?  ' })).toEqual({
      kind: 'waiting_input',
      text: 'Pronto. Posso seguir?',
      meta: { event: 'afterAgentResponse' },
      continuesWait: true,
    });
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'afterAgentResponse', text: 'x'.repeat(5000) })?.text?.length).toBe(STATE_TEXT_MAX);
  });

  it('treats a completed stop as a continuation too, so a lost answer still unsticks the tab', () => {
    // the answer usually opened the wait already (recordEvent then keeps its text and its seen mark);
    // when its POST never arrived, this is the only event left to say the turn ended
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'stop', status: 'completed', loop_count: 0 })).toEqual({
      kind: 'waiting_input',
      text: null,
      meta: { event: 'stop', status: 'completed' },
      continuesWait: true,
    });
  });

  it('opens a wait on a stop that ended without an answer (aborted with Esc, or an error)', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'stop', status: 'aborted', loop_count: 0 })).toEqual({
      kind: 'waiting_input',
      text: null,
      meta: { event: 'stop', status: 'aborted' },
      continuesWait: true,
    });
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'stop', status: 'error', loop_count: 0 })?.kind).toBe('waiting_input');
  });

  it('marks answer and stop as continuing a wait already open: never a second alert in one turn', () => {
    // Esc sends two stops (error, then aborted); afterAgentResponse after an inverted stop must not re-arm
    for (const status of ['completed', 'aborted', 'error', 'renamed-in-a-later-release', undefined]) {
      expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'stop', status })?.continuesWait).toBe(true);
    }
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'afterAgentResponse', text: 'um' })?.continuesWait).toBe(true);
  });

  it('marks the tab idle when the session ends', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'sessionEnd', reason: 'completed', final_status: 'completed' })).toEqual({ kind: 'idle', text: null, meta: { event: 'sessionEnd', reason: 'completed' } });
  });

  it('returns null for events it does not subscribe to and for non-objects', () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'beforeShellExecution', command: 'pwd' })).toBeNull();
    expect(interpretHookEvent('cursor', 'nope')).toBeNull();
  });
});

describe('needsYou', () => {
  it('is true while waiting and never seen', () => {
    expect(needsYou({ state: 'waiting_input', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: null })).toBe(true);
    expect(needsYou({ state: 'waiting_permission', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: null })).toBe(true);
  });

  it('is false once seen at or after the state started', () => {
    expect(needsYou({ state: 'waiting_input', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(needsYou({ state: 'waiting_input', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: '2026-01-01T00:01:00.000Z' })).toBe(false);
  });

  it('is true again when seen before the (newer) state_at — a new event re-arms it', () => {
    expect(needsYou({ state: 'waiting_input', state_at: '2026-01-01T00:02:00.000Z', state_seen_at: '2026-01-01T00:01:00.000Z' })).toBe(true);
  });

  it('is false outside NEEDS_YOU states, and when state_at is null', () => {
    expect(needsYou({ state: 'working', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: null })).toBe(false);
    expect(needsYou({ state: 'idle', state_at: '2026-01-01T00:00:00.000Z', state_seen_at: null })).toBe(false);
    expect(needsYou({ state: null, state_at: null, state_seen_at: null })).toBe(false);
    expect(needsYou({ state: 'waiting_input', state_at: null, state_seen_at: null })).toBe(false);
  });
});

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../chat/fixtures/tab-questions', name), 'utf8')) as Record<string, unknown>;

describe('interpretHookEvent — claude questions (spec 2026-09-25 §4.2)', () => {
  it('an AskUserQuestion PreToolUse stays working and carries the normalised question and its tool_use_id', () => {
    const r = interpretHookEvent('claude', fixture('pretooluse-ask-two-questions.json'));
    expect(r).toMatchObject({ kind: 'working', text: null, activity: 'planning', meta: { event: 'PreToolUse', tool: 'AskUserQuestion' } });
    expect(r?.question?.kind).toBe('choice');
    expect(r?.question?.tool_use_id).toBe('toolu_01XsgR974r49WEBYg2aeDAGq');
    expect(r?.question?.kind === 'choice' && r.question.payload.questions[0]!.options[0]).toEqual({ label: 'Blue', description: 'Calm and classic.', recommended: true });
  });

  it('keeps nothing of the question outside `question`: not in meta, not in text', () => {
    const r = interpretHookEvent('claude', fixture('pretooluse-ask-two-questions.json'))!;
    const { question: _question, ...rest } = r;
    expect(JSON.stringify(rest)).not.toContain('favorite');
    expect(JSON.stringify(rest)).not.toContain('/home/dev');
  });

  it('drops a question whose input does not parse, and the event still reads as working', () => {
    const r = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
    expect(r).toEqual({ kind: 'working', text: null, activity: 'planning', verb: null, meta: { event: 'PreToolUse', tool: 'AskUserQuestion' } });
  });

  it('never builds a question from another tool\'s input', () => {
    const r = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: fixture('pretooluse-ask-two-questions.json').tool_input });
    expect(r?.question).toBeUndefined();
  });

  it('a PermissionRequest is waiting_permission with a permission question naming the tool only', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toEqual({
      kind: 'waiting_permission',
      text: null,
      meta: { event: 'PermissionRequest', tool: 'Bash' },
      question: { kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null },
    });
    // The whole captured event (an old script, or a future one) still yields the name only.
    const whole = interpretHookEvent('claude', fixture('permissionrequest-bash.json'));
    expect(JSON.stringify(whole)).not.toContain('probe-file');
    expect(whole?.question).toEqual({ kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null });
  });

  it('AskUserQuestion\'s own PermissionRequest opens nothing (its PreToolUse did), and an odd name neither', () => {
    expect(interpretHookEvent('claude', fixture('permissionrequest-ask-one-question.json'))).toEqual({ kind: 'waiting_permission', text: null, meta: { event: 'PermissionRequest', tool: 'AskUserQuestion' } });
    expect(interpretHookEvent('claude', { hook_event_name: 'PermissionRequest', tool_name: 'a b' })?.question).toBeUndefined();
  });

  it('ExitPlanMode\'s PermissionRequest opens nothing: its dialog is not a yes/no permission prompt', () => {
    // Its "1" is "Yes, and use auto mode" and its footer never passes the live check.
    expect(interpretHookEvent('claude', { hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode' })).toEqual({
      kind: 'waiting_permission',
      text: null,
      meta: { event: 'PermissionRequest', tool: 'ExitPlanMode' },
    });
  });

  it('the permission_prompt notification that follows is unchanged', () => {
    expect(interpretHookEvent('claude', fixture('notification-permission-prompt.json'))).toEqual({
      kind: 'waiting_permission',
      text: 'Claude needs your permission',
      meta: { event: 'Notification', type: 'permission_prompt' },
    });
  });
});
