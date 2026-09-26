import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { useChatStream } from './chat';
import type { ChatEvent, ProjectChatStatus } from './types';

interface ProjectChatValue {
  /** The project whose chat the drawer shows, or null when it is closed. */
  openProjectId: string | null;
  /** The sidebar's 💬: opens that project's chat, swaps to it from another one, or closes it if open. */
  toggle(id: string): void;
  close(): void;
  /** Whether that project's chat is answering, and how many questions wait on the user. */
  status(id: string): { busy: boolean; pending: number };
}

const IDLE = { busy: false, pending: 0 };
/** Without a provider (a component rendered on its own, in a test) the chat is closed and idle. */
const ProjectChatContext = createContext<ProjectChatValue>({ openProjectId: null, toggle: () => {}, close: () => {}, status: () => IDLE });

export function ProjectChatProvider({ children }: { children: ReactNode }) {
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Map<string, ProjectChatStatus>>(new Map());
  const { can } = useAuth();

  const value = useMemo<ProjectChatValue>(
    () => ({
      openProjectId,
      toggle: (id) => setOpenProjectId((cur) => (cur === id ? null : id)),
      close: () => setOpenProjectId(null),
      status: (id) => {
        const s = statuses.get(id);
        return s ? { busy: s.busy, pending: s.pending_confirmations } : IDLE;
      },
    }),
    [openProjectId, statuses],
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
  }, [refresh]);
  useChatStream(refresh, onEvent);

  return null;
}

export const useProjectChat = (): ProjectChatValue => useContext(ProjectChatContext);
