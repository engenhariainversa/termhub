// The legal store (TER-742, spec 2026-10-07 legal acceptance): the Terms of Use / Privacy Policy
// versions in force the person has not accepted yet. While `pending` is not empty the redirect holds
// an unlocked session on `/legal-acceptance`. It loads on every session start and every return to
// the foreground; a failed read never locks anyone out: only a successful answer fills `pending`,
// and a server that predates the routes (404) means nothing is pending. A factory over injected
// services, like the other feature stores; `useLegalStore.ts` builds the app's one instance.
import { create } from 'zustand';
import { appForegrounded, sessionEnded, sessionStarted } from '@/features/shared/signals';
import type { SessionState } from '@/features/session/model/session.types';
import type { TLegalStatus, TLegalVersion } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { MobileApi } from '@/services/api/types';
import { LEGAL_MSG } from '../model/messages';

export type LegalSessionApi = Pick<SessionState, 'auth' | 'handleApiError'>;

export interface LegalDeps {
  api: MobileApi;
  session: () => LegalSessionApi;
  /** Loads on `sessionStarted` and `appForegrounded` (the app's instance); off in tests that drive
   * `load()` themselves. */
  refreshOnSignals?: boolean;
}

export interface LegalState {
  /** Versions in force still to accept: the app shows the acceptance screen instead of the tabs. */
  pending: TLegalVersion[];
  accepting: boolean;
  error: string | null;
  /** `GET legal`; single-flighted. Silent on failure (keeps what it knew). */
  load(): Promise<void>;
  /** "Continuar": `POST legal/accept` with every pending id. Resolves true once nothing is pending. */
  accept(): Promise<boolean>;
  clearError(): void;
}

const initial = { pending: [] as TLegalVersion[], accepting: false, error: null };

const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;

export function createLegalStore(deps: LegalDeps) {
  const { api, session } = deps;
  let generation = 0;
  let loading: Promise<void> | null = null;

  const store = create<LegalState>()((set, get) => {
    const apply = (status: TLegalStatus) => set({ pending: status.pending });

    return {
      ...initial,

      load() {
        loading ??= (async () => {
          const gen = generation;
          try {
            const status = await api.legalStatus(session().auth());
            if (gen === generation) apply(status);
          } catch (e) {
            // An older server has no such route: nothing to accept. Any other failure (offline, a
            // locked session) keeps what was known; the next foreground tries again.
            if (gen === generation && isNotFound(e)) set({ pending: [] });
          } finally {
            loading = null;
          }
        })();
        return loading;
      },

      async accept() {
        const ids = get().pending.map((v) => v.id);
        if (get().accepting) return false;
        if (ids.length === 0) return true;
        const gen = generation;
        set({ accepting: true, error: null });
        try {
          const status = await api.acceptLegal(session().auth(), ids);
          if (gen !== generation) return false;
          set({ accepting: false });
          apply(status);
          return get().pending.length === 0;
        } catch (e) {
          if (gen !== generation) return false;
          set({ accepting: false });
          if (isNotFound(e)) {
            set({ pending: [] });
            return true;
          }
          if (!session().handleApiError(e)) set({ error: e instanceof ApiError ? e.message : LEGAL_MSG.network });
          return false;
        }
      },

      clearError() {
        set({ error: null });
      },
    };
  });

  if (deps.refreshOnSignals) {
    // Locked (`auth()` throws): the unlock's `sessionStarted` loads it.
    const refresh = () => {
      try {
        session().auth();
      } catch {
        return;
      }
      void store.getState().load();
    };
    sessionStarted.subscribe(refresh);
    appForegrounded.subscribe(refresh);
  }

  // A new session on this phone starts from scratch; the server says again what is pending.
  sessionEnded.subscribe(() => {
    generation++;
    loading = null;
    store.setState(initial);
  });

  return store;
}
