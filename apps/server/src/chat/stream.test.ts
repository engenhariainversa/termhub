import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe } from 'vitest';
import { codeForReason, contextUsage, parseFrame, cliTaskStatus } from './stream.js';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-basic.ndjson'), 'utf8').split('\n').filter(Boolean);
const toolCallFixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-tool-call.ndjson'), 'utf8').split('\n').filter(Boolean);
const backgroundFixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-background.ndjson'), 'utf8').split('\n').filter(Boolean);
// A real `/compact` of a resumed session, written on stdin like the runner does (Claude Code 2.1.283).
const compactFixture = readFileSync(join(import.meta.dirname, 'fixtures/stream-compact.ndjson'), 'utf8').split('\n').filter(Boolean);

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

it('reads a streamed run: turns start on their replay, background tasks are counted, subagent text/non-termhub frames are ignored', () => {
  const frames = backgroundFixture.map(parseFrame).filter((f) => f !== null);
  expect(frames.filter((f) => f!.type === 'turn_started')).toEqual([
    { type: 'turn_started', uuid: '11111111-1111-4111-8111-111111111111' },
    { type: 'turn_started', uuid: '22222222-2222-4222-8222-222222222222' },
  ]);
  expect(frames.filter((f) => f!.type === 'background').map((f) => (f as { count: number }).count)).toEqual([1, 0]);
  expect(frames.filter((f) => f!.type === 'done')).toHaveLength(3);
  // The concierge's own call to Agent is an action; the subagent's text and non-termhub tool calls are ignored.
  const actions = frames.filter((f) => f!.type === 'action') as { tool: string }[];
  expect(actions.map((a) => a.tool)).toEqual(['Agent']);
  const text = frames.filter((f) => f!.type === 'text').map((f) => (f as { delta: string }).delta).join('');
  expect(text).toContain('Paris');
  expect(text).not.toMatch(/lighthouse/i);
});

it('reads a subagent termhub tool call but ignores other subagent frames', () => {
  expect(parseFrame(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__termhub__list_tabs', input: {} }] } }))).toEqual({ type: 'subagent_tool', parent_tool_use_id: 'toolu_1', tool_use_id: 'x', tool: 'list_tabs' });
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

describe('subagent frames', () => {
  it('maps task_started to subagent_started', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'af47', tool_use_id: 'toolu_A', description: 'Write text about lighthouses', subagent_type: 'general-purpose', is_backgrounded: true, prompt: 'secret prompt' });
    expect(parseFrame(line)).toEqual({ type: 'subagent_started', task_id: 'af47', tool_use_id: 'toolu_A', description: 'Write text about lighthouses', subagent_type: 'general-purpose' });
  });
  it('caps the description at 200 chars and drops a task_started without ids', () => {
    const long = 'x'.repeat(300);
    expect((parseFrame(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 't', tool_use_id: 'u', description: long })) as { description: string }).description).toHaveLength(200);
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_started', description: 'd' }))).toBeNull();
  });
  it('maps task_updated and task_notification statuses', () => {
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 't', patch: { status: 'completed', end_time: 1 } }))).toEqual({ type: 'subagent_status', task_id: 't', status: 'completed' });
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 't', status: 'killed', summary: 'x' }))).toEqual({ type: 'subagent_status', task_id: 't', status: 'stopped' });
    for (const s of ['stopped', 'cancelled']) expect(cliTaskStatus(s)).toBe('stopped');
    expect(cliTaskStatus('failed')).toBe('failed');
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 't', patch: { status: 'running' } }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: 't', patch: { end_time: 1 } }))).toBeNull();
  });
  it('reports a subagent termhub tool call, and nothing else of a subagent', () => {
    const tool = { type: 'assistant', parent_tool_use_id: 'toolu_A', message: { content: [{ type: 'tool_use', id: 'toolu_B', name: 'mcp__termhub__send_input', input: { text: 'x' } }] } };
    expect(parseFrame(JSON.stringify(tool))).toEqual({ type: 'subagent_tool', parent_tool_use_id: 'toolu_A', tool_use_id: 'toolu_B', tool: 'send_input' });
    const other = { ...tool, message: { content: [{ type: 'tool_use', id: 'toolu_C', name: 'Agent', input: {} }] } };
    expect(parseFrame(JSON.stringify(other))).toBeNull();
    const text = { type: 'assistant', parent_tool_use_id: 'toolu_A', message: { content: [{ type: 'text', text: 'hi' }] } };
    expect(parseFrame(JSON.stringify(text))).toBeNull();
  });
  it('maps control_response success and error without the error text', () => {
    expect(parseFrame(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'stop-1' } }))).toEqual({ type: 'control_response', request_id: 'stop-1', ok: true });
    expect(parseFrame(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'stop-1', error: 'not supported' } }))).toEqual({ type: 'control_response', request_id: 'stop-1', ok: false });
    expect(parseFrame(JSON.stringify({ type: 'control_response', response: { subtype: 'success' } }))).toBeNull();
  });
});

// TER-315: the context fill is the turn's last API call, never the turn's total — the recorded tool
// call made two calls, and its top-level usage counts the cache reads of both.
it('reads the context fill from the last API call of a turn, and the model window', () => {
  const done = toolCallFixture.map(parseFrame).find((f) => f?.type === 'done');
  expect(done).toMatchObject({ type: 'done', context: { tokens: 2 + 25145 + 106 + 5, window: 1_000_000 } });
});

