// The app's one pause store, over the real API singleton and the session store.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createPauseStore } from './createPauseStore';

export const usePauseStore = createPauseStore({ api, session: () => useSessionStore.getState() });
