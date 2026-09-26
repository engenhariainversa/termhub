// The app's one grants store: the factory over the real API singleton and the session store.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createChatGrantsStore } from './createChatGrantsStore';

export const useChatGrantsStore = createChatGrantsStore({ api, session: () => useSessionStore.getState() });