it('falls back to the total without iterations, and says nothing without tokens', () => {
  expect(contextUsage({ usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } })).toEqual({ tokens: 105, window: null });
  expect(contextUsage({ usage: { input_tokens: 5, iterations: [] } })).toBeUndefined();
  expect(contextUsage({ usage: { input_tokens: 0 } })).toBeUndefined();
  expect(contextUsage({})).toBeUndefined();
  expect(parseFrame(JSON.stringify({ type: 'result', session_id: 's', usage: { iterations: [] } }))).toEqual({ type: 'done', session_id: 's', usage: { iterations: [] } });
});

it('takes the largest window when a subagent ran on a smaller model', () => {
  const result = { usage: { iterations: [{ input_tokens: 1, output_tokens: 1 }] }, modelUsage: { 'claude-haiku-4-5': { contextWindow: 200_000 }, 'claude-opus-5[1m]': { contextWindow: 1_000_000 } } };
  expect(contextUsage(result)).toEqual({ tokens: 2, window: 1_000_000 });
});

it('reads a real /compact: the sizes before and after, then a result with no call', () => {
  const frames = compactFixture.map(parseFrame).filter((f) => f !== null);
  expect(frames.find((f) => f!.type === 'compacted')).toEqual({ type: 'compacted', tokens_before: 20693, tokens: 1951 });
  const done = frames.find((f) => f!.type === 'done');
  expect(done).toMatchObject({ type: 'done', session_id: '9cab042f-4d34-40d1-958c-a84eb6d193b6' });
  expect(done).not.toHaveProperty('context');
});

it('reads a compaction that does not report its sizes', () => {
  expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } }))).toEqual({ type: 'compacted', tokens_before: undefined, tokens: undefined });
});

// TER-588: the CLI says why a turn failed on stdout, in frames the server already reads — recorded on
// Claude Code 2.1.285 with the account at its limit, with a model it does not know and with no login.
// Stderr was empty in all three, which is why `classifyFailure` could never tell them apart.
const recorded = (name: string) => readFileSync(join(import.meta.dirname, `fixtures/${name}.ndjson`), 'utf8').split('\n').filter(Boolean).map(parseFrame).filter((f) => f !== null);

describe('failures the CLI reports in the stream', () => {
  it('reads a usage limit: when it resets, why the turn failed, and a result that says so too', () => {
    const frames = recorded('stream-usage-limit');
    expect(frames.find((f) => f!.type === 'usage_limit')).toEqual({ type: 'usage_limit', resets_at: new Date(1790749200 * 1000).toISOString() });
    expect(frames.find((f) => f!.type === 'api_error')).toEqual({ type: 'api_error', reason: 'usage_limit' });
    expect(frames.at(-1)).toMatchObject({ type: 'error', reason: 'usage_limit', turn_ended: true, session_id: 'ee7af5ab-976a-43f5-92e0-d1afd433c518' });
    // The synthetic "You've hit your session limit" text is the CLI's, not an answer: nothing is streamed.
    expect(frames.some((f) => f!.type === 'text')).toBe(false);
  });

  it('reads where the session lives and the model it runs on from the init frame', () => {
    expect(recorded('stream-usage-limit').find((f) => f!.type === 'init')).toEqual({ type: 'init', dir: '/home/u/.claude/projects/-srv', model: 'claude-opus-5-5' });
  });

  it('names a model the CLI does not know, and a machine that is not logged in', () => {
    expect(recorded('stream-model-not-found').find((f) => f!.type === 'api_error')).toEqual({ type: 'api_error', reason: 'model_unavailable' });
    expect(recorded('stream-not-logged-in').find((f) => f!.type === 'api_error')).toEqual({ type: 'api_error', reason: 'auth_failed' });
  });

  it('falls back to the status code of the result when no assistant frame said why', () => {
    expect(parseFrame(JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, session_id: 's' }))).toMatchObject({ reason: 'usage_limit' });
    expect(parseFrame(JSON.stringify({ type: 'result', is_error: true, api_error_status: 401, session_id: 's' }))).toMatchObject({ reason: 'auth_failed' });
    expect(parseFrame(JSON.stringify({ type: 'result', is_error: true, api_error_status: 500, session_id: 's' }))).toMatchObject({ reason: 'run_failed' });
  });

  it('ignores an error it has no name for, a limit that was not hit, and a bad init', () => {
    expect(parseFrame(JSON.stringify({ type: 'assistant', error: 'server_error', is_api_error_message: true, message: { content: [{ type: 'text', text: 'x' }] } }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1790749200 } }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }))).toEqual({ type: 'usage_limit', resets_at: null });
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'init', memory_paths: { auto: 'relative/projects/x/memory/' } }))).toBeNull();
    expect(parseFrame(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
  });

  it('stores each of them under a code of its own', () => {
    expect(codeForReason('usage_limit')).toBe('USAGE_LIMIT');
    expect(codeForReason('model_unavailable')).toBe('MODEL_UNAVAILABLE');
    expect(codeForReason('auth_failed')).toBe('AUTH_FAILED');
  });
});
