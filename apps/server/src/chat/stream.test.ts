import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseFrame } from './stream.js';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-basic.ndjson'), 'utf8').split('\n').filter(Boolean);
const toolCallFixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-tool-call.ndjson'), 'utf8').split('\n').filter(Boolean);
const backgroundFixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-background.ndjson'), 'utf8').split('\n').filter(Boolean);

it('turns a recorded run into text deltas and a final usage', () => {
  const frames = fixture.map(parseFrame).filter((f) => f !== null);
  expect(frames.some((f) => f!.type === 'text')).toBe(true);
  expect(frames.at(-1)!.type).toBe('done');
});

it('reads a real tool call and its result', () => {
  const frames = toolCallFixture.map(parseFrame).filter((f) => f !== null);
  const call = frames.find((f) => f!.type === 'action');
  const result = frames.find((f) => f!.type === 'action_result');
  expect(call).toEqual({
    type: 'action',
    tool: 'Read',
    tool_use_id: 'toolu_01S2jgEi6qS2jvGovWPFeMoy',
    args: { file_path: '/tmp/fixture-probe.txt' },
  });
  expect(result).toEqual({ type: 'action_result', tool_use_id: 'toolu_01S2jgEi6qS2jvGovWPFeMoy', ok: true });
});

// The recording above used a built-in tool (--strict-mcp-config attaches no MCP server), so it never
// exercises the mcp__termhub__ prefix stripping. That mapping is termhub's own naming convention, not
// a guess at the CLI's frame shape, so a synthetic case for it is fine.
it('strips the mcp__termhub__ prefix from an MCP tool name', () => {
  const call = parseFrame(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__termhub__list_tabs', input: { project_id: 'p1' } }] },
  }));
  expect(call).toEqual({ type: 'action', tool: 'list_tabs', tool_use_id: 'tu_1', args: { project_id: 'p1' } });
});

// The recording's tool call succeeded, so there is no real failing tool_result to read; manufacturing
// one would not be worth it. This keeps the is_error path covered.
it('marks a tool result as failed when is_error is true', () => {
  const result = parseFrame(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: [{ type: 'text', text: 'Este token não tem o escopo `terminals`' }] }] },
  }));
  expect(result).toEqual({ type: 'action_result', tool_use_id: 'tu_1', ok: false });
});

it('reports the runner error line the container appends', () => {
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'run_failed' }))).toEqual({ type: 'error', message: 'runner failed', reason: 'run_failed' });
});

// This reason is the whole fresh-session fallback: the container classifies the CLI's stderr (which
// never leaves it) and the service retries off this label, not off an exception's text.
it('carries the container\'s missing-session reason through', () => {
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'missing_session' }))).toEqual({
    type: 'error',
    message: 'runner failed',
    reason: 'missing_session',
  });
});

it('drops a reason it does not know instead of guessing at it', () => {
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'something_new' }))).toEqual({ type: 'error', message: 'runner failed' });
});

// A recorded `result` frame is the real shape: same keys, plus is_error. A run that ends this way
// (max turns, an API error, every tool denied) is not an answer, and used to be stored as a clean
// one — empty more often than not, which the page then showed as "pensando…" for ever.
it('treats a result frame that reports is_error as a failure, not as a clean finish', () => {
  const real = JSON.parse(fixture.at(-1)!) as Record<string, unknown>;
  expect(real.type).toBe('result');
  expect(parseFrame(JSON.stringify({ ...real, is_error: false }))).toMatchObject({ type: 'done', session_id: real.session_id });
  // Same session id as the `done` path reports: the run failed, its session did not.
  expect(parseFrame(JSON.stringify({ ...real, is_error: true }))).toEqual({
    type: 'error',
    message: 'run ended with is_error',
    reason: 'run_failed',
    session_id: real.session_id,
    turn_ended: true,
  });
});

it('carries cli_rejected through, so a refused flag is not filed as a generic failure', () => {
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'cli_rejected' }))).toMatchObject({ type: 'error', reason: 'cli_rejected' });
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'something_new' }))).toMatchObject({ type: 'error', reason: undefined });
});

it('carries the reasons only the user-hosted runner can report', () => {
  // `cli_missing` is this feature's likeliest first failure and the one thing the person can act on;
  // dropped here, it would reach them as a generic failure with nothing to do about it.
  for (const reason of ['cli_missing', 'killed', 'host_gone', 'agent_too_old'])
    expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: null, reason }))).toMatchObject({ type: 'error', reason });
});

it('ignores a malformed line instead of throwing', () => {
  expect(parseFrame('not json')).toBeNull();
  expect(parseFrame(JSON.stringify({ type: 'something_new' }))).toBeNull();
  expect(parseFrame('null')).toBeNull();
  expect(parseFrame('[1,2,3]')).toBeNull();
});

it('reads a streamed run: turns start on their replay, background tasks are counted, subagent frames are ignored', () => {
  const frames = backgroundFixture.map(parseFrame).filter((f) => f !== null);
  expect(frames.filter((f) => f!.type === 'turn_started')).toEqual([
    { type: 'turn_started', uuid: '11111111-1111-4111-8111-111111111111' },
    { type: 'turn_started', uuid: '22222222-2222-4222-8222-222222222222' },
  ]);
  expect(frames.filter((f) => f!.type === 'background').map((f) => (f as { count: number }).count)).toEqual([1, 0]);
  expect(frames.filter((f) => f!.type === 'done')).toHaveLength(3);
  // The concierge's own call to Agent is an action; the subagent's own frames are nobody's.
  const actions = frames.filter((f) => f!.type === 'action') as { tool: string }[];
  expect(actions.map((a) => a.tool)).toEqual(['Agent']);
  const text = frames.filter((f) => f!.type === 'text').map((f) => (f as { delta: string }).delta).join('');
  expect(text).toContain('Paris');
  expect(text).not.toMatch(/lighthouse/i);
});

it('ignores any frame that belongs to a subagent', () => {
  expect(parseFrame(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__termhub__list_tabs', input: {} }] } }))).toBeNull();
  expect(parseFrame(JSON.stringify({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'oi' } } }))).toBeNull();
});

it('marks a failed result as the end of one turn, not of the run', () => {
  expect(parseFrame(JSON.stringify({ type: 'result', is_error: true, session_id: 's1' }))).toEqual({ type: 'error', message: 'run ended with is_error', reason: 'run_failed', session_id: 's1', turn_ended: true });
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'missing_session' }))).toMatchObject({ type: 'error', reason: 'missing_session' });
  expect(parseFrame(JSON.stringify({ type: 'termhub_error', code: 1, reason: 'missing_session' }))).not.toHaveProperty('turn_ended');
});

it('reads a replay without a uuid as nothing', () => {
  expect(parseFrame(JSON.stringify({ type: 'user', isReplay: true, message: { role: 'user', content: 'oi' } }))).toBeNull();
});
