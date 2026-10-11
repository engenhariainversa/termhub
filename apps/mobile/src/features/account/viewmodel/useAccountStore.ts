// The app's one account store: the factory over the real API singleton, the session store and the
// client's `403 ACCOUNT_PENDING_DELETION` signal. Once pending, the chat socket closes and
// Progresso stops polling; both start again when the person comes back to the tabs.
import { api } from '@/services/api';
import { accountPendingDeletion } from '@/services/api/account-pending';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useProgressStore } from '@/features/progress/viewmodel/useProgressStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createAccountStore } from './createAccountStore';

export const useAccountStore = createAccountStore({
  api,
  session: () => useSessionStore.getState(),
  pendingSignal: accountPendingDeletion,
  onPending: () => {
    useChatStore.getState().close();
    useProgressStore.getState().stopPolling();
  },
});
