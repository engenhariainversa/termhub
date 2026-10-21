import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CODEX_TRANSCRIPT_TYPES, parseCodexLines } from './codex-transcript.js';
import { isDegraded } from './transcript.js';

/**
 * A real session of the Codex TUI (codex-cli 0.159.3 in tmux on jarvis, TER-1095): a pasted two-line
 * prompt that runs a command, a typed one that edits a file with apply_patch, and one interrupted with
 * Esc. Paths rewritten to /home/p/proj; the model's injected instructions cut to a stub.
 */
const ROLLOUT = readFileSync(new URL('./fixtures/codex-0.159.3-rollout.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean);
/** What `transcript.read` returns for it: only the line types the server asks for. */
const asked = ROLLOUT.filter((l) => (CODEX_TRANSCRIPT_TYPES as readonly string[]).includes(JSON.parse(l).type));
const L = (o: object) => JSON.stringify(o);
const at = '2026-10-20T17:00:00.000Z';

describe('parseCodexLines — a real Codex session', () => {
  const parsed = parseCodexLines(asked);

  it('gives the prompts, the agent messages, the tool calls with their results and the interruption, in order', () => {
    expect(parsed.items.map((i) => (i.kind === 'user' || i.kind === 'assistant' ? `${i.kind}: ${i.text}` : i.kind === 'tool' ? `tool ${i.name}: ${i.summary}` : i.kind === 'tool_result' ? `result${i.error ? ' (error)' : ''}` : `notice ${i.notice}`))).toEqual([
      'user: Create a file named hello.txt containing the word hi.\nThen reply with the word done.',
      'assistant: I’ll create hello.txt with the word hi.',
      "tool Bash: printf 'hi' > hello.txt",
      'result',
      'assistant: done',
      'user: Use apply_patch to change hello.txt so it says hello world, then say ok.',
      'assistant: I’ll update hello.txt using apply_patch.',
      'tool apply_patch: /home/p/proj/hello.txt',
      'result',
      'assistant: ok',
      'user: Run sleep 30 and then say finished.',
      'assistant: I’ll run sleep 30, then reply.',
      'notice interrupted',
    ]);
  });

  it('pairs a result with its tool call and keeps the ids stable across reads', () => {
    const tool = parsed.items.find((i) => i.kind === 'tool' && i.name === 'apply_patch');
    const result = parsed.items.find((i) => i.kind === 'tool_result' && i.tool_id === tool?.id);
    expect(result).toMatchObject({ preview: 'Success. Updated the following files:\nM hello.txt\n', error: false });
    expect(parseCodexLines(asked).items.map((i) => i.id)).toEqual(parsed.items.map((i) => i.id));
    expect(new Set(parsed.items.map((i) => i.id)).size).toBe(parsed.items.length);
  });

  it('is not degraded and has no mode', () => {
    expect(parsed.unknown).toBe(0);
    expect(isDegraded(parsed)).toBe(false);
    expect(parsed.mode).toBeNull();
  });

  it('never shows the instructions Codex injects (response_item lines), even if they were read', () => {
    const all = parseCodexLines(ROLLOUT);
    expect(JSON.stringify(all.items)).not.toContain('permissions instructions');
    expect(all.items).toHaveLength(parsed.items.length);
  });
});

describe('parseCodexLines — other shapes', () => {
  const ev = (payload: object) => L({ timestamp: at, type: 'event_msg', payload });

  it('reads the user_message / agent_message events of older releases', () => {
    const { items } = parseCodexLines([ev({ type: 'user_message', message: 'oi', images: ['data:…'] }), ev({ type: 'agent_message', message: ' olá \n' })]);
    expect(items).toMatchObject([
      { kind: 'user', text: 'oi', images: 1, at },
      { kind: 'assistant', text: 'olá', at },
    ]);
  });

  it('marks a failed command as an error with its output', () => {
    const { items } = parseCodexLines([ev({ type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc', 'npm test'], status: 'completed', exit_code: 1, aggregated_output: 'FAIL x' } })]);
    expect(items).toEqual([
      { kind: 'tool', id: 'exec-1', at, name: 'Bash', summary: 'npm test' },
      { kind: 'tool_result', id: 'exec-1:result', at, tool_id: 'exec-1', error: true, preview: 'FAIL x' },
    ]);
  });

  it('reads a status by its word, whatever its spelling: only a failure is an error (TER-1102)', () => {
    const exec = (status: string, exit_code: number | null = 0) =>
      parseCodexLines([ev({ type: 'item_completed', item: { type: 'CommandExecution', id: 'e', command: 'ls', status, exit_code } })]).items.find((i) => i.kind === 'tool_result');
    for (const status of ['completed', 'Completed', 'COMPLETED', 'success']) expect(exec(status)).toMatchObject({ error: false });
    for (const status of ['failed', 'Failed', 'declined', 'Declined']) expect(exec(status, null)).toMatchObject({ error: true });
    for (const status of ['in_progress', 'inProgress', 'InProgress']) expect(exec(status, null)).toBeUndefined();
  });

  it('reads a compaction, a dropped line and an MCP call', () => {
    const { items } = parseCodexLines([
      ev({ type: 'context_compacted' }),
      L({ type: 'event_msg', timestamp: at, termhub_dropped: true }),
      ev({ type: 'item_completed', item: { type: 'McpToolCall', id: 'm1', server: 'termhub', tool: 'list_tabs', status: 'failed' } }),
    ]);
    expect(items).toMatchObject([
      { kind: 'notice', notice: 'compacted' },
      { kind: 'notice', notice: 'truncated' },
      { kind: 'tool', id: 'm1', name: 'mcp__termhub__list_tabs' },
      { kind: 'tool_result', tool_id: 'm1', error: true },
    ]);
  });

  it('skips bookkeeping and unknown items, and counts only broken lines as unknown', () => {
    const p = parseCodexLines([
      ev({ type: 'task_started' }),
      ev({ type: 'token_count', info: {} }),
      ev({ type: 'item_completed', item: { type: 'Reasoning', id: 'r1' } }),
      ev({ type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', content: [] } }),
      ev({ type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: 'not a list' } }),
      ev({ type: 'item_completed' }),
      'not json',
    ]);
    expect(p.items).toEqual([]);
    expect(p.known).toBe(4);
    expect(p.unknown).toBe(3);
  });
});
