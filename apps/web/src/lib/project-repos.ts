import { useEffect, useState } from 'react';
import { api } from './api';
import type { ProjectReposView } from './types';

/** One repository a card can name (TER-1069): its key and `owner/repo`. */
export interface SelectableRepo {
  key: string;
  full_name: string;
  description: string | null;
}

/** What the card form offers: the repositories, and whether the project has more than one (only then is there a choice). */
export interface CardRepos {
  multi: boolean;
  repos: SelectableRepo[];
}

export const NO_CARD_REPOS: CardRepos = { multi: false, repos: [] };

/**
 * The repositories a card of the project can name: the enabled ones with a key, as the server checks them
 * (`resolveRepoKeys`). `multi` follows the server's `isMultiRepo` (more than one enabled repository): a
 * single-repo project keeps every card at `[]`, so its form offers nothing.
 */
export function selectableRepos(view: Pick<ProjectReposView, 'repos'>): CardRepos {
  const enabled = view.repos.filter((r) => r.enabled);
  if (enabled.length <= 1) return NO_CARD_REPOS;
  return {
    multi: true,
    repos: enabled.filter((r): r is typeof r & { key: string } => r.key !== null).map((r) => ({ key: r.key, full_name: r.full_name, description: r.description })),
  };
}

/** The project's selectable repositories; none while loading or when the read fails (no access, older server). */
export function useCardRepos(projectId: string): CardRepos {
  const [state, setState] = useState<CardRepos>(NO_CARD_REPOS);
  useEffect(() => {
    let alive = true;
    setState(NO_CARD_REPOS);
    api.setup.repos(projectId).then(
      (view) => alive && setState(selectableRepos(view)),
      () => alive && setState(NO_CARD_REPOS),
    );
    return () => {
      alive = false;
    };
  }, [projectId]);
  return state;
}
