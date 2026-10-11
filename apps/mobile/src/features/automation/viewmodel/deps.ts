// The automation screen's services: the real API singleton and the session store (a screen test mocks this module).
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { api } from '@/services/api';
import type { AutomationDeps } from './use-automation';

export const automationDeps: AutomationDeps = { api, session: () => useSessionStore.getState() };
