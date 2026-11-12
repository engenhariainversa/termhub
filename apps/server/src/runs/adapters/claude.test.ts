import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_INPUT_MAX_BYTES, type RunEvent } from '../events.js';
import { claudeAdapter, claudeToolName } from './claude.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter((l) => l.trim());

function feed(lines: string[]) {
  const adapter = claudeAdapter();
  const events = lines.flatMap((l) => adapter.parse(l));
  return { events, outcome: adapter.finish() };
}

const line = (o: unknown) => JSON.stringify(o);

describe('claudeAdapter on a real stream-json run (claude-read.jsonl)', () => {
  const { events, outcome } = feed(fixture('claude-read.jsonl'));
  const types = events.map((e) => e.type);

  it('emits deltas, then the text, the tool calls with their results, the final text and the usage, in order', () => {
    const firstDelta = types.indexOf('text_delta');
    const firstText = types.indexOf('text');
    const firstTool = types.indexOf('tool_use');
    const firstResult = types.indexOf('tool_result');
    const lastText = types.lastIndexOf('text');
    const lastUsage = types.lastIndexOf('usage');
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(firstDelta).toBeLessThan(firstText);
    expect(firstText).toBeLessThan(firstTool);
    expect(firstTool).toBeLessThan(firstResult);
    expect(firstResult).toBeLessThan(lastText);
    expect(lastText).toBeLessThan(lastUsage);
    expect(types.at(-1)).toBe('usage');
  });

  it('normalizes the tool names and pairs each result with its call', () => {
    const uses = events.filter((e): e is Extract<RunEvent, { type: 'tool_use' }> => e.type === 'tool_use');
    expect(uses.map((u) => u.name)).toEqual(['search', 'read']);
    expect(uses[0].input).toEqual({ pattern: '*' });
    const results = events.filter((e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    expect(results.map((r) => r.id).sort()).toEqual(uses.map((u) => u.id).sort());
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.find((r) => r.id === uses[0].id)?.summary).toBe('a.txt\nb.md');
  });

  it('joins the deltas of a message into the same text the full message carries', () => {
    const lastText = events.filter((e) => e.type === 'text').at(-1) as { text: string };
    const afterTools = events.slice(types.lastIndexOf('tool_result') + 1);
    const joined = afterTools.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
    expect(joined).toBe(lastText.text);
  });

  it('finish() returns the result text and the cost from the result line', () => {
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toContain('hello');
    expect(outcome.usage?.cost_usd).toBeCloseTo(0.00144448, 8);
    expect(outcome.usage?.output_tokens).toBe(596);
    expect(outcome.usage?.input_tokens).toBe(4 + 5302 + 8568);
    const last = events.at(-1);
    expect(last).toEqual({ type: 'usage', ...outcome.usage });
  });

  it('keeps the running usage cumulative', () => {
    const outputs = events.filter((e) => e.type === 'usage').map((e) => (e as { output_tokens: number }).output_tokens);
    for (let i = 1; i < outputs.length; i++) expect(outputs[i]).toBeGreaterThanOrEqual(outputs[i - 1]);
  });
});

describe('claudeAdapter on lines it does not know', () => {
  it('returns [] for garbage, bare values and unknown types, and keeps going', () => {
    const adapter = claudeAdapter();
    expect(adapter.parse('')).toEqual([]);
    expect(adapter.parse('not json {')).toEqual([]);
    expect(adapter.parse('{"type":')).toEqual([]);
    expect(adapter.parse('42')).toEqual([]);
    expect(adapter.parse('[1,2]')).toEqual([]);
    expect(adapter.parse(line({ type: 'brand_new_event', data: 1 }))).toEqual([]);
    expect(adapter.parse(line({ type: 'assistant', message: 'oops' }))).toEqual([]);
    expect(adapter.parse(line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'future_delta' } } }))).toEqual([]);
    expect(adapter.parse(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }))).toEqual([{ type: 'text', text: 'ok' }]);
    expect(adapter.finish()).toEqual({ result: 'ok', usage: null, ok: false });
  });

  it('truncates a tool input over 2 KB and clips a result summary to 500 chars', () => {
    const adapter = claudeAdapter();
    const [use] = adapter.parse(
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'x', content: 'ç'.repeat(5000) } }] } }),
    );
    expect(use).toMatchObject({ type: 'tool_use', id: 't1', name: 'edit', input: { truncated: true } });
    expect(Buffer.byteLength(JSON.stringify((use as { input: unknown }).input), 'utf8')).toBeLessThanOrEqual(TOOL_INPUT_MAX_BYTES);
    const [result] = adapter.parse(
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'e'.repeat(2000) }] }] } }),
    );
    expect(result).toMatchObject({ type: 'tool_result', id: 't1', ok: false });
    expect(Array.from((result as { summary: string }).summary).length).toBeLessThanOrEqual(500);
  });

  it('turns an error result into an error event, a limit into account_limited', () => {
    const limited = claudeAdapter().parse(
      line({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 5pm", total_cost_usd: 0 }),
    );
    expect(limited.map((e) => e.type)).toEqual(['usage', 'error']);
    expect(limited[1]).toMatchObject({ code: 'account_limited' });
    const failed = claudeAdapter();
    expect(failed.parse(line({ type: 'result', subtype: 'error_max_turns', is_error: true }))[1]).toMatchObject({
      type: 'error',
      code: 'cli_failed',
      message: 'error_max_turns',
    });
    expect(failed.finish().ok).toBe(false);
  });
});

describe('claudeToolName', () => {
  it('maps the known tools and keeps the rest as other:<raw>', () => {
    expect(claudeToolName('Read')).toBe('read');
    expect(claudeToolName('Grep')).toBe('search');
    expect(claudeToolName('Edit')).toBe('edit');
    expect(claudeToolName('Bash')).toBe('shell');
    expect(claudeToolName('WebFetch')).toBe('web');
    expect(claudeToolName('mcp__x__y')).toBe('other:mcp__x__y');
  });
});
