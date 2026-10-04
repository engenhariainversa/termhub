import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAST_ANSWER_MAX, NEEDS_YOU, STATE_TEXT_MAX, claudeSessionOf, interpretHookEvent, isRateLimit, needsYou, runningBackgroundTasks } from './state.js';
import { activityOf } from './activity.js';

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
    expect(interpretHookEvent('claude', { hook_event_name: 'PostToolBatch' })).toBeNull();
    expect(interpretHookEvent('claude', 'nope')).toBeNull();
  });

  it('marks only idle_prompt as continuing the wait the Stop before it opened', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })?.continuesWait).toBe(true);
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop' })?.continuesWait).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'Pick one' })?.continuesWait).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow?' })?.continuesWait).toBeUndefined();
  });

  it("only idle_prompt keepsWaitText: its own message is a generic reminder, never the turn's answer (spec 2026-09-26 §6.1)", () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })?.keepsWaitText).toBe(true);
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: 'Posso seguir?' })?.keepsWaitText).toBeUndefined();
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

describe('interpretHookEvent — claude subagents (spec 2026-09-26 §4.5)', () => {
  it('flags an event the script marked, or one that carries its own agent_id', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', subagent: true })).toEqual({
      kind: 'working', text: null, activity: 'terminal', verb: null, meta: { event: 'PreToolUse', tool: 'Bash', subagent: true },
    });
    expect(interpretHookEvent('claude', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', subagent: true })).toMatchObject({ kind: 'waiting_permission', meta: { subagent: true }, question: { kind: 'permission' } });
    // An AskUserQuestion travels whole, keys in Claude Code's order: its agent_id says it.
    const ask = {
      session_id: 's1', transcript_path: '/x.jsonl', cwd: '/w', prompt_id: 'p1', permission_mode: 'default', agent_id: 'a1b2c3', agent_type: 'general-purpose',
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Qual cor?', header: 'Cor', options: [{ label: 'Azul' }, { label: 'Verde' }], multiSelect: false }] }, tool_use_id: 'toolu_9',
    };
    expect(interpretHookEvent('claude', ask)).toMatchObject({ meta: { subagent: true }, question: { kind: 'choice' } });
  });

  it.each([
    ['no flag (an old script, or the main thread)', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
    ['a flag that is not the boolean true', { hook_event_name: 'PreToolUse', tool_name: 'Bash', subagent: 'true' }],
    ['an empty agent_id', { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: '' }],
    ['a blank agent_id', { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: '  ' }],
    ['a non-string agent_id', { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 7 }],
    ['a Stop (subagents end with SubagentStop, which we ignore)', { hook_event_name: 'Stop', last_assistant_message: 'ok' }],
  ])('does not flag %s', (_label, ev) => {
    expect(interpretHookEvent('claude', ev)?.meta).not.toHaveProperty('subagent');
  });
});

