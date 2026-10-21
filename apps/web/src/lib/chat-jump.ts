import { useSyncExternalStore } from 'react';

/**
 * TER-1101: "open the chat at this message", asked from outside the chat (a browser notification's click).
 * The chat panel showing that conversation takes it once the message is on screen and clears it.
 */
export interface ChatJump {
  conversationId: string;
  messageId: string;
}

let pending: ChatJump | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function requestChatJump(jump: ChatJump): void {
  pending = jump;
  emit();
}

/** Clears the jump, but only if it is still `jump` (a newer one stays). */
export function clearChatJump(jump: ChatJump): void {
  if (pending !== jump) return;
  pending = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The pending jump for this conversation, or null. */
export function useChatJump(conversationId: string | null): ChatJump | null {
  const jump = useSyncExternalStore(subscribe, () => pending);
  return jump && jump.conversationId === conversationId ? jump : null;
}
