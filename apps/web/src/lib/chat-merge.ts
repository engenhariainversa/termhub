import type { ChatMessage } from './types';

/** The fields a stored row can change after the panel first saw it. */
function same(a: ChatMessage, b: ChatMessage): boolean {
  return a.text === b.text && a.error_code === b.error_code && a.role === b.role && a.created_at === b.created_at;
}

/**
 * Applies one `message` event to the list of messages: replaces the row with that id, or appends the
 * row when it is new. Returns `list` itself when the stored row says nothing new — every other row keeps
 * its object either way, so a memoised row only re-renders when its own message changed.
 */
export function mergeMessage(list: readonly ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const at = list.findIndex((m) => m.id === msg.id);
  if (at === -1) return [...list, msg];
  if (same(list[at], msg)) return list as ChatMessage[];
  const next = list.slice();
  next[at] = msg;
  return next;
}
