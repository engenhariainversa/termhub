// The Sessões list (spec 2026-10-01 tab chat §6): the terminal tabs of the person's projects, grouped by
// project in the order the server sent them. Same factory shape as the progress store.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import type { TTabSummary } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { MobileApi } from '@/services/api/types';
import { TAB_CHAT_MSG } from '../model/messages';
import type { SessionApi } from './createTabChatStore';

export interface SessionGroup {
  project: TTabSummary['project'];
  tabs: TTabSummary[];
}

export interface SessionsState {
  tabs: TTabSummary[];
  groups: SessionGroup[];
  /** A load is in flight. */
  loading: boolean;
  /** A pull-to-refresh is in flight. */
  refreshing: boolean;
  /** A list answered since this store started. */
  loaded: boolean;
  /** The list answered 403: the person has no terminal access. */
  forbidden: boolean;
  error: string | null;
  load(): Promise<void>;
  refresh(): Promise<void>;
}

/** The tabs by project, each project where its first tab is. */
export function groupByProject(tabs: TTabSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const tab of tabs) {
    const group = groups.get(tab.project.id);
    if (group) group.tabs.push(tab);
    else groups.set(tab.project.id, { project: tab.project, tabs: [tab] });
  }
  return [...groups.values()];
}

export function createSessionsStore(deps: { api: MobileApi; session: () => SessionApi }) {
  // Only the latest request may write its answer; bumped on sessionEnded too.
  let generation = 0;
  const store = create<SessionsState>()((set, get) => ({
    tabs: [],
    groups: [],
    loading: false,
    refreshing: false,
    loaded: false,
    forbidden: false,
    error: null,
    async load() {
      const mine = ++generation;
      set({ loading: true });
      try {
        const { tabs } = await deps.api.tabs(deps.session().auth());
        if (mine !== generation) return;
        set({ tabs, groups: groupByProject(tabs), loading: false, loaded: true, forbidden: false, error: null });
      } catch (err) {
        if (mine !== generation) return;
        set({ loading: false });
        if (deps.session().handleApiError(err)) return;
        if (err instanceof ApiError && err.status === 403) set({ forbidden: true, loaded: true, error: null, tabs: [], groups: [] });
        else set({ error: TAB_CHAT_MSG.listFailed });
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
  }));

  sessionEnded.subscribe(() => {
    generation++;
    store.setState({ tabs: [], groups: [], loading: false, refreshing: false, loaded: false, forbidden: false, error: null });
  });

  return store;
}
