// The session stores of the app, over the real API singleton and the session store: one store per open
// session screen (`useTabChatStore`), closed when the screen goes, and the app's one Sessões list.
import { useEffect, useState } from 'react';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { api } from '@/services/api';
import { createSessionsStore } from './createSessionsStore';
import { createTabChatStore } from './createTabChatStore';

export type TabChatStore = ReturnType<typeof createTabChatStore>;

export function makeTabChatStore(tabId: string): TabChatStore {
  return createTabChatStore({ api, session: () => useSessionStore.getState(), tabId });
}

/**
 * The store of `tabId`'s screen: opened on mount, closed on unmount (or when `tabId` changes). The
 * chat socket's card events reach it while it lives (`noteQuestionEvent`); that socket is the chat
 * screen's, so with no chat open the cards are re-read when the tab starts or stops needing the person.
 */
export function useTabChatStore(tabId: string, make: (tabId: string) => TabChatStore = makeTabChatStore): TabChatStore {
  const [store, setStore] = useState(() => make(tabId));
  const [storeTab, setStoreTab] = useState(tabId);
  if (storeTab !== tabId) {
    setStoreTab(tabId);
    setStore(make(tabId));
  }
  useEffect(() => {
    void store.getState().open();
    const unsubscribe = useChatStore.getState().subscribeEvents((e) => store.getState().noteQuestionEvent(e));
    return () => {
      unsubscribe();
      store.getState().close();
    };
  }, [store]);
  return store;
}

export const useSessionsStore = createSessionsStore({ api, session: () => useSessionStore.getState() });
