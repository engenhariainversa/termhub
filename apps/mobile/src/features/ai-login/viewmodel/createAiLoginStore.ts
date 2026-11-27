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
  api: Pick<MobileApi, 'aiLoginStatus' | 'dismissAiLogin' | 'removeAiAccount'>;
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
  /**
   * TER-1212: hides the account's banner (saved on the server, so on every screen and device) until its
   * login is seen working again. The banner goes at once; a failure brings it back. Answers whether it held.
   */
  dismiss(accountId: string): Promise<boolean>;
  /** TER-1212: "Remover conta": removes the account's record. Answers whether it held. */
  remove(accountId: string): Promise<boolean>;
}

export function createAiLoginStore(deps: AiLoginStatusDeps) {
  const { api, session } = deps;
  let generation = 0;

  /** Applies `change` to the account (null: drops it), calls the server, and puts it back on failure. */
  const mutate = async (accountId: string, change: ((row: AiLoginStatusRow) => AiLoginStatusRow) | null, call: (auth: Auth) => Promise<void>): Promise<boolean> => {
    let auth: Auth;
    try {
      auth = session().auth();
    } catch {
      return false;
    }
    const before = store.getState().accounts;
    store.setState({ accounts: change ? before.map((a) => (a.account_id === accountId ? change(a) : a)) : before.filter((a) => a.account_id !== accountId) });
    try {
      await call(auth);
      return true;
    } catch (e) {
      store.setState({ accounts: before });
      session().handleApiError(e);
      return false;
    }
  };

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

    async dismiss(accountId) {
      return mutate(accountId, (a) => ({ ...a, dismissed: true }), (auth) => api.dismissAiLogin(auth, accountId));
    },

    async remove(accountId) {
      return mutate(accountId, null, (auth) => api.removeAiAccount(auth, accountId));
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
