import { describe, expect, it } from 'vitest';
import { mergeMessage } from './chat-merge';
import type { ChatMessage } from './types';

const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({ conversation_id: 'c1', role: 'assistant', text: '', error_code: null, created_at: '2026-09-26T00:00:00.000Z', ...over });

describe('mergeMessage', () => {
  it('appends an unknown id at the end', () => {
    const list = [msg({ id: 'm1', role: 'user', text: 'oi' })];
    const out = mergeMessage(list, msg({ id: 'm2' }));
    expect(out).not.toBe(list);
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out[0]).toBe(list[0]);
  });

  it('replaces a known id whose text changed, keeping every other object', () => {
    const list = [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2' })];
    const stored = msg({ id: 'm2', text: 'pronto' });
    const out = mergeMessage(list, stored);
    expect(out).not.toBe(list);
    expect(out[0]).toBe(list[0]);
    expect(out[1]).toBe(stored);
    expect(out).toHaveLength(2);
  });

  it('replaces a known id whose error changed', () => {
    const list = [msg({ id: 'm2' })];
    const out = mergeMessage(list, msg({ id: 'm2', error_code: 'RUN_FAILED' }));
    expect(out[0].error_code).toBe('RUN_FAILED');
  });

  it('returns the very same list when nothing changed', () => {
    const list = [msg({ id: 'm1', role: 'user', text: 'oi' }), msg({ id: 'm2', text: 'pronto' })];
    expect(mergeMessage(list, msg({ id: 'm2', text: 'pronto' }))).toBe(list);
  });
});
