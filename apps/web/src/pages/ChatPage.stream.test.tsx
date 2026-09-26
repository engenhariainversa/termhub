// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage';
import type { ChatMessage } from '../lib/types';

const chatMock = vi.fn();
const sendMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: { chat: (...a: unknown[]) => chatMock(...a), sendChatMessage: (...a: unknown[]) => sendMock(...a) },
  };
});
// The chat is the signed-in user's own, never the user an admin is "viewing as" (see ChatPage).
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
// '../lib/chat' is deliberately NOT mocked here: this file pins the real useChatStream's
// event-delivery contract against ChatPage. The bug lived exactly at that seam — the hook used to
// keep a capped 500-event buffer, and the page derived "have I handled this event" from an index
// into it, so past the cap the terminating `message` event was silently dropped. The hook now
// delivers every event once through `onEvent`, and this is the test that keeps it so.

/** Minimal stand-in for the browser WebSocket, same shape as terminal-connection.test.ts's FakeSocket. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close() {}
  open() {
    this.onopen?.();
  }
  message(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
const last = () => FakeSocket.all[FakeSocket.all.length - 1];

const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  conversation_id: 'c1',
  role: 'assistant',
  text: '',
  error_code: null,
  created_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  chatMock.mockReset();
  sendMock.mockReset();
  chatMock.mockResolvedValue({
    conversation: { id: 'c1', title: null, model: null, review_mode: false, last_message_at: null },
    messages: [msg({ id: 'm2' })],
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('still lands a finished answer after 600 streamed frames', async () => {
  // The old buffer settled at a constant length once ~501 events had arrived (each new event
  // evicting the oldest). 600 deltas plus the terminating `message` event comfortably clears that
  // plateau — if any delivery ever tracked "handled" as an index into a capped array, this `message`
  // event would be silently dropped and the reply would never leave "pensando…".
  render(<ChatPage />);
  await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(1));

  await act(async () => {
    last().open();
  });
  await waitFor(() => expect(chatMock).toHaveBeenCalledTimes(2));

  // Each frame is flushed on its own — real WS frames arrive one at a time, each triggering its
  // own render+effect cycle; batching all 601 into one `act()` call would hide the bug (the
  // "already handled" marker would jump straight from 0 to the final length in a single step).
  for (let i = 0; i < 600; i++) {
    await act(async () => {
      last().message({ type: 'delta', message_id: 'm2', delta: 'x' });
    });
  }
  await act(async () => {
    last().message({ type: 'message', message: msg({ id: 'm2', text: 'pronto' }) });
  });

  // The stored row is merged in place by id: the final text shows, and the streamed 600 x's are let
  // go of, without one more GET /chat.
  expect(await screen.findByText('pronto')).toBeTruthy();
  expect(screen.queryByText(/^x+$/)).toBeNull();
  expect(chatMock).toHaveBeenCalledTimes(2);
});
