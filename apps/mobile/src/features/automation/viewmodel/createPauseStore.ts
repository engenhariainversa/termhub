// The pause switch's store ("Pausar tudo", TER-942): read from `GET automation/state` when a screen that shows it
// is focused, on the `automation` frame of the app's socket and after each action, with a slow fallback poll
// only while the controls are visible. Pausing never asks for the PIN; the view confirms before resuming.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import type { TChatEvent, TPauseState } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';
import { PAUSE_MSG } from '../model/pause';

export const PAUSE_FALLBACK_MS = 60_000;

/** The switch has something to show and the person may use it: automatic work is on somewhere or a pause is active. */
export function pauseControlsVisible(s: TPauseState | null): boolean {
  return !!s && s.can_update && (s.has_automation || s.paused_at !== null || s.projects.length > 0);
}

export interface PauseSessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface PauseStoreState {
  /** null until the first read. */
  state: TPauseState | null;
  /** The server refused the read (no `projects:read`): the controls stay hidden. */
  unavailable: boolean;
  busy: boolean;
  error: string | null;
  load(): Promise<void>;
  /** Pauses everything; `interrupt` also asks to stop the tabs running now. */
  pauseAll(interrupt?: boolean): Promise<void>;
  resumeAll(): Promise<void>;
  startPolling(): void;
  stopPolling(): void;
}

export function createPauseStore(deps: { api: MobileApi; session: () => PauseSessionApi; events: { subscribe(fn: (e: TChatEvent) => void): () => void } }) {
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
      unavailable: false,
      busy: false,
      error: null,
      async load() {
        const mine = ++generation;
        try {
          const state = await deps.api.getPauseState(deps.session().auth());
          if (mine === generation) set({ state, unavailable: false });
        } catch (err) {
          // A failed poll keeps the last state on screen; only a locked session stops it.
          if (deps.session().handleApiError(err)) get().stopPolling();
          else if (err instanceof ApiError && err.status === 403 && mine === generation) set({ state: null, unavailable: true });
        }
      },
      pauseAll: (interrupt = false) => act((a) => deps.api.pauseAutomation(a, 'all', interrupt)),
      resumeAll: () => act((a) => deps.api.resumeAutomation(a, 'all')),
      startPolling() {
        get().stopPolling();
        void get().load();
        timer = setInterval(() => {
          if (pauseControlsVisible(get().state)) void get().load();
        }, PAUSE_FALLBACK_MS);
      },
      stopPolling() {
        if (timer) clearInterval(timer);
        timer = null;
      },
    };
  });
  // Any automation event of the person's projects (a pause or resume from another device included) re-reads the state.
  deps.events.subscribe((e) => {
    if (e.type === 'automation' && store.getState().state !== null) void store.getState().load();
  });

  // The end of a session resets the store: the next account never sees the previous one's pause.
  sessionEnded.subscribe(() => {
    generation++;
    store.getState().stopPolling();
    store.setState({ state: null, unavailable: false, busy: false, error: null });
  });
  return store;
}
