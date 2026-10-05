// The Progresso tab's store (spec 2026-09-26 progress-panel D10): the active epics across the
// user's projects, polled while the tab is focused. Same factory shape as the notifications store.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import { t } from '@/i18n';
import type { TEpicProgress } from '@/services/api/contract';
import type { Auth, MobileApi } from '@/services/api/types';

export const PROGRESS_POLL_MS = 20_000;

export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface ProgressState {
  epics: TEpicProgress[];
  /** A load is in flight (first load, focus, background poll). */
  loading: boolean;
  /** A pull-to-refresh is in flight — only `refresh()` sets it, so the poll never shows the spinner. */
  refreshing: boolean;
  error: string | null;
  load(): Promise<void>;
  refresh(): Promise<void>;
  startPolling(): void;
  stopPolling(): void;
}

export function createProgressStore(deps: { api: MobileApi; session: () => SessionApi }) {
  let timer: ReturnType<typeof setInterval> | null = null;
  // Focus, poll and pull can overlap: only the latest request may write its answer. Bumped on
  // sessionEnded too, so an answer for the previous account never lands.
  let generation = 0;
  const store = create<ProgressState>()((set, get) => ({
    epics: [],
    loading: false,
    refreshing: false,
    error: null,
    async load() {
      const mine = ++generation;
      set({ loading: true });
      try {
        const res = await deps.api.progress(deps.session().auth(), 'active');
        if (mine !== generation) return;
        set({ epics: res.epics, loading: false, error: null });
      } catch (err) {
        if (deps.session().handleApiError(err)) {
          get().stopPolling();
          set({ loading: false });
          return;
        }
        if (mine !== generation) return;
        set({ loading: false, error: t('Não foi possível carregar o progresso.') });
      }
    },
    async refresh() {
      set({ refreshing: true });
      try {
        await get().load();
      } finally {
        set({ refreshing: false });
      }
    },
    startPolling() {
      get().stopPolling();
      void get().load();
      timer = setInterval(() => void get().load(), PROGRESS_POLL_MS);
    },
    stopPolling() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  }));

  // Design spec §5.5: the end of a session resets every store that persists per-session data.
  sessionEnded.subscribe(() => {
    generation++;
    store.getState().stopPolling();
    store.setState({ epics: [], error: null, loading: false, refreshing: false });
  });

  return store;
}
