import { beforeEach, expect, it, vi } from 'vitest';
import type { ControlContext } from './context.js';
import { getChatContext } from './chat-context.js';

const findByIdForUser = vi.fn();
const chatContextLimit = vi.fn();
const ctxWith = (token?: ControlContext['token']) => ({ repos: { chat: { findByIdForUser }, users: { chatContextLimit } }, scope: { user: { id: 'u1' } }, token }) as unknown as ControlContext;
const inChat = { id: 'tok', scopes: ['read'], gated: true, chat_conversation_id: 'c1' } as ControlContext['token'];
const conversation = (over: Record<string, unknown>) => ({ id: 'c1', context_tokens: null, context_window: null, context_compacted_at: null, ...over });

beforeEach(() => {
  findByIdForUser.mockReset();
  chatContextLimit.mockReset().mockResolvedValue(null);
});

it('measures against the window when the person set no limit (TER-1038)', async () => {
  findByIdForUser.mockResolvedValue(conversation({ context_tokens: 150_000, context_window: 1_000_000, context_compacted_at: '2026-10-07T12:00:00.000Z' }));
  const out = await getChatContext(ctxWith(inChat));
  expect(findByIdForUser).toHaveBeenCalledWith('c1', 'u1');
  expect(out).toMatchObject({ tokens: 150_000, window: 1_000_000, limit: null, measured_against: 'window', percent: 15, compacted_at: '2026-10-07T12:00:00.000Z', suggest_compact: false });
});

it("measures against the person's own limit first, and suggests compacting past 80% of it", async () => {
  chatContextLimit.mockResolvedValue(200_000);
  findByIdForUser.mockResolvedValue(conversation({ context_tokens: 170_000, context_window: 1_000_000 }));
  const out = await getChatContext(ctxWith(inChat));
  expect(out).toMatchObject({ limit: 200_000, measured_against: 'limit', percent: 85, suggest_compact: true });
  expect(out.note).toMatch(/Compactar/);
});

it('caps the percent at 100 when the session already passed the limit', async () => {
  chatContextLimit.mockResolvedValue(100_000);
  findByIdForUser.mockResolvedValue(conversation({ context_tokens: 180_000, context_window: 200_000 }));
  expect(await getChatContext(ctxWith(inChat))).toMatchObject({ percent: 100, suggest_compact: true });
});

it('says there is no measure yet before the first turn', async () => {
  findByIdForUser.mockResolvedValue(conversation({}));
  const out = await getChatContext(ctxWith(inChat));
  expect(out).toMatchObject({ tokens: null, percent: null, measured_against: null, suggest_compact: false });
  expect(out.note).toMatch(/primeiro turno/);
});

it('refuses outside the chat, and for a conversation the token does not reach', async () => {
  await expect(getChatContext(ctxWith(undefined))).rejects.toMatchObject({ code: 'NOT_IN_CHAT' });
  findByIdForUser.mockResolvedValue(undefined);
  await expect(getChatContext(ctxWith(inChat))).rejects.toMatchObject({ code: 'NOT_IN_CHAT' });
});
