import { tabChatItem } from '@termhub/mobile-api';
import { describe, expect, it } from 'vitest';
import type { TabChatItem } from './transcript.js';

// One sample of every `TabChatItem` kind the server produces, keyed by its kind: the `Record` makes the
// type checker refuse this file when a kind is added to the server and not here, and the test then
// refuses it when the phone's contract (`tabChatItem`) does not accept it, so the two cannot drift.
const at = '2026-10-01T10:00:00.000Z';
const samples: { [K in TabChatItem['kind']]: Extract<TabChatItem, { kind: K }> } = {
  user: { kind: 'user', id: 'u1', at, text: 'faz o deploy', images: 1 },
  assistant: { kind: 'assistant', id: 'u2:0', at, text: 'Feito.' },
  tool: { kind: 'tool', id: 'toolu_1', at, name: 'Bash', summary: null },
  tool_result: { kind: 'tool_result', id: 'u3:0', at, tool_id: 'toolu_1', error: false, preview: 'ok' },
  command: { kind: 'command', id: 'u4', at, name: '/compact', args: null },
  command_output: { kind: 'command_output', id: 'u5', at, text: 'Compacted' },
  notice: { kind: 'notice', id: 'u6', at: '', notice: 'truncated' },
};

describe('tab chat items: server and phone contract', () => {
  it.each(Object.values(samples))('the contract accepts a server $kind item', (item) => {
    expect(tabChatItem.parse(item)).toEqual(item);
  });
});