describe('interpretHookEvent — claude subagent ids (spec 2026-09-30 tab questions per subagent)', () => {
  const A = 'ac5724783efd1ee13';

  it("carries the subagent's id on its PreToolUse and PermissionRequest", () => {
    const pre = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', subagent: true, agent_id: A });
    expect(pre?.meta).toEqual({ event: 'PreToolUse', tool: 'Bash', subagent: true, agent_id: A });
    const perm = interpretHookEvent('claude', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', subagent: true, agent_id: A });
    expect(perm?.meta.subagent).toBe(true);
    expect(perm?.meta.agent_id).toBe(A);
    expect(perm?.question).toMatchObject({ kind: 'permission' });
  });

  it('carries the id of a whole AskUserQuestion, question included', () => {
    const ask = {
      session_id: 's1', transcript_path: '/x.jsonl', cwd: '/w', prompt_id: 'p1', permission_mode: 'default', agent_id: A, agent_type: 'general-purpose',
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Qual cor?', header: 'Cor', options: [{ label: 'Azul' }, { label: 'Verde' }], multiSelect: false }] }, tool_use_id: 'toolu_9',
    };
    const out = interpretHookEvent('claude', ask);
    expect(out?.meta).toMatchObject({ subagent: true, agent_id: A });
    expect(out?.question).toMatchObject({ kind: 'choice' });
  });

  it.each([
    ['no agent_id', undefined],
    ['an id with a dot', 'a.b'],
    ['an id of 65 characters', 'a'.repeat(65)],
    ['an id with spaces around it', ' ac57 '],
  ])('keeps the flag and no agent_id key for %s', (_label, id) => {
    const out = interpretHookEvent('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', subagent: true, ...(id === undefined ? {} : { agent_id: id }) });
    expect(out?.meta.subagent).toBe(true);
    expect(out?.meta).not.toHaveProperty('agent_id');
  });

  it("gives the main thread's events neither key", () => {
    for (const ev of [{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, { hook_event_name: 'Stop', last_assistant_message: 'ok' }]) {
      const meta = interpretHookEvent('claude', ev)?.meta;
      expect(meta).not.toHaveProperty('subagent');
      expect(meta).not.toHaveProperty('agent_id');
    }
  });

  it('never gives a Codex event an agent_id', () => {
    const out = interpretHookEvent('codex', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', agent_id: A, tool_input: { command: 'ls', description: 'Listar?' } });
    expect(out?.meta.subagent).toBe(true);
    expect(out?.meta).not.toHaveProperty('agent_id');
  });

  it('reads a SubagentStop with an id as a close-only event', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'SubagentStop', subagent: true, agent_id: A })).toEqual({
      kind: 'working', text: null, closeOnly: true, meta: { event: 'SubagentStop', subagent: true, agent_id: A },
    });
  });

  it.each([
    ['no id', { hook_event_name: 'SubagentStop', subagent: true }],
    ['an id with a dot', { hook_event_name: 'SubagentStop', subagent: true, agent_id: 'a.b' }],
    ['an id of 65 characters', { hook_event_name: 'SubagentStop', subagent: true, agent_id: 'a'.repeat(65) }],
  ])('ignores a SubagentStop with %s', (_label, ev) => {
    expect(interpretHookEvent('claude', ev)).toBeNull();
  });
});

