import type { ChatRepository } from '../db/repositories/chat.js';
import { chatBus } from './bus.js';
import { failureLabel } from './service.js';

/**
 * Stores how full a conversation's CLI session is and tells every open screen (TER-315). Never
 * throws: the fill is what the chat header shows, and a write that fails must not fail the answer it
 * came with — it is logged by label and the next turn writes it again.
 */
export async function saveContext(chat: Pick<ChatRepository, 'setContext'>, userId: string, conversationId: string, fill: { tokens: number; window?: number | null; compacted?: boolean }): Promise<void> {
  try {
    const stored = await chat.setContext(conversationId, fill);
    chatBus.publish({ type: 'context', user_id: userId, conversation_id: conversationId, tokens: stored.tokens, window: stored.window, compacted_at: stored.compacted_at });
  } catch (err) {
    console.error('chat: context fill not stored', { conversation_id: conversationId, error: failureLabel(err) });
  }
}
