import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { useChatStream } from './chat';
import { publishConciergeNotice } from './concierge-notice';
import { dropAlive, touchAlive } from './chat-pool';
import { DEFAULT_CHAT_PREF, loadChatPrefs, prefOf, saveChatPrefs, withPref, type ChatPref, type ChatPrefs } from './project-chat-prefs';
import type { ChatEvent, ProjectChatStatus } from './types';

/**
 * The project chat dock's state (spec 2026-09-26 project chat dock §4.3): which project's window is on
 * screen, what each project remembers about its chat, which chats stay mounted, and each project's
 * live status for the dots.
 */
interface ProjectChatValue {
  /** The project whose window is on screen (ProjectPage, CardPage), or null on any other page. */
  currentProjectId: string | null;
  /** `currentProjectId` when its chat is open there, else null: the one the dock shows. */
  shownProjectId: string | null;
  setCurrentProject(id: string): void;
  /** Clears the current project only if it is still `id`, so a page's cleanup never clears the next page's. */
  releaseCurrentProject(id: string): void;
  pref(id: string): ChatPref;
  setOpen(id: string, open: boolean): void;
  toggle(id: string): void;
  setWidth(id: string, width: number): void;
  setMaximized(id: string, maximized: boolean): void;
  /** Panels kept mounted, most recent first. Only projects whose chat is open. */
  alive: string[];
  /** Whether that project's chat is answering, and how many questions wait on the user. */
  status(id: string): { busy: boolean; pending: number };
}

const IDLE = { busy: false, pending: 0 };
/** Without a provider (a component rendered on its own, in a test): no project on screen, every chat closed and idle. */
const ProjectChatContext = createContext<ProjectChatValue>({
  currentProjectId: null,
  shownProjectId: null,
  setCurrentProject: () => {},
  releaseCurrentProject: () => {},
  pref: () => DEFAULT_CHAT_PREF,
  setOpen: () => {},
  toggle: () => {},
  setWidth: () => {},
  setMaximized: () => {},
  alive: [],
  status: () => IDLE,
});

export function ProjectChatProvider({ children }: { children: ReactNode }) {
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ChatPrefs>(() => loadChatPrefs());
  const [alive, setAlive] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Map<string, ProjectChatStatus>>(new Map());
  const { can } = useAuth();

  useEffect(() => saveChatPrefs(prefs), [prefs]);

  // Gated on `chat` here, not just at `<ChatDock/>`: a stored pref is per browser, not per user (e.g.
  // an admin "ver como" a member without `chat`), so a pref left open by someone else must not hide
  // `main` (LayoutRow's `maximized`) or show a dock nobody here is allowed to see.
  const shownProjectId = can('chat') && currentProjectId !== null && prefOf(prefs, currentProjectId).open ? currentProjectId : null;
  useEffect(() => {
    if (shownProjectId !== null) setAlive((a) => touchAlive(a, shownProjectId));
  }, [shownProjectId]);

  const patch = useCallback((id: string, p: Partial<ChatPref>) => setPrefs((cur) => withPref(cur, id, p)), []);
  // Stable, so `useChatScope`'s effect runs only when the page's project changes.
  const releaseCurrentProject = useCallback((id: string) => setCurrentProjectId((cur) => (cur === id ? null : cur)), []);
  const setOpen = useCallback(
    (id: string, open: boolean) => {
      patch(id, { open });
      // Closing unmounts the panel; it stops nothing on the server (a run finishes and is there on reopening).
      if (!open) setAlive((a) => dropAlive(a, id));
    },
    [patch],
  );

  const value = useMemo<ProjectChatValue>(
    () => ({
      currentProjectId,
      shownProjectId,
      setCurrentProject: setCurrentProjectId,
      releaseCurrentProject,
      pref: (id) => prefOf(prefs, id),
      setOpen,
      toggle: (id) => setOpen(id, !prefOf(prefs, id).open),
      setWidth: (id, width) => patch(id, { width }),
      setMaximized: (id, maximized) => patch(id, { maximized }),
      alive: alive.filter((id) => prefOf(prefs, id).open),
      status: (id) => {
        const s = statuses.get(id);
        return s ? { busy: s.busy, pending: s.pending_confirmations } : IDLE;
      },
    }),
    [currentProjectId, shownProjectId, prefs, alive, statuses, setOpen, patch, releaseCurrentProject],
  );
  return (
    <ProjectChatContext.Provider value={value}>
      {/* Gated on both permissions the feed actually needs, not just `chat`: `/ws/chat`'s upgrade guard
          is terminals:read (ws/router.ts — the chat rides on the one gate written for terminal
          streams), and `/chat/projects` is gated on `chat`. A role with `chat` but not `terminals:read`
          would otherwise open a websocket the server rejects with 403 and `useChatStream` would retry
          it every 5s forever — this provider is mounted for every signed-in user in `Layout`, so that
          reconnect loop would run for the lifetime of the tab. The 💬 button itself only needs `chat`
          (Sidebar.tsx), but the status feed behind it needs both. */}
      {can('chat') && can('terminals', 'read') && <ProjectChatStatusFeed onStatuses={setStatuses} />}
      {children}
    </ProjectChatContext.Provider>
  );
}

const REREAD_ON: ReadonlySet<ChatEvent['type']> = new Set(['message', 'confirmation', 'decision', 'tab_question', 'tab_question_answered', 'tab_question_closed']);

/** The part of the provider that talks to the server: the initial `/chat/projects` read and the
 * `/ws/chat` subscription that keeps it current. Split out so the hooks it needs (the websocket
 * above all) mount only for a user who is allowed to use them — see the gate above. */
function ProjectChatStatusFeed({ onStatuses }: { onStatuses: (statuses: Map<string, ProjectChatStatus>) => void }) {
  const refresh = useCallback(async () => {
    try {
      const { projects } = await api.chatProjects();
      onStatuses(new Map(projects.map((p) => [p.project_id, p])));
    } catch {
      /* an indicator, never an error: the next event tries again */
    }
  }, [onStatuses]);
  useEffect(() => void refresh(), [refresh]);

  // A run starts and ends with a `message` event; something that waits on the person appears with
  // `confirmation` or `tab_question` and goes away with `decision`, `tab_question_answered` or
  // `tab_question_closed` (spec 2026-09-26 §4.9). Those are the only moments a dot can change, so they are
  // the only re-reads. A suggestion is not counted.
  const onEvent = useCallback((e: ChatEvent) => {
    if (REREAD_ON.has(e.type)) void refresh();
    // TER-1101: the concierge's notices ride the same socket; `ConciergeNotices` (Layout) shows them.
    if (e.type === 'concierge_notice') publishConciergeNotice(e);
  }, [refresh]);
  useChatStream(refresh, onEvent);

  return null;
}

export const useProjectChat = (): ProjectChatValue => useContext(ProjectChatContext);

/**
 * Says which project's window is on screen, for as long as the calling page is mounted with that id.
 * ProjectPage calls it, and so CardPage too, which renders ProjectPage.
 */
export function useChatScope(projectId: string | null): void {
  const { setCurrentProject, releaseCurrentProject } = useProjectChat();
  useEffect(() => {
    if (projectId === null) return;
    setCurrentProject(projectId);
    return () => releaseCurrentProject(projectId);
  }, [projectId, setCurrentProject, releaseCurrentProject]);
}
