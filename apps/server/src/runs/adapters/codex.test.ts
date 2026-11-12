import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_INPUT_MAX_BYTES } from '../events.js';
import { codexAdapter } from './codex.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter((l) => l.trim());

const line = (o: unknown) => JSON.stringify(o);

describe('codexAdapter on an exec --json run (codex-read.jsonl)', () => {
  const adapter = codexAdapter();
  const events = fixture('codex-read.jsonl').flatMap((l) => adapter.parse(l));
  const outcome = adapter.finish();

  it('maps agent messages, the command and the turn usage, in order', () => {
    expect(events).toEqual([
      { type: 'text', text: 'Hi! Let me list the files here.' },
      { type: 'tool_use', id: 'item_2', name: 'shell', input: { command: 'bash -lc ls' } },
      { type: 'tool_result', id: 'item_2', ok: true, summary: 'a.txt\nb.md\n' },
      { type: 'text', text: 'Hi! The folder has two files: `a.txt` and `b.md`.' },
      { type: 'usage', input_tokens: 8123, output_tokens: 187 },
    ]);
  });

  it('finish() returns the last agent message and the usage, without a cost', () => {
    expect(outcome).toEqual({
      result: 'Hi! The folder has two files: `a.txt` and `b.md`.',
      usage: { input_tokens: 8123, output_tokens: 187 },
      ok: true,
    });
  });
});

describe('codexAdapter on other items and failures', () => {
  it('announces a command once even without item.started, and a failed exit is not ok', () => {
    const adapter = codexAdapter();
    const out = adapter.parse(
      line({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } }),
    );
    expect(out).toEqual([
      { type: 'tool_use', id: 'c1', name: 'shell', input: { command: 'false' } },
      { type: 'tool_result', id: 'c1', ok: false, summary: '' },
    ]);
  });

  it('maps file changes to edit and web searches to web', () => {
    const adapter = codexAdapter();
    const edit = adapter.parse(
      line({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } }),
    );
    expect(edit.map((e) => e.type)).toEqual(['tool_use', 'tool_result']);
    expect(edit[0]).toMatchObject({ name: 'edit' });
    expect(edit[1]).toMatchObject({ ok: true, summary: 'update src/a.ts' });
    const web = adapter.parse(line({ type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'vitest' } }));
    expect(web[0]).toMatchObject({ type: 'tool_use', name: 'web', input: { query: 'vitest' } });
    const mcp = adapter.parse(line({ type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'docs', tool: 'search', status: 'in_progress' } }));
    expect(mcp[0]).toMatchObject({ name: 'other:docs.search' });
  });

  it('turns a failed turn into an error, a limit into account_limited, and finish() is not ok', () => {
    const adapter = codexAdapter();
    const [error] = adapter.parse(line({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } }));
    expect(error).toMatchObject({ type: 'error', code: 'account_limited' });
    expect(adapter.parse(line({ type: 'turn.failed', error: { message: 'stream disconnected' } }))[0]).toMatchObject({ code: 'cli_failed' });
    expect(adapter.finish()).toEqual({ result: null, usage: null, ok: false });
  });

  it('sums usage over turns', () => {
    const adapter = codexAdapter();
    adapter.parse(line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 } }));
    const [usage] = adapter.parse(line({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }));
    expect(usage).toEqual({ type: 'usage', input_tokens: 17, output_tokens: 5 });
  });

  it('returns [] for garbage, unknown types, reasoning and retry errors, and does not throw', () => {
    const adapter = codexAdapter();
    for (const l of [
      '',
      'Reading prompt from stdin...',
      '{"broken":',
      line({ type: 'thread.started', thread_id: 'x' }),
      line({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'hmm' } }),
      line({ type: 'item.completed', item: { id: 't', type: 'todo_list', items: [] } }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'no id' } }),
      line({ type: 'error', message: 'Reconnecting... 1/5' }),
      line({ type: 'thread.future_event', x: 1 }),
      line({ type: 'item.completed', item: 'nope' }),
    ]) {
      expect(adapter.parse(l)).toEqual([]);
    }
  });

  it('truncates a command over 2 KB and clips its output to 500 chars', () => {
    const adapter = codexAdapter();
    const [use, result] = adapter.parse(
      line({ type: 'item.completed', item: { id: 'big', type: 'command_execution', command: 'x'.repeat(4000), aggregated_output: 'y'.repeat(4000), exit_code: 0, status: 'completed' } }),
    );
    expect(use).toMatchObject({ input: { truncated: true } });
    expect(Buffer.byteLength(JSON.stringify((use as { input: unknown }).input), 'utf8')).toBeLessThanOrEqual(TOOL_INPUT_MAX_BYTES);
    expect((result as { summary: string }).summary.length).toBe(500);
  });
});
