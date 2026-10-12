import { createContext, useContext } from 'react';

/**
 * Where a chat panel puts its cog (TER-1039): the element at the end of the header that frames it —
 * `/chat`'s own bar (`ChatLayout`) or the dock's per-project header (`ChatDock`). The panel portals
 * its button there, so the header shows one icon and the conversation's settings live in their own
 * dialog. `null` = no header around this panel (a test, say): the panel draws the cog itself.
 */
export const ChatHeaderSlot = createContext<HTMLElement | null>(null);

export const useChatHeaderSlot = () => useContext(ChatHeaderSlot);
