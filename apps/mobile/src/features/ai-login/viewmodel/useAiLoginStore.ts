// The app's one AI login status store, over the real API singleton and the session store.
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { api } from '@/services/api';
import { createAiLoginStore } from './createAiLoginStore';

export const useAiLoginStore = createAiLoginStore({ api, session: () => useSessionStore.getState(), refreshOnForeground: true });
