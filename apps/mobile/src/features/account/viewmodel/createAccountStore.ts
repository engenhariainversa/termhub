// The account store (TER-720): self-service account deletion from Ajustes, and the pending state
// that follows it. While a deletion is pending the server answers every other route with
// `403 ACCOUNT_PENDING_DELETION`; the app learns it from the request itself or from any such answer
// (`markPending`, wired to the API client's signal), and shows the blocking screen until the person
// cancels. A factory over injected services, like the other feature stores; `useAccountStore.ts`
// builds the app's one instance.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import type { SessionState } from '@/features/session/model/session.types';
import { ACCOUNT_DELETION_ACTION_ID, type AccountDeletionStatus } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { MobileApi } from '@/services/api/types';
import { ACCOUNT_MSG } from '../model/messages';

export type AccountSessionApi = Pick<SessionState, 'auth' | 'handleApiError' | 'requestPinProof'>;

export interface AccountDeps {
  api: MobileApi;
  session: () => AccountSessionApi;
  /** Fires on every `403 ACCOUNT_PENDING_DELETION` (the app passes `accountPendingDeletion`). */
  pendingSignal?: { subscribe(fn: () => void): () => void };
  /** Stops what keeps calling the API on its own (the chat socket, Progresso's polling) once the
   * account is pending, so a deactivated account is not polled for nothing. */
  onPending?: () => void;
}

export interface AccountState {
  /** A deletion is pending: the app shows the blocking screen instead of the tabs. */
  pending: boolean;
  /** When the account is deleted for good (ISO), once known. */
  scheduledAt: string | null;
  requesting: boolean;
  cancelling: boolean;
  error: string | null;
  /** "Confirmar exclusão": the PIN sheet (or biometrics), then `POST account/deletion`. Resolves true
   * once the deletion is pending; false when cancelled or refused (`error` says why). */
  requestDeletion(): Promise<boolean>;
  /** An answer said the account is pending: show the blocking screen at once and read the date once.
   * A no-op while already pending, so a burst of 403s costs one status read. */
  markPending(): Promise<void>;
  /** Re-reads the status (`GET account/deletion`); single-flighted. */
  refresh(): Promise<void>;
  /** "Cancelar exclusão": `DELETE account/deletion`, then back to the app. */
  cancelDeletion(): Promise<void>;
  clearError(): void;
}

const initial = { pending: false, scheduledAt: null, requesting: false, cancelling: false, error: null };

export function createAccountStore(deps: AccountDeps) {
  const { api, session } = deps;
  let generation = 0;
  let refreshing: Promise<void> | null = null;

  const store = create<AccountState>()((set, get) => {
    const apply = (status: AccountDeletionStatus) => {
      const wasPending = get().pending;
      set({ pending: status.pending, scheduledAt: status.pending ? status.scheduled_at : null });
      if (status.pending && !wasPending) deps.onPending?.();
    };

    /** A failure the session does not route itself (a relock, a revoked device) becomes `error`. */
    const fail = (e: unknown) => {
      if (session().handleApiError(e)) return;
      set({ error: e instanceof ApiError ? e.message : ACCOUNT_MSG.network });
    };

    return {
      ...initial,

      async requestDeletion() {
        if (get().requesting) return false;
        const gen = generation;
        set({ requesting: true, error: null });
        // A holder, not a `let`: TypeScript does not see the closure assign it.
        const out: { status?: AccountDeletionStatus } = {};
        try {
          await session().requestPinProof(
            ACCOUNT_DELETION_ACTION_ID,
            async (proof) => {
              out.status = await api.requestAccountDeletion(session().auth(), proof);
            },
            'delete_account',
            ACCOUNT_MSG.pinTitle,
          );
        } catch (e) {
          if (gen !== generation) return false;
          set({ requesting: false });
          // The PIN sheet was closed, or the session relocked or wiped (it already said so).
          if (e instanceof Error && e.message === 'CANCELLED') return false;
          fail(e);
          return false;
        }
        if (gen !== generation) return false;
        set({ requesting: false });
        if (out.status) apply(out.status);
        return get().pending;
      },

      async markPending() {
        if (get().pending) return;
        set({ pending: true });
        deps.onPending?.();
        await get().refresh();
      },

      refresh() {
        refreshing ??= (async () => {
          const gen = generation;
          try {
            const status = await api.accountDeletion(session().auth());
            if (gen === generation) apply(status);
          } catch {
            // Silent: the blocking screen stays, without the date, and its cancel still works.
          } finally {
            refreshing = null;
          }
        })();
        return refreshing;
      },

      async cancelDeletion() {
        if (get().cancelling) return;
        const gen = generation;
        set({ cancelling: true, error: null });
        try {
          const status = await api.cancelAccountDeletion(session().auth());
          if (gen !== generation) return;
          set({ cancelling: false });
          apply(status);
        } catch (e) {
          if (gen !== generation) return;
          set({ cancelling: false });
          fail(e);
        }
      },

      clearError() {
        set({ error: null });
      },
    };
  });

  deps.pendingSignal?.subscribe(() => void store.getState().markPending());

  // A new session on this phone starts from scratch; the server tells it again if still pending.
  sessionEnded.subscribe(() => {
    generation++;
    refreshing = null;
    store.setState(initial);
  });

  return store;
}