describe('interpretHookEvent — codex', () => {
  it('maps agent-turn-complete to waiting_input (its only "needs you" signal) with the last assistant message', () => {
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': 'Done. Want me to run the tests?', 'input-messages': ['private'] })).toEqual({
      kind: 'waiting_input',
      text: 'Done. Want me to run the tests?',
      meta: { event: 'agent-turn-complete' },
      answer: 'Done. Want me to run the tests?',
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

describe('interpretHookEvent — codex hooks', () => {
  // shapes captured from codex-cli 0.159.2 on hulk (spec 2026-09-29 codex monitor hooks §2), ids shortened
  const base = { session_id: 's1', turn_id: 't1', transcript_path: '/home/x/.codex/sessions/r.jsonl', cwd: '/w' };
  const COMMAND = 'touch hello.txt && echo segredo';
  const permission = {
    ...base,
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: COMMAND, description: '  Allow creating hello.txt in /w? The workspace sandbox is read-only.  ' },
  };

  it('maps UserPromptSubmit to working and keeps nothing of the prompt', () => {
    expect(interpretHookEvent('codex', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'meu pedido' })).toEqual({ kind: 'working', text: null, meta: { event: 'UserPromptSubmit' } });
  });

  it('maps the reduced PreToolUse and PostToolUse to working with the tool activity', () => {
    for (const name of ['PreToolUse', 'PostToolUse']) {
      expect(interpretHookEvent('codex', { hook_event_name: name, tool_name: 'Bash' })).toEqual({ kind: 'working', text: null, activity: activityOf('Bash'), verb: null, meta: { event: name, tool: 'Bash' } });
    }
    expect(interpretHookEvent('codex', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch' })?.activity).toBe(activityOf('apply_patch'));
  });

  it('maps PermissionRequest to waiting_permission with the description as text', () => {
    expect(interpretHookEvent('codex', permission)).toEqual({
      kind: 'waiting_permission',
      text: 'Allow creating hello.txt in /w? The workspace sandbox is read-only.',
      meta: { event: 'PermissionRequest', tool: 'Bash' },
      question: { kind: 'permission', payload: { tool_name: 'Bash', agent: 'codex', question: 'Allow creating hello.txt in /w? The workspace sandbox is read-only.' }, tool_use_id: null },
    });
  });

  it('never keeps the command of a PermissionRequest', () => {
    for (const ev of [permission, { ...permission, tool_input: { command: COMMAND } }, { ...permission, tool_input: { command: COMMAND, description: 42 } }]) {
      const out = interpretHookEvent('codex', ev);
      expect(JSON.stringify(out)).not.toContain('segredo');
      expect(JSON.stringify(out)).not.toContain('hello.txt &&');
    }
  });

  it('opens a permission card with the description as its question, never the command', () => {
    const out = interpretHookEvent('codex', permission);
    expect(out?.question).toEqual({
      kind: 'permission',
      payload: { tool_name: 'Bash', agent: 'codex', question: 'Allow creating hello.txt in /w? The workspace sandbox is read-only.' },
      tool_use_id: null,
    });
    expect(JSON.stringify(out)).not.toContain('hello.txt &&');
    expect(JSON.stringify(out)).not.toContain('segredo');
  });

  it('opens a permission card without a question when there is no description, and none for a bad tool name', () => {
    for (const tool_input of [{ command: COMMAND }, { command: COMMAND, description: '   ' }, 'nope', undefined]) {
      expect(interpretHookEvent('codex', { ...permission, tool_input })?.question).toEqual({ kind: 'permission', payload: { tool_name: 'Bash', agent: 'codex' }, tool_use_id: null });
    }
    expect(interpretHookEvent('codex', { ...permission, tool_name: 'bad name\n' })).not.toHaveProperty('question');
    expect(interpretHookEvent('codex', { hook_event_name: 'PermissionRequest' })).not.toHaveProperty('question');
  });

  it('caps the permission question', () => {
    const out = interpretHookEvent('codex', { ...permission, tool_input: { description: 'x'.repeat(5000) } });
    const q = out?.question;
    expect(q?.kind === 'permission' && q.payload.question?.length).toBe(1000);
  });

  it('keeps the subagent flag on a permission card event', () => {
    const out = interpretHookEvent('codex', { ...permission, agent_id: 'sub1', agent_type: 'worker' });
    expect(out?.meta.subagent).toBe(true);
  });

  const ask = {
    hook_event_name: 'PreToolUse',
    tool_name: 'request_user_input',
    tool_use_id: 'call_abc',
    tool_input: {
      questions: [{ header: 'Nome', id: 'n', question: 'O arquivo deve ser azul.txt ou verde.txt?', options: [{ label: 'azul.txt', description: 'a' }, { label: 'verde.txt', description: 'b' }] }],
    },
  };

  it('opens a choice card for request_user_input', () => {
    const out = interpretHookEvent('codex', ask);
    expect(out).toMatchObject({ kind: 'waiting_input', text: 'O arquivo deve ser azul.txt ou verde.txt?', meta: { event: 'PreToolUse', tool: 'request_user_input' } });
    expect(out).not.toHaveProperty('activity');
    expect(out?.question).toMatchObject({ kind: 'choice', tool_use_id: 'call_abc', payload: { agent: 'codex' } });
    const q = out?.question;
    expect(q?.kind === 'choice' && q.payload.questions[0]).toMatchObject({ header: 'Nome', multi_select: false });
    expect(q?.kind === 'choice' && q.payload.questions[0]!.options).toHaveLength(2);
  });

  it('keeps today\'s working result for a request_user_input that does not parse', () => {
    const out = interpretHookEvent('codex', { ...ask, tool_input: { questions: [{ question: 'Q?' }] } });
    expect(out).toEqual({ kind: 'working', text: null, activity: activityOf('request_user_input'), verb: null, meta: { event: 'PreToolUse', tool: 'request_user_input' } });
  });

  it('marks a subagent\'s request_user_input as a subagent event', () => {
    expect(interpretHookEvent('codex', { ...ask, agent_id: 'sub1', agent_type: 'worker' })?.meta.subagent).toBe(true);
  });

  it('falls back to a generic pt-BR text when the description is missing or blank', () => {
    expect(interpretHookEvent('codex', { ...permission, tool_input: { command: COMMAND } })?.text).toBe('O Codex precisa da sua permissão para usar Bash');
    expect(interpretHookEvent('codex', { ...permission, tool_input: { command: COMMAND, description: '   ' } })?.text).toBe('O Codex precisa da sua permissão para usar Bash');
    expect(interpretHookEvent('codex', { ...permission, tool_input: 'nope' })?.text).toBe('O Codex precisa da sua permissão para usar Bash');
    expect(interpretHookEvent('codex', { ...permission, tool_input: undefined, tool_name: 'bad name\n' })?.text).toBe('O Codex precisa da sua permissão');
    expect(interpretHookEvent('codex', { hook_event_name: 'PermissionRequest' })?.text).toBe('O Codex precisa da sua permissão');
  });

  it('keeps only a valid tool name in meta', () => {
    expect(interpretHookEvent('codex', { ...permission, tool_name: 'bad name\n' })?.meta).toEqual({ event: 'PermissionRequest', tool: null });
    expect(interpretHookEvent('codex', { ...permission, tool_name: 'x'.repeat(500) })?.meta).toMatchObject({ tool: null });
  });

  it('caps a long description', () => {
    const text = interpretHookEvent('codex', { ...permission, tool_input: { description: 'x'.repeat(STATE_TEXT_MAX + 50) } })?.text;
    expect(text).toHaveLength(STATE_TEXT_MAX);
    expect(text?.endsWith('…')).toBe(true);
  });

  it('maps Stop to waiting_input with the last assistant message', () => {
    expect(interpretHookEvent('codex', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: ' Pronto. Rodo os testes? ' })).toEqual({
      kind: 'waiting_input',
      text: 'Pronto. Rodo os testes?',
      meta: { event: 'Stop' },
      answer: 'Pronto. Rodo os testes?',
    });
    expect(interpretHookEvent('codex', { ...base, hook_event_name: 'Stop' })?.text).toBeNull();
  });

  it('maps Interrupt to waiting_input with no text', () => {
    expect(interpretHookEvent('codex', { ...base, hook_event_name: 'Interrupt', model: 'gpt-5', permission_mode: 'default' })).toEqual({ kind: 'waiting_input', text: null, meta: { event: 'Interrupt' } });
  });

  it('ignores the hook events it does not install', () => {
    for (const name of ['SessionStart', 'SessionEnd', 'PreCompact', 'SubagentStart', 'Notification', 'agent-turn-complete']) {
      expect(interpretHookEvent('codex', { ...base, hook_event_name: name })).toBeNull();
    }
  });

  it('flags a subagent event, from the script flag or the payload agent_id', () => {
    expect(interpretHookEvent('codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', subagent: true })?.meta).toEqual({ event: 'PreToolUse', tool: 'Bash', subagent: true });
    expect(interpretHookEvent('codex', { ...permission, agent_id: 'a1' })?.meta).toEqual({ event: 'PermissionRequest', tool: 'Bash', subagent: true });
    expect(interpretHookEvent('codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', subagent: 'yes' })?.meta).not.toHaveProperty('subagent');
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': 'ok' })?.meta).not.toHaveProperty('subagent');
  });

  it('keeps reading notify when a payload has no hook_event_name', () => {
    expect(interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': 'ok' })?.meta).toEqual({ event: 'agent-turn-complete' });
  });
});

describe('interpretHookEvent — cursor', () => {
  // shapes captured from cursor-agent 2026.09.18 (ids shortened, personal fields dropped)
  const base = { conversation_id: 'c1', generation_id: 'g1', cursor_version: '2026.09.18', user_email: 'someone@example.com', workspace_roots: ['/w'] };

  it('marks the tab idle on session start and busy on each prompt, without keeping the prompt', () => {
    // A session nobody prompted is not busy: nothing of Cursor's would ever take it out of working
    // (it has no idle notification), and a busy tab holds `wait_for_state` and the agent's update.
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'sessionStart', is_background_agent: false })).toEqual({ kind: 'idle', text: null, meta: { event: 'sessionStart' } });
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'beforeSubmitPrompt' })).toMatchObject({ kind: 'working', meta: { event: 'beforeSubmitPrompt' } });
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
      answer: 'Pronto. Posso seguir?',
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

  it("afterAgentResponse never keepsWaitText: its own text is the fresh answer, and must replace a stale one (spec 2026-09-26 §6.1)", () => {
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'afterAgentResponse', text: 'dois' })?.keepsWaitText).toBeUndefined();
    expect(interpretHookEvent('cursor', { ...base, hook_event_name: 'stop', status: 'completed', loop_count: 0 })?.keepsWaitText).toBeUndefined();
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

