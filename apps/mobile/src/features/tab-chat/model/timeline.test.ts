import type { TTabChatItem } from '@/services/api/contract';
import { buildRows, mergeItems } from './timeline';

const at = '2026-10-01T10:00:00.000Z';
const user = (id: string, text: string, images = 0): TTabChatItem => ({ kind: 'user', id, at, text, images });
const assistant = (id: string, text: string): TTabChatItem => ({ kind: 'assistant', id, at, text });
const tool = (id: string, name: string, summary: string | null = null): TTabChatItem => ({ kind: 'tool', id, at, name, summary });
const result = (id: string, toolId: string, error = false, preview: string | null = 'ok'): TTabChatItem => ({ kind: 'tool_result', id, at, tool_id: toolId, error, preview });

describe('mergeItems', () => {
  it('appends new items at the end, in order', () => {
    const merged = mergeItems([user('a', 'oi')], [assistant('b', 'olá'), user('c', 'e aí')], 'append');
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps one copy of an item already there: the incoming one, where the old one was', () => {
    const merged = mergeItems([user('a', 'oi'), assistant('b', 'old')], [assistant('b', 'new'), user('c', 'x')], 'append');
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(merged[1]).toMatchObject({ text: 'new' });
  });

  it('prepends an older page before, with no duplicate', () => {
    const merged = mergeItems([user('c', 'x'), assistant('d', 'y')], [user('a', 'a'), assistant('b', 'b'), user('c', 'x')], 'prepend');
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns the same array when nothing comes in', () => {
    const current = [user('a', 'oi')];
    expect(mergeItems(current, [], 'append')).toBe(current);
  });
});

describe('buildRows', () => {
  it('user and assistant items are message rows', () => {
    expect(buildRows([user('a', 'faz o deploy'), assistant('b', 'Feito')], false)).toEqual([
      { kind: 'message', id: 'a', role: 'user', text: 'faz o deploy', images: 0, at },
      { kind: 'message', id: 'b', role: 'assistant', text: 'Feito', images: 0, at },
    ]);
  });

  it('a user item with images and no text keeps its image count', () => {
    expect(buildRows([user('a', '', 2)], false)).toEqual([{ kind: 'message', id: 'a', role: 'user', text: '', images: 2, at }]);
  });

  it('consecutive tools are one row; their results set status and preview and give no row', () => {
    const rows = buildRows(
      [tool('t1', 'Bash', 'npm test'), result('r1', 't1', false, 'passou'), tool('t2', 'Read', '/a.ts'), result('r2', 't2', true, 'boom'), tool('t3', 'Grep', 'foo')],
      false,
    );
    expect(rows).toEqual([
      {
        kind: 'tools',
        id: 'tools:t1',
        tools: [
          { id: 't1', name: 'Bash', summary: 'npm test', status: 'done', preview: 'passou' },
          { id: 't2', name: 'Read', summary: '/a.ts', status: 'error', preview: 'boom' },
          { id: 't3', name: 'Grep', summary: 'foo', status: 'done', preview: null },
        ],
      },
    ]);
  });

  it('a tool with no result is running while the tab works, done otherwise', () => {
    expect(buildRows([tool('t1', 'Bash')], true)[0]).toMatchObject({ tools: [{ status: 'running' }] });
    expect(buildRows([tool('t1', 'Bash')], false)[0]).toMatchObject({ tools: [{ status: 'done' }] });
  });

  it('text between tools splits them in two rows', () => {
    const rows = buildRows([tool('t1', 'Bash'), assistant('a', 'vou ler'), tool('t2', 'Read')], false);
    expect(rows.map((r) => r.kind)).toEqual(['tools', 'message', 'tools']);
  });

  it('a result whose tool is on an earlier page gives nothing', () => {
    expect(buildRows([result('r1', 'gone'), assistant('a', 'ok')], false)).toEqual([{ kind: 'message', id: 'a', role: 'assistant', text: 'ok', images: 0, at }]);
  });

  it('commands, their output and notices are lines', () => {
    const rows = buildRows(
      [
        { kind: 'command', id: 'c1', at, name: '/compact', args: 'keep the plan' },
        { kind: 'command', id: 'c2', at, name: '/clear', args: null },
        { kind: 'command_output', id: 'o1', at, text: 'Compacted' },
        { kind: 'notice', id: 'n1', at, notice: 'compacted' },
        { kind: 'notice', id: 'n2', at, notice: 'interrupted' },
        { kind: 'notice', id: 'n3', at, notice: 'truncated' },
      ],
      false,
    );
    expect(rows).toEqual([
      { kind: 'line', id: 'c1', text: '/compact keep the plan' },
      { kind: 'line', id: 'c2', text: '/clear' },
      { kind: 'line', id: 'o1', text: 'Compacted' },
      { kind: 'line', id: 'n1', text: 'Conversa compactada' },
      { kind: 'line', id: 'n2', text: 'Interrompido' },
      { kind: 'line', id: 'n3', text: 'Parte do histórico foi omitida por ser grande demais' },
    ]);
  });
});
