// The Sessões list (spec 2026-10-01 tab chat §6): the terminal tabs of the person's projects, grouped by
// project in the order the server sent them. Same factory shape as the progress store.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import { TAB_MESSAGE_MAX_CHARS, type TSessionStartMachine, type TStartSessionBody, type TTabSummary } from '@/services/api/contract';
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
  /**
   * The first message of a session started here, by tab id (TER-1107): the session screen shows it as
   * sent until the transcript brings it, the agent taking a few seconds to start. Memory only.
   */
  firstPrompts: Record<string, string>;
  load(): Promise<void>;
  refresh(): Promise<void>;
  /**
   * The machines a new session in `projectId` can start on (TER-1119): the project's machines, online or
   * not, with each one's accounts. A server older than TER-1119 has no such list: the machines of the
   * project's AI accounts stand in, all read as online, with no account named as picked (`suggested`),
   * and that server starts with the project's own rule whatever account is sent. Empty when neither
   * can be read.
   */
  startOptions(projectId: string): Promise<TSessionStartMachine[]>;
  /** Starts a session; resolves the new tab's id, or null with `startError` set. */
  start(body: TStartSessionBody): Promise<string | null>;
  clearStartError(): void;
  /** The transcript holds the first message now: the screen stops showing its own copy. */
  dropFirstPrompt(tabId: string): void;
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
    firstPrompts: {},
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
    async startOptions(projectId) {
      const auth = deps.session().auth();
      try {
        return (await deps.api.sessionStartOptions(auth, projectId)).machines;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) {
          deps.session().handleApiError(err);
          return [];
        }
      }
      try {
        const { available } = await deps.api.getProjectAi(auth, projectId);
        const machines = new Map<string, TSessionStartMachine>();
        for (const a of available) {
          const m = machines.get(a.machine_id) ?? { id: a.machine_id, name: a.machine_name, online: true, choices: [], suggested: null, provider: null };
          m.choices.push({ account_id: a.id, label: a.label, provider: a.provider, model: null });
          machines.set(a.machine_id, m);
        }
        return [...machines.values()];
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
        const prompt = body.prompt.trim();
        const { tab_id } = await deps.api.startSession(deps.session().auth(), { ...body, prompt });
        if (mine === generation) set((s) => ({ starting: false, firstPrompts: { ...s.firstPrompts, [tab_id]: prompt } }));
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
    dropFirstPrompt(tabId) {
      if (!(tabId in get().firstPrompts)) return;
      const { [tabId]: _dropped, ...rest } = get().firstPrompts;
      set({ firstPrompts: rest });
    },
  }));

  sessionEnded.subscribe(() => {
    generation++;
    store.setState({ tabs: [], groups: [], loading: false, refreshing: false, loaded: false, forbidden: false, error: null, starting: false, startError: null, firstPrompts: {} });
  });

  return store;
}
