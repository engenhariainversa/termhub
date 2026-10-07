// The app's one legal store (TER-742): the factory over the real API singleton and the session
// store, loading on every session start and return to the foreground. A cancelled account deletion
// (TER-720) reads it again: while the account was pending, `GET legal` answered 403.
import { api } from '@/services/api';
import { useAccountStore } from '@/features/account/viewmodel/useAccountStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createLegalStore } from './createLegalStore';

export const useLegalStore = createLegalStore({
  api,
  session: () => useSessionStore.getState(),
  refreshOnSignals: true,
});

useAccountStore.subscribe((s, prev) => {
  if (prev.pending && !s.pending) void useLegalStore.getState().load();
});
