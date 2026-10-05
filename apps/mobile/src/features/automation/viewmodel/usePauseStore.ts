// The app's one pause store, over the real API singleton and the session store.
import { api } from '@/services/api';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createPauseStore } from './createPauseStore';

export const usePauseStore = createPauseStore({ api, session: () => useSessionStore.getState(), events: { subscribe: (fn) => useChatStore.getState().subscribeEvents(fn) } });
