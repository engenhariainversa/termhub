// "Compactar" for the open conversation (TER-1152), as the header's meter and the conversation's
// settings offer it: the web's `canCompact` rule, with the server's 409s covering an answer in flight.
import { useMemo } from 'react';
import type { CompactControl } from '../view/context-meter';
import type { ConversationSlot } from './createChatStore';
import { useChatStore } from './useChatStore';

export function useCompactControl(slot: ConversationSlot | undefined): CompactControl {
  const compact = useChatStore((s) => s.compact);
  const sending = useChatStore((s) => s.sending);
  const compacting = slot?.compacting === true;
  const canCompact = !compacting && !sending && (slot?.messages.length ?? 0) > 0 && slot?.host?.kind === 'ready';
  return useMemo(() => ({ compacting, canCompact, onCompact: () => void compact() }), [compacting, canCompact, compact]);
}
