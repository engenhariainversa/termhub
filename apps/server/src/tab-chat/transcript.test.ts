import { describe, expect, it } from 'vitest';
import { isDegraded, parseLines } from './transcript.js';

/** Fixtures are built by hand from the key shapes of a real transcript; no real content. */
const L = (o: object) => JSON.stringify(o);
const base = { uuid: 'u1', timestamp: '2026-10-01T10:00:00.000Z', isSidechain: false };

describe('parseLines — Claude transcript lines to conversation items', () => {
  it('an assistant text block is an assistant item', () => {
    const { items } = parseLines([L({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Olá' }] } })]);
    expect(items).toEqual([{ kind: 'assistant', id: 'u1:0', at: base.timestamp, text: 'Olá' }]);
  });

  it('a tool_use block is a tool item with its summary', () => {
    const tool = (name: string, input: object) =>
      parseLines([L({ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input }] } })]).items[0];
    expect(tool('Bash', { command: 'npm test' })).toEqual({ kind: 'tool', id: 'toolu_1', at: base.timestamp, name: 'Bash', summary: 'npm test' });
    expect(tool('Read', { file_path: '/a/b.ts' })).toMatchObject({ summary: '/a/b.ts' });
    expect(tool('Grep', { pattern: 'foo' })).toMatchObject({ summary: 'foo' });
    expect(tool('Agent', { description: 'Map the code', prompt: 'long' })).toMatchObject({ summary: 'Map the code' });
    expect(tool('WebFetch', { url: 'https://x' })).toMatchObject({ summary: 'https://x' });
    expect(tool('WebSearch', { query: 'q' })).toMatchObject({ summary: 'q' });
    expect(tool('mcp__termhub__list_tabs', { a: 1 })).toMatchObject({ summary: null });
    expect((tool('Bash', { command: 'x'.repeat(500) }) as { summary: string }).summary).toHaveLength(300);
  });

  it('thinking blocks, sidechain lines and meta lines give nothing and are not unknown', () => {
    const p = parseLines([
      L({ ...base, type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } }),
      L({ ...base, type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }),
      L({ ...base, type: 'user', isMeta: true, message: { content: 'meta' } }),
    ]);
    expect(p.items).toEqual([]);
    expect(p.unknown).toBe(0);
  });

  it('a typed prompt is a user item', () => {
    expect(parseLines([L({ ...base, type: 'user', message: { role: 'user', content: 'faz o deploy' } })]).items).toEqual([
      { kind: 'user', id: 'u1', at: base.timestamp, text: 'faz o deploy', images: 0 },
    ]);
  });

  it('user blocks: text joined, images counted, tool results apart', () => {
    const { items } = parseLines([
      L({
        ...base,
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'veja' },
            { type: 'image', source: {} },
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: [{ type: 'text', text: 'boom' }] },
          ],
        },
      }),
    ]);
    expect(items).toEqual([
      { kind: 'user', id: 'u1', at: base.timestamp, text: 'veja', images: 1 },
      { kind: 'tool_result', id: 'u1:2', at: base.timestamp, tool_id: 'toolu_1', error: true, preview: 'boom' },
    ]);
  });

  it('a tool result with string content, and one longer than 2000 characters', () => {
    const r = (content: unknown) =>
      parseLines([L({ ...base, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] } })]).items[0] as {
        error: boolean;
        preview: string | null;
      };
    expect(r('ok')).toMatchObject({ error: false, preview: 'ok' });
    expect(r('y'.repeat(3000)).preview).toHaveLength(2000);
    expect(r([{ type: 'image' }]).preview).toBeNull();
  });

  it('a slash command and its output', () => {
    const { items } = parseLines([
      L({
        ...base,
        type: 'user',
        message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>' },
      }),
      L({ ...base, uuid: 'u2', type: 'user', message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } }),
      L({ ...base, uuid: 'u3', type: 'user', message: { content: '<command-name>/clear</command-name>\n<command-args></command-args>' } }),
    ]);
    expect(items).toEqual([
      { kind: 'command', id: 'u1', at: base.timestamp, name: '/compact', args: 'keep the plan' },
      { kind: 'command_output', id: 'u2', at: base.timestamp, text: 'Compacted' },
      { kind: 'command', id: 'u3', at: base.timestamp, name: '/clear', args: null },
    ]);
  });

  it('wrapper-only user lines are skipped', () => {
    for (const content of ['<task-notification>x</task-notification>', '<system-reminder>x</system-reminder>', '<local-command-caveat>x</local-command-caveat>']) {
      const p = parseLines([L({ ...base, type: 'user', message: { content } })]);
      expect(p.items).toEqual([]);
      expect(p.unknown).toBe(0);
    }
  });

  it('notices: compact summary, compact boundary, interrupt, dropped line', () => {
    const notices = parseLines([
      L({ ...base, uuid: 'a', type: 'user', isCompactSummary: true, message: { content: 'summary…' } }),
      L({ ...base, uuid: 'b', type: 'system', subtype: 'compact_boundary' }),
      L({ ...base, uuid: 'c', type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      L({ type: 'user', uuid: 'd', timestamp: base.timestamp, termhub_dropped: true }),
      L({ ...base, uuid: 'e', type: 'system', subtype: 'turn_duration' }),
    ]).items.map((i) => (i as { notice?: string }).notice);
    expect(notices).toEqual(['compacted', 'compacted', 'interrupted', 'truncated']);
  });

  it('the last permission-mode line is the mode', () => {
    expect(parseLines([L({ type: 'permission-mode', permissionMode: 'default' }), L({ type: 'permission-mode', permissionMode: 'plan' })]).mode).toBe('plan');
    expect(parseLines([]).mode).toBeNull();
  });

  it('a shape it does not know counts as unknown and never throws', () => {
    const p = parseLines([
      'not json',
      L({ ...base, type: 'assistant', message: { content: 'a string where blocks were' } }),
      L({ ...base, type: 'assistant', message: { content: [{ type: 'hologram' }] } }),
      L({ ...base, type: 'user' }),
    ]);
    expect(p.items).toEqual([]);
    expect(p.unknown).toBe(4);
    expect(isDegraded(p)).toBe(true);
    expect(isDegraded({ known: 3, unknown: 1 })).toBe(false);
    expect(isDegraded({ known: 0, unknown: 0 })).toBe(false);
  });

  it('never throws on odd values', () => {
    for (const raw of ['null', '7', '[]', '"x"', L({ type: 'user', message: null }), L({ type: 'assistant', message: { content: [null, 3] } })]) {
      expect(() => parseLines([raw])).not.toThrow();
    }
  });

  it('a line without a uuid or a timestamp still gets a stable id', () => {
    const raw = L({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } });
    const [a] = parseLines([raw]).items;
    expect(a.id).toMatch(/^[0-9a-f]{16}:0$/);
    expect(a.at).toBe('');
    expect(parseLines([raw]).items[0].id).toBe(a.id);
  });
});