describe('claude StopFailure', () => {
  it('a usage limit waits for the person, with the CLI line', () => {
    const i = interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your weekly limit · resets 1pm" });
    expect(i).toMatchObject({ kind: 'waiting_input', text: "Limite de uso da conta atingido — You've hit your weekly limit · resets 1pm", meta: { event: 'StopFailure', error: 'rate_limit' } });
    expect(isRateLimit(i)).toBe(true);
  });
  it('a usage limit without a message still says so', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'rate_limit' })).toMatchObject({ text: 'Limite de uso da conta atingido' });
  });
  it('any other API error is an error state', () => {
    const i = interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'authentication_failed' });
    expect(i).toMatchObject({ kind: 'error', text: 'Erro da API do Claude (authentication_failed)', meta: { event: 'StopFailure', error: 'authentication_failed' } });
    expect(isRateLimit(i)).toBe(false);
  });
  it('an unknown error value is not echoed', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'x"; rm' })).toMatchObject({ kind: 'error', text: 'Erro da API do Claude (unknown)' });
  });
});
describe('claudeSessionOf', () => {
  const SID = '6d127d73-4bd0-42d6-b4a6-d96899507e62';
  it('reads a valid pair', () => {
    expect(claudeSessionOf({ session_id: SID, transcript_path: `/h/.claude/projects/-p/${SID}.jsonl` })).toEqual({ session_id: SID, transcript_path: `/h/.claude/projects/-p/${SID}.jsonl` });
  });
  it('drops malformed ones', () => {
    expect(claudeSessionOf({ session_id: SID })).toBeNull();
    expect(claudeSessionOf({ session_id: 'x', transcript_path: '/h/.claude/projects/-p/x.jsonl' })).toBeNull();
    expect(claudeSessionOf({ session_id: SID, transcript_path: `/h/../projects/-p/${SID}.jsonl` })).toBeNull();
    expect(claudeSessionOf(null)).toBeNull();
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

describe('claude Stop background tasks (spec 2026-09-26 TER-203 §4.1)', () => {
  const task = (status: unknown) => ({ id: 'b1', type: 'shell', status, description: 'Watch CI', command: "curl -H 'Authorization: Bearer s3cr3t' https://ci" });
  it.each([
    ['one running', [task('running')], 1],
    ['running and completed', [task('running'), task('completed'), task('running')], 2],
    ['only completed (the last task just ended)', [task('completed'), task('failed')], 0],
    ['empty', [], 0],
    ['absent (Claude Code without the field)', undefined, 0],
    ['not an array', 'running', 0],
    ['entries that are not objects, or a status that is not a string', ['running', null, task(1)], 0],
  ])('%s', (_label, background, count) => {
    const i = interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: 'Vigiando o CI.', ...(background === undefined ? {} : { background_tasks: background }) });
    expect(i?.text).toBe('Vigiando o CI.');
    // background work still running is not a wait for the person (TER-644)
    expect(i?.kind).toBe(count > 0 ? 'waiting_background' : 'waiting_input');
    expect(i?.backgroundTasks).toBe(count > 0 ? count : undefined);
    expect(i?.meta).toEqual(count > 0 ? { event: 'Stop', background_tasks: count } : { event: 'Stop' });
    expect(JSON.stringify(i)).not.toContain('s3cr3t');
    expect(JSON.stringify(i)).not.toContain('Watch CI');
  });

  it('only a Stop carries the count', () => {
    const background_tasks = [task('running')];
    expect(interpretHookEvent('claude', { hook_event_name: 'UserPromptSubmit', background_tasks })?.backgroundTasks).toBeUndefined();
    expect(interpretHookEvent('claude', { hook_event_name: 'StopFailure', error: 'server_error', background_tasks })?.backgroundTasks).toBeUndefined();
  });

  it('runningBackgroundTasks never throws', () => {
    expect(runningBackgroundTasks(undefined)).toBe(0);
    expect(runningBackgroundTasks({ length: 3 })).toBe(0);
    expect(runningBackgroundTasks([{ status: 'running' }, { status: 'RUNNING' }])).toBe(1);
  });
});

describe('the whole answer (spec 2026-09-30 last answer)', () => {
  const long = 'x'.repeat(10_000);

  it.each([
    ['claude', { hook_event_name: 'Stop', last_assistant_message: long }],
    ['codex', { hook_event_name: 'Stop', last_assistant_message: long }],
    ['codex', { type: 'agent-turn-complete', 'last-assistant-message': long }],
    ['cursor', { hook_event_name: 'afterAgentResponse', text: long }],
  ] as const)('%s keeps the answer whole and the text capped', (tool, event) => {
    const out = interpretHookEvent(tool, event)!;
    expect(out.answer).toBe(long);
    expect(out.text!.length).toBe(STATE_TEXT_MAX);
    expect(out.text!.endsWith('…')).toBe(true);
  });

  it('keeps the answer of a Claude Stop with background tasks still running', () => {
    const out = interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: 'Pronto.', background_tasks: [{ status: 'running' }] })!;
    expect(out).toMatchObject({ backgroundTasks: 1, answer: 'Pronto.' });
  });

  it.each([
    ['claude', { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your weekly limit · resets 1pm" }],
    ['claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }],
    ['claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
    ['claude', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }],
    ['claude', { hook_event_name: 'Stop', last_assistant_message: long, agent_id: 'a1' }],
    ['codex', { hook_event_name: 'Stop', last_assistant_message: long, subagent: true }],
    ['cursor', { hook_event_name: 'stop', status: 'completed' }],
  ] as const)('%s events that carry no answer have none', (tool, event) => {
    expect(interpretHookEvent(tool, event)?.answer).toBeUndefined();
  });

  it('cuts an answer longer than LAST_ANSWER_MAX', () => {
    const out = interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: 'y'.repeat(120_000) })!;
    expect(out.answer!.length).toBe(LAST_ANSWER_MAX);
    expect(out.answer!.endsWith('…')).toBe(true);
  });

  it('an empty answer is no answer', () => {
    expect(interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: '   ' })?.answer).toBeUndefined();
  });

  it('drops null characters from the answer and the text: Postgres text rejects them, and the event would be lost', () => {
    const out = interpretHookEvent('claude', { hook_event_name: 'Stop', last_assistant_message: `Pronto.\u0000 Rodo${'\u0000'.repeat(3)} os testes?` })!;
    expect(out.answer).toBe('Pronto. Rodo os testes?');
    expect(out.text).toBe('Pronto. Rodo os testes?');
    // past the text's cap too, and before the answer's cut, so the kept lengths do not shrink
    const long = interpretHookEvent('codex', { type: 'agent-turn-complete', 'last-assistant-message': `${'\u0000'.repeat(10)}${'z'.repeat(LAST_ANSWER_MAX + 10)}` })!;
    expect(long.answer!.includes('\u0000')).toBe(false);
    expect(long.answer!.length).toBe(LAST_ANSWER_MAX);
    expect(long.text!.includes('\u0000')).toBe(false);
    expect(long.text!.length).toBe(STATE_TEXT_MAX);
    // other capped texts: a Notification message, a Codex permission description
    expect(interpretHookEvent('claude', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Posso\u0000 rodar?' })?.text).toBe('Posso rodar?');
    expect(interpretHookEvent('codex', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { description: 'Rodar\u0000 testes' } })?.text).toBe('Rodar testes');
  });

  it('an answer of null characters only is no answer', () => {
    const out = interpretHookEvent('cursor', { hook_event_name: 'afterAgentResponse', text: '\u0000\u0000' })!;
    expect(out.answer).toBeUndefined();
    expect(out.text).toBeNull();
  });
});

describe('waiting_background is not "needs you" (TER-644)', () => {
  it('a tab waiting on its own background work never needs the person, seen or not', () => {
    const at = '2026-10-01T15:00:00.000Z';
    expect(NEEDS_YOU).not.toContain('waiting_background');
    expect(needsYou({ state: 'waiting_background', state_at: at, state_seen_at: null })).toBe(false);
    expect(needsYou({ state: 'waiting_input', state_at: at, state_seen_at: null })).toBe(true);
  });
});
