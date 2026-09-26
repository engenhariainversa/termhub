// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createLiveFold, useChatLive } from './chat-live';
import type { ChatEvent, ChatMessage } from './types';

const delta = (id: string, text: string): ChatEvent => ({ type: 'delta', message_id: id, delta: text, conversation_id: 'c1' });
const action = (id: string, tool: string): ChatEvent => ({ type: 'action', message_id: id, tool, tool_use_id: 'tu1', args: {}, conversation_id: 'c1' });
const announce = (id: string): ChatEvent => ({ type: 'message', conversation_id: 'c1', message: { id, conversation_id: 'c1', role: 'assistant', text: '', error_code: null, created_at: '' } as ChatMessage });

describe('createLiveFold', () => {
  it('folds deltas per message id, one frame at a time, and counts a version per change', () => {
    const fold = createLiveFold();
    expect(fold.version).toBe(0);
    expect(fold.apply(delta('m1', 'par'))).toBe(true);
    expect(fold.apply(delta('m1', 'cial'))).toBe(true);
    expect(fold.apply(delta('m2', 'outra'))).toBe(true);
    expect(fold.get('m1')).toEqual({ text: 'parcial', tools: [], started: true });
    expect(fold.get('m2')?.text).toBe('outra');
    expect(fold.version).toBe(3);
  });

  it('keeps the same tools array while only text streams, so a memoised row can bail out', () => {
    const fold = createLiveFold();
    fold.apply(action('m1', 'Bash'));
    const before = fold.get('m1')!.tools;
    fold.apply(delta('m1', 'x'));
    fold.apply(action('m2', 'Read'));
    expect(fold.get('m1')!.tools).toBe(before);
    expect(before).toEqual([{ tool: 'Bash' }]);
    fold.apply(action('m1', 'Read'));
    expect(fold.get('m1')!.tools).not.toBe(before);
    expect(fold.get('m1')!.tools).toEqual([{ tool: 'Bash' }, { tool: 'Read' }]);
  });

  it('ignores what is not its business and does not bump the version for it', () => {
    const fold = createLiveFold();
    expect(fold.apply({ type: 'action_result', message_id: 'm1', tool_use_id: 'tu1', ok: true })).toBe(false);
    expect(fold.apply({ type: 'grant_revoked', grant_id: 'g1' })).toBe(false);
    expect(fold.apply({ type: 'reset', message_id: 'nobody' })).toBe(false);
    expect(fold.version).toBe(0);
    expect(fold.get('m1')).toBeUndefined();
  });

  it('a reset drops what streamed for that id', () => {
    const fold = createLiveFold();
    fold.apply(delta('m1', 'meia resposta'));
    expect(fold.apply({ type: 'reset', message_id: 'm1' })).toBe(true);
    expect(fold.get('m1')).toBeUndefined();
  });

  it('an announced empty assistant row is started with no text', () => {
    const fold = createLiveFold();
    expect(fold.apply(announce('m1'))).toBe(true);
    expect(fold.get('m1')).toEqual({ text: '', tools: [], started: true });
    // Announced again (a reconnect, a second tab): nothing changes.
    expect(fold.apply(announce('m1'))).toBe(false);
  });
});

describe('useChatLive', () => {
  it('re-renders with a new version on a change, keeps the same fold, and hands out a stable push', () => {
    const { result } = renderHook(() => useChatLive());
    const { fold, push } = result.current;
    expect(result.current.version).toBe(0);
    act(() => push(delta('m1', 'oi')));
    expect(result.current.version).toBe(1);
    expect(result.current.fold).toBe(fold);
    expect(result.current.push).toBe(push);
    expect(fold.get('m1')?.text).toBe('oi');
    // Nothing changed, nothing rendered: the version stays.
    act(() => push({ type: 'reset', message_id: 'm9' }));
    expect(result.current.version).toBe(1);
  });
});
