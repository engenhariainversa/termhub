// The pause switch's store ("Pausar tudo", TER-942): read from `GET automation/state`, re-read every few
// seconds while a screen that shows it is focused (the global pause is not pushed on the socket) and after
// each action. Pausing never asks for the PIN; the view confirms before resuming.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import type { TPauseState } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';
import { PAUSE_MSG } from '../model/pause';

export const PAUSE_POLL_MS = 4_000;

export interface PauseSessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface PauseStoreState {
  /** null until the first read. */
  state: TPauseState | null;
  busy: boolean;
  error: string | null;
  load(): Promise<void>;
  /** Pauses everything; `interrupt` also asks to stop the tabs running now. */
  pauseAll(interrupt?: boolean): Promise<void>;
  resumeAll(): Promise<void>;
  startPolling(): void;
  stopPolling(): void;
}

export function createPauseStore(deps: { api: MobileApi; session: () => PauseSessionApi }) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let generation = 0;
  const store = create<PauseStoreState>()((set, get) => {
    const act = async (run: (auth: Auth) => Promise<unknown>) => {
      set({ busy: true, error: null });
      try {
        await run(deps.session().auth());
        await get().load();
      } catch (err) {
        if (!deps.session().handleApiError(err)) set({ error: err instanceof ApiError ? err.message : PAUSE_MSG.failed });
      } finally {
        set({ busy: false });
      }
    };
    return {
      state: null,
      busy: false,
      error: null,
      async load() {
        const mine = ++generation;
        try {
          const state = await deps.api.getPauseState(deps.session().auth());
          if (mine === generation) set({ state });
        } catch (err) {
          // A failed poll keeps the last state on screen; only a locked session stops it.
          if (deps.session().handleApiError(err)) get().stopPolling();
        }
      },
      pauseAll: (interrupt = false) => act((a) => deps.api.pauseAutomation(a, 'all', interrupt)),
      resumeAll: () => act((a) => deps.api.resumeAutomation(a, 'all')),
      startPolling() {
        get().stopPolling();
        void get().load();
        timer = setInterval(() => void get().load(), PAUSE_POLL_MS);
      },
      stopPolling() {
        if (timer) clearInterval(timer);
        timer = null;
      },
    };
  });
  // The end of a session resets the store: the next account never sees the previous one's pause.
  sessionEnded.subscribe(() => {
    generation++;
    store.getState().stopPolling();
    store.setState({ state: null, busy: false, error: null });
  });
  return store;
}
