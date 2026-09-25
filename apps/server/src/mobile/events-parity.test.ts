import { chatEventSchema } from '@termhub/mobile-api';
import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../chat/bus.js';

// One sample of every `ChatEvent` variant the bus carries, keyed by its type: the `Record` makes the
// type checker refuse this file when a variant is added to the bus and not here, and the test then
// refuses it when the mobile contract (`chatEventSchema`) does not accept it. Together they keep
// what /ws/m/chat forwards and what the app parses from drifting apart.
const base = { user_id: 'u1', conversation_id: 'c1' };
const samples: { [K in ChatEvent['type']]: Extract<ChatEvent, { type: K }> } = {
  message: {
    type: 'message',
    ...base,
    message: { id: 'm1', conversation_id: 'c1', role: 'assistant', text: 'oi', usage: null, error_code: null, created_at: '2026-09-24T12:00:00.000Z' },
  },
  delta: { type: 'delta', ...base, message_id: 'm1', delta: 'o' },
  action: { type: 'action', ...base, message_id: 'm1', tool: 'list_tabs', tool_use_id: 't1', args: { machine: 'x' } },
  action_result: { type: 'action_result', ...base, message_id: 'm1', tool_use_id: 't1', ok: true },
  reset: { type: 'reset', ...base, message_id: 'm1' },
  confirmation: {
    type: 'confirmation',
    ...base,
    action_id: 'a1',
    tool: 'run_command',
    args: { command: 'ls' },
    class: 'write',
    machine_id: 'mc1',
    project_id: null,
    tab_id: null,
    summary: 'Rodar ls',
    created_at: '2026-09-24T12:00:00.000Z',
  },
  decision: { type: 'decision', ...base, action_id: 'a1', status: 'approved' },
  run_finished: { type: 'run_finished', ...base, message_id: null, ok: false, error_code: 'CHAT_FAILED' },
  granted_action: { type: 'granted_action', ...base, action: { id: 'a2', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'executed', machine_id: null, project_id: null, tab_id: 't1', grant_id: 'g1', summary: 'digitar `oi` na aba api', created_at: '2026-09-25T10:01:00.000Z' } },
};

describe('ChatEvent / chatEventSchema parity', () => {
  it.each(Object.entries(samples))('the mobile contract accepts a %s event', (_type, sample) => {
    const r = chatEventSchema.safeParse(sample);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('run_finished also parses with a message id and no error', () => {
    expect(chatEventSchema.safeParse({ type: 'run_finished', ...base, message_id: 'm1', ok: true, error_code: null }).success).toBe(true);
  });
});
