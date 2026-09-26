import type { ChatEvent } from './types';
import { applyLive, emptyFold, foldLive } from './live';

const USER_ID = 'u1';
const CONVERSATION_ID = 'c1';
const T0 = '2026-01-01T00:00:00.000Z';

function delta(messageId: string, text: string): ChatEvent {
  return { type: 'delta', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: messageId, delta: text };
}

function toolCall(messageId: string, tool: string): ChatEvent {
  return { type: 'action', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: messageId, tool, tool_use_id: `tu-${tool}`, args: {} };
}

function reset(messageId: string): ChatEvent {
  return { type: 'reset', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: messageId };
}

function assistantMessage(id: string, overrides: { text?: string; error_code?: string | null } = {}): ChatEvent {
  return {
    type: 'message',
    user_id: USER_ID,
    conversation_id: CONVERSATION_ID,
    message: { id, conversation_id: CONVERSATION_ID, role: 'assistant', text: overrides.text ?? '', usage: null, error_code: overrides.error_code ?? null, created_at: T0 },
  };
}

function userMessage(id: string): ChatEvent {
  return {
    type: 'message',
    user_id: USER_ID,
    conversation_id: CONVERSATION_ID,
    message: { id, conversation_id: CONVERSATION_ID, role: 'user', text: 'oi', usage: null, error_code: null, created_at: T0 },
  };
}

const hello: ChatEvent = { type: 'hello', protocol: 1, server_time: T0 };

function confirmation(actionId: string): ChatEvent {
  return {
    type: 'confirmation',
    user_id: USER_ID,
    conversation_id: CONVERSATION_ID,
    action_id: actionId,
    tool: 'Bash',
    args: {},
    class: 'write',
    machine_id: null,
    project_id: null,
    tab_id: null,
    summary: 'digitar `npm test` na aba api do projeto termhub',
    created_at: T0,
  };
}

function decision(actionId: string): ChatEvent {
  return { type: 'decision', user_id: USER_ID, conversation_id: CONVERSATION_ID, action_id: actionId, status: 'approved' };
}

describe('foldLive', () => {
  it('returns empty maps and set for no events', () => {
    const result = foldLive([]);
    expect(result.deltas.size).toBe(0);
    expect(result.actions.size).toBe(0);
    expect(result.started.size).toBe(0);
  });

  it('concatenates delta text per message id, independently of other messages', () => {
    const result = foldLive([delta('m1', 'ol'), delta('m1', 'á'), delta('m2', 'x')]);
    expect(result.deltas.get('m1')).toBe('olá');
    expect(result.deltas.get('m2')).toBe('x');
  });

  it('marks a message with any delta as started', () => {
    const result = foldLive([delta('m1', 'a')]);
    expect(result.started.has('m1')).toBe(true);
  });

  it('accumulates tool calls per message id, in the order they arrived', () => {
    const result = foldLive([toolCall('m1', 'Bash'), toolCall('m1', 'Read')]);
    expect(result.actions.get('m1')).toEqual([{ tool: 'Bash' }, { tool: 'Read' }]);
  });

  it('marks a message with a tool call as started', () => {
    const result = foldLive([toolCall('m1', 'Bash')]);
    expect(result.started.has('m1')).toBe(true);
  });

  it('reset drops the accumulated deltas and tool calls for that message only', () => {
    const result = foldLive([delta('m1', 'olá'), toolCall('m1', 'Bash'), delta('m2', 'oi'), reset('m1')]);
    expect(result.deltas.has('m1')).toBe(false);
    expect(result.actions.has('m1')).toBe(false);
    expect(result.deltas.get('m2')).toBe('oi');
  });

  it('reset does not mark the message as started on its own', () => {
    const result = foldLive([reset('m1')]);
    expect(result.started.has('m1')).toBe(false);
  });

  it('marks an empty assistant message (no text, no error) as started', () => {
    const result = foldLive([assistantMessage('m1')]);
    expect(result.started.has('m1')).toBe(true);
  });

  it('does not mark a finished assistant message (with text) as started', () => {
    const result = foldLive([assistantMessage('m1', { text: 'pronto' })]);
    expect(result.started.has('m1')).toBe(false);
  });

  it('does not mark a failed assistant message (with an error_code) as started', () => {
    const result = foldLive([assistantMessage('m1', { error_code: 'HOST_GONE' })]);
    expect(result.started.has('m1')).toBe(false);
  });

  it('does not mark a user message as started', () => {
    const result = foldLive([userMessage('m1')]);
    expect(result.started.has('m1')).toBe(false);
  });

  it('ignores hello, confirmation and decision events entirely', () => {
    const result = foldLive([hello, confirmation('a1'), decision('a1')]);
    expect(result.deltas.size).toBe(0);
    expect(result.actions.size).toBe(0);
    expect(result.started.size).toBe(0);
  });
});

it('ignores run_finished: nothing streamed is dropped or marked started', () => {
  const finished: ChatEvent = { type: 'run_finished', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: 'm1', ok: true, error_code: null };
  const folded = foldLive([delta('m1', 'oi'), finished]);
  expect(folded.deltas.get('m1')).toBe('oi');
  expect([...folded.started]).toEqual(['m1']);
  expect(foldLive([finished])).toEqual({ deltas: new Map(), actions: new Map(), started: new Set() });
});

describe('applyLive', () => {
  it('returns the very same fold for an event that changes nothing, and replaces only the map it touched', () => {
    const fold = foldLive([delta('m1', 'oi')]);
    expect(applyLive(fold, hello)).toBe(fold);
    expect(applyLive(fold, confirmation('a1'))).toBe(fold);
    expect(applyLive(fold, userMessage('m9'))).toBe(fold);
    expect(applyLive(fold, reset('m2'))).toBe(fold); // nothing streamed for m2

    const next = applyLive(fold, delta('m1', '!'));
    expect(next).not.toBe(fold);
    expect(next.deltas.get('m1')).toBe('oi!');
    expect(next.actions).toBe(fold.actions); // untouched map keeps its reference
    expect(next.started).toBe(fold.started); // m1 was started already
    expect(fold.deltas.get('m1')).toBe('oi'); // the old fold is never mutated
  });

  it('an announce marks the row started; its final message drops everything of that id, and only that id', () => {
    const announced = applyLive(emptyFold(), assistantMessage('m1'));
    expect([...announced.started]).toEqual(['m1']);
    expect(applyLive(announced, assistantMessage('m1'))).toBe(announced);

    const streaming = applyLive(applyLive(announced, delta('m1', 'oi')), delta('m2', 'x'));
    const done = applyLive(streaming, assistantMessage('m1', { text: 'oi' }));
    expect(done.deltas.has('m1')).toBe(false);
    expect(done.started.has('m1')).toBe(false);
    expect(done.deltas.get('m2')).toBe('x');
    expect(applyLive(done, assistantMessage('m1', { text: 'oi' }))).toBe(done);
  });

  it('foldLive is applyLive over the events, from an empty fold', () => {
    const events = [delta('m1', 'a'), toolCall('m1', 'Bash'), reset('m1'), delta('m1', 'b')];
    expect(foldLive(events)).toEqual(events.reduce(applyLive, emptyFold()));
    expect(foldLive([])).toEqual(emptyFold());
  });
});
