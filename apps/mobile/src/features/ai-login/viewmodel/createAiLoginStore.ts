// The AI accounts' login state (TER-1047): what the red banner reads. Loaded when the app comes back to
// the foreground, when a session starts and when a main screen gains focus — never on a timer, the
// server's own background check is what notices an expired login. Nothing is persisted.
import { create } from 'zustand';
import { appForegrounded, sessionEnded, sessionStarted } from '@/features/shared/signals';
import type { AiLoginStatusRow } from '@/services/api/contract';
import type { Auth, MobileApi } from '@/services/api/types';

export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface AiLoginStatusDeps {
  api: Pick<MobileApi, 'aiLoginStatus'>;
  session: () => SessionApi;
  /** Reload on every session start and return to the foreground (the app's one instance does). */
  refreshOnForeground?: boolean;
}

export interface AiLoginStatusState {
  accounts: AiLoginStatusRow[];
  /** A first answer arrived (the modal waits for it to know the account). */
  loaded: boolean;
  loading: boolean;
  /** Never throws: a failure keeps the last answer (the banner is a hint, not a page of its own). */
  load(refresh?: boolean): Promise<void>;
  /** The account logged in again: its banner goes now, before the next load. */
  markOk(accountId: string): void;
}

export function createAiLoginStore(deps: AiLoginStatusDeps) {
  const { api, session } = deps;
  let generation = 0;

  const store = create<AiLoginStatusState>()((set) => ({
    accounts: [],
    loaded: false,
    loading: false,

    async load(refresh = false) {
      const gen = generation;
      let auth: Auth;
      try {
        auth = session().auth();
      } catch {
        return; // locked: the unlock's `sessionStarted` loads it
      }
      set({ loading: true });
      try {
        const res = await api.aiLoginStatus(auth, refresh);
        if (gen !== generation) return;
        set({ accounts: res.accounts, loaded: true, loading: false });
      } catch (e) {
        if (gen !== generation) return;
        set({ loading: false });
        session().handleApiError(e);
      }
    },

    markOk(accountId) {
      set((s) => ({ accounts: s.accounts.map((a) => (a.account_id === accountId ? { ...a, state: 'ok' } : a)) }));
    },
  }));

  if (deps.refreshOnForeground) {
    const refresh = () => void store.getState().load();
    appForegrounded.subscribe(refresh);
    sessionStarted.subscribe(refresh);
  }

  sessionEnded.subscribe(() => {
    generation++;
    store.setState({ accounts: [], loaded: false, loading: false });
  });

  return store;
}

export type AiLoginStatusStore = ReturnType<typeof createAiLoginStore>;
