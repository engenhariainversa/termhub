// The "Refazer login" modal's services: a flow over the real API singleton and the session store, which
// tells the status store when the login ended well (a screen test mocks this module).
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { api } from '@/services/api';
import { createAiLoginFlow, type AiLoginFlowStore } from './createAiLoginFlow';
import { useAiLoginStore } from './useAiLoginStore';

export function makeAiLoginFlow(accountId: string): AiLoginFlowStore {
  return createAiLoginFlow({ api, session: () => useSessionStore.getState(), accountId, onLoggedIn: (id) => useAiLoginStore.getState().markOk(id) });
}
