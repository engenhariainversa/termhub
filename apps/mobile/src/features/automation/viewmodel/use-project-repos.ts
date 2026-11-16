// TER-1061 (spec 2026-10-07 multi-repo): loads the project's repositories for the read-only block of
// "Trabalho automático". A failed load (an older server answers 404, the network fails) leaves it null: the
// block is extra information, so it hides instead of showing an error over the screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TProjectReposResponse } from '@/services/api/contract';
import type { Auth, MobileApi } from '@/services/api/types';

export interface ProjectReposDeps {
  api: Pick<MobileApi, 'getProjectRepos'>;
  session: () => { auth(): Auth; handleApiError(err: unknown): boolean };
}

export function useProjectRepos(projectId: string, deps: ProjectReposDeps): { repos: TProjectReposResponse | null; load(): Promise<void> } {
  const { api, session } = deps;
  const [repos, setRepos] = useState<TProjectReposResponse | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [projectId]);

  const load = useCallback(async () => {
    try {
      const res = await api.getProjectRepos(session().auth(), projectId);
      if (alive.current) setRepos(res);
    } catch (e) {
      if (!alive.current) return;
      // a relocked session is handled (and said) by the session itself
      session().handleApiError(e);
      setRepos(null);
    }
  }, [api, session, projectId]);

  return { repos, load };
}
