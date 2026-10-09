import { contextDetails, contextLabel, contextMeter, parseContextLimit, shortTokens } from './context';
import type { ChatConversation } from './types';

const conversation = (over: Partial<ChatConversation>): ChatConversation => ({ id: 'c1', title: null, project_id: null, archived_at: null, last_message_at: null, ...over });

describe('contextMeter (TER-1038)', () => {
  it('is nothing before the first answer reported a fill', () => {
    expect(contextMeter(conversation({}), null)).toBeNull();
    expect(contextMeter(null, 200_000)).toBeNull();
  });

  it("measures against the person's own limit first, else the window", () => {
    const own = contextMeter(conversation({ context_tokens: 150_000, context_window: 1_000_000 }), 200_000)!;
    expect(own).toMatchObject({ max: 200_000, ownLimit: true, share: 0.75, level: 'ok' });
    expect(contextLabel(own)).toBe('ctx 150k/200k');
    const win = contextMeter(conversation({ context_tokens: 170_000, context_window: 200_000 }), null)!;
    expect(win).toMatchObject({ max: 200_000, ownLimit: false, level: 'warn' });
    expect(contextMeter(conversation({ context_tokens: 196_000, context_window: 200_000 }), undefined)!.level).toBe('full');
    expect(contextLabel(contextMeter(conversation({ context_tokens: 950 }), null)!)).toBe('ctx 950');
  });

  it('spells the numbers, the window, the last compaction and what to do when high', () => {
    const lines = contextDetails(contextMeter(conversation({ context_tokens: 170_000, context_window: 1_000_000, context_compacted_at: '2026-10-07T12:00:00.000Z' }), 200_000)!);
    expect(lines[0]).toMatch(/170.000 de 200.000 tokens \(85%\), o seu limite/);
    expect(lines[1]).toMatch(/Janela do modelo: 1.000.000 tokens/);
    expect(lines[2]).toMatch(/^Última compactação: /);
    expect(lines[3]).toMatch(/Compactar/);
    expect(contextDetails(contextMeter(conversation({ context_tokens: 10_000, context_window: 200_000 }), null)!)).toEqual([expect.stringMatching(/10.000 de 200.000 tokens \(5%\)$/), 'Esta conversa ainda não foi compactada.']);
  });
});

it('shortens tokens the way the status line does', () => {
  expect(shortTokens(25_258)).toBe('25k');
  expect(shortTokens(1_000_000)).toBe('1M');
  expect(shortTokens(1_500_000)).toBe('1.5M');
});

it('reads the limit field in thousands, empty as the window, and refuses the rest', () => {
  expect(parseContextLimit(' 200 ')).toBe(200_000);
  expect(parseContextLimit('')).toBeNull();
  for (const bad of ['9', '10001', '1.5', '200k', 'abc']) expect(parseContextLimit(bad)).toBeUndefined();
});
