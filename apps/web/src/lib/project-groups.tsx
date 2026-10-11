import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { i18n } from '../i18n';
import { api } from './api';
import { useAuth } from './auth';
import { useData } from './data';
import { moveGroup } from './project-groups-model';
import type { ProjectGroup } from './types';

interface ProjectGroupsState {
  groups: ProjectGroup[];
  /** last failed write, in the language on screen; cleared by the next successful one */
  error: string | null;
  reload(): Promise<void>;
  createGroup(name: string): Promise<ProjectGroup | null>;
  renameGroup(id: string, name: string): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  reorderGroups(groupId: string, toIndex: number): Promise<void>;
  setMemberships(next: ProjectGroup[], changes: { id: string; project_ids: string[] }[]): Promise<void>;
  isFavorite(projectId: string): boolean;
  toggleFavorite(projectId: string): Promise<void>;
}

const Ctx = createContext<ProjectGroupsState | null>(null);
/** Read when the write fails, so it is in the language on screen then. */
const failed = () => i18n.t('Não foi possível salvar os grupos. Tente de novo.');

/** The signed-in user's sidebar groups. Writes show at once and roll back when the server refuses them. */
export function ProjectGroupsProvider({ children }: { children: ReactNode }) {
  const { viewAs } = useAuth();
  const [groups, setGroupsState] = useState<ProjectGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(groups);
  const setGroups = (g: ProjectGroup[]) => {
    ref.current = g;
    setGroupsState(g);
  };

  const reload = useCallback(async () => {
    try {
      setGroups((await api.projectGroups.list()).groups);
    } catch {
      /* sidebar still works without groups: everything shows in Outros */
    }
  }, []);
  // members are filtered by the current scope, so a view-as switch changes them. Compared by value
  // (not by reference): useAuth() may hand back a freshly built object every render even when the
  // scope itself did not change, and a reference-based dependency would reload (and clobber any
  // optimistic write in flight) on every unrelated re-render.
  const viewAsKey = JSON.stringify(viewAs);
  useEffect(() => { void reload(); }, [reload, viewAsKey]);

  // A project that leaves the client's project list (deleted here) leaves every group too: the
  // server would refuse its id (404 PROJECT_NOT_FOUND) in the next write to those groups. Only ids
  // the list had and lost are pruned; a member the client never knew (created in another browser)
  // is kept. Other stale ids heal through the reload that follows a failed write.
  const { projects } = useData();
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(projects.map((p) => p.id));
    const gone = [...seen.current].filter((id) => !now.has(id));
    seen.current = now;
    if (!gone.length || !ref.current.some((g) => g.project_ids.some((id) => gone.includes(id)))) return;
    setGroups(ref.current.map((g) => (g.project_ids.some((id) => gone.includes(id)) ? { ...g, project_ids: g.project_ids.filter((id) => !gone.includes(id)) } : g)));
  }, [projects]);

  /**
   * Applies `next` now, runs the request, then reconciles. Writes can overlap (a drag while a rename
   * is still saving): this call only owns the outcome while its own `next` is still the current
   * state. If a later write has since applied its own state, this call must not stomp on it — on
   * success it leaves that newer state alone, and on failure it does not blindly restore its own
   * `prev` (which would discard the newer write); it reloads from the server instead, since that is
   * the only way to know what actually landed there.
   */
  const optimistic = useCallback(async (next: ProjectGroup[], send: () => Promise<ProjectGroup[] | null>) => {
    const prev = ref.current;
    setGroups(next);
    try {
      const fromServer = await send();
      if (ref.current === next && fromServer) setGroups(fromServer);
      setError(null);
    } catch {
      // the refusal may come from a change made elsewhere (a group created or deleted in another
      // browser): restore at once, then re-sync so the next write starts from what the server has
      if (ref.current === next) setGroups(prev);
      void reload();
      setError(failed());
    }
  }, [reload]);

  const value = useMemo<ProjectGroupsState>(() => {
    const favorites = () => ref.current.find((g) => g.kind === 'favorites');
    return {
      groups,
      error,
      reload,
      createGroup: async (name) => {
        try {
          const { group } = await api.projectGroups.create(name);
          setGroups([...ref.current, group]);
          setError(null);
          return group;
        } catch {
          setError(failed());
          return null;
        }
      },
      renameGroup: (id, name) =>
        optimistic(ref.current.map((g) => (g.id === id ? { ...g, name } : g)), async () => {
          const { group } = await api.projectGroups.rename(id, name);
          return ref.current.map((g) => (g.id === id ? group : g));
        }),
      deleteGroup: (id) =>
        optimistic(ref.current.filter((g) => g.id !== id), async () => {
          await api.projectGroups.remove(id);
          return null;
        }),
      reorderGroups: (groupId, toIndex) => {
        const next = moveGroup(ref.current, groupId, toIndex);
        return optimistic(next, async () => (await api.projectGroups.reorder(next.map((g) => g.id))).groups);
      },
      setMemberships: (next, changes) => optimistic(next, async () => (await api.projectGroups.setMemberships(changes)).groups),
      isFavorite: (projectId) => !!favorites()?.project_ids.includes(projectId),
      toggleFavorite: (projectId) => {
        const fav = favorites();
        if (!fav) {
          // Favoritos always exists on the server: it is only missing here when the list failed to load
          setError(failed());
          return reload();
        }
        const project_ids = fav.project_ids.includes(projectId) ? fav.project_ids.filter((id) => id !== projectId) : [...fav.project_ids, projectId];
        const next = ref.current.map((g) => (g.id === fav.id ? { ...g, project_ids } : g));
        return optimistic(next, async () => (await api.projectGroups.setMemberships([{ id: fav.id, project_ids }])).groups);
      },
    };
  }, [groups, error, reload, optimistic]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjectGroups(): ProjectGroupsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useProjectGroups fora do ProjectGroupsProvider');
  return ctx;
}
