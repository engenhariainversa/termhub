// The app's one "Regras vigentes" store: the factory over the real API singleton and the session
// store, same pattern as `useChatMemoryStore.ts`.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createMemoryRulesStore } from './createMemoryRulesStore';

export const useMemoryRulesStore = createMemoryRulesStore({ api, session: () => useSessionStore.getState() });
