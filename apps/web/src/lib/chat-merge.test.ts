import { describe, expect, it } from 'vitest';
import { mergeMessage } from './chat-merge';
import type { ChatAttachment, ChatMessage } from './types';

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

  it('replaces a known id whose attachments changed, and only then', () => {
    const att = (over: Partial<ChatAttachment> & { id: string }): ChatAttachment => ({ name: 'x.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 10, status: 'pending', error_code: null, meta: null, created_at: '2026-09-26T00:00:00.000Z', ...over });
    const list = [msg({ id: 'm1', role: 'user', text: 'leia', attachments: [att({ id: 'a1' }), att({ id: 'a2' })] })];

    // The same two, in the same state: nothing new.
    expect(mergeMessage(list, msg({ id: 'm1', role: 'user', text: 'leia', attachments: [att({ id: 'a1' }), att({ id: 'a2' })] }))).toBe(list);
    // One of them finished, or failed, or the row gained or lost one: the stored row wins.
    const ready = msg({ id: 'm1', role: 'user', text: 'leia', attachments: [att({ id: 'a1', status: 'ready' }), att({ id: 'a2' })] });
    expect(mergeMessage(list, ready)[0]).toBe(ready);
    const failed = msg({ id: 'm1', role: 'user', text: 'leia', attachments: [att({ id: 'a1' }), att({ id: 'a2', status: 'failed', error_code: 'ATTACHMENT_INVALID' })] });
    expect(mergeMessage(list, failed)[0]).toBe(failed);
    const fewer = msg({ id: 'm1', role: 'user', text: 'leia', attachments: [att({ id: 'a1' })] });
    expect(mergeMessage(list, fewer)[0]).toBe(fewer);
    const swapped = msg({ id: 'm1', role: 'user', text: 'leia', attachments: [att({ id: 'a1' }), att({ id: 'a3' })] });
    expect(mergeMessage(list, swapped)[0]).toBe(swapped);
    // A row that never had any against one that says so explicitly: the same thing.
    const bare = [msg({ id: 'm1', role: 'user', text: 'leia' })];
    expect(mergeMessage(bare, msg({ id: 'm1', role: 'user', text: 'leia', attachments: [] }))).toBe(bare);
  });
});
