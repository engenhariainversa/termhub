// The Sessões list (spec 2026-10-01 tab chat §6): the terminal tabs of the person's projects, grouped by
// project in the order the server sent them. Same factory shape as the progress store.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import { TAB_MESSAGE_MAX_CHARS, type TStartSessionBody, type TTabSummary } from '@/services/api/contract';
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
  /** "Iniciar" is in flight. */
  starting: boolean;
  /** Why the last start failed, in pt-BR (the server's own text for a refusal it explains). */
  startError: string | null;
  load(): Promise<void>;
  refresh(): Promise<void>;
  /** The machines a new session in `projectId` can run on (the ones the project's AI accounts live
   * on); empty when they cannot be read, and the server picks. */
  projectMachines(projectId: string): Promise<{ id: string; name: string }[]>;
  /** Starts a session; resolves the new tab's id, or null with `startError` set. */
  start(body: TStartSessionBody): Promise<string | null>;
  clearStartError(): void;
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
    starting: false,
    startError: null,
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
    async projectMachines(projectId) {
      try {
        const { available } = await deps.api.getProjectAi(deps.session().auth(), projectId);
        const machines = new Map<string, string>();
        for (const option of available) machines.set(option.machine_id, option.machine_name);
        return [...machines].map(([id, name]) => ({ id, name }));
      } catch (err) {
        deps.session().handleApiError(err);
        return [];
      }
    },
    async start(body) {
      if (get().starting) return null;
      if (body.prompt.trim().length > TAB_MESSAGE_MAX_CHARS) {
        set({ startError: TAB_CHAT_MSG.tooLong });
        return null;
      }
      const mine = generation;
      set({ starting: true, startError: null });
      try {
        const { tab_id } = await deps.api.startSession(deps.session().auth(), { ...body, prompt: body.prompt.trim() });
        if (mine === generation) set({ starting: false });
        return tab_id;
      } catch (err) {
        if (mine !== generation) return null;
        set({ starting: false });
        if (deps.session().handleApiError(err)) return null;
        set({ startError: err instanceof ApiError && err.status >= 400 && err.status < 500 ? err.message : TAB_CHAT_MSG.startFailed });
        return null;
      }
    },
    clearStartError() {
      set({ startError: null });
    },
  }));

  sessionEnded.subscribe(() => {
    generation++;
    store.setState({ tabs: [], groups: [], loading: false, refreshing: false, loaded: false, forbidden: false, error: null, starting: false, startError: null });
  });

  return store;
}
