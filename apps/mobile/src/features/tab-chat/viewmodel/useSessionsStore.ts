// The app's one Sessões list, over the real API singleton and the session store.
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { api } from '@/services/api';
import { createSessionsStore } from './createSessionsStore';

export const useSessionsStore = createSessionsStore({ api, session: () => useSessionStore.getState() });
