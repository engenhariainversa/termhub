// The project's repositories on the phone (spec 2026-10-07 multi-repo, TER-1061): the pure rules of the
// read-only "Repositórios" block of "Trabalho automático". Editing stays on the web Setup.
import { t, tk } from '@/i18n';
import type { TAutomationAutonomy, TProjectReposResponse } from '@/services/api/contract';
import { AUTONOMY_LABEL } from './automation';

/** Where the repository sits on one linked machine: its folder, or null when it is not there. */
export interface RepoPresence {
  machine: string;
  dir: string | null;
}

export interface RepoRow {
  /** the repository's key; `owner/repo` while discovery has not named it */
  label: string;
  full_name: string;
  /** the level, already in the reader's language */
  level: string;
  /** why automatic work leaves it out (off, outside GitHub, no access), in the reader's language; null = it runs */
  note: string | null;
  presence: RepoPresence[];
}

const STATUS_NOTE: Record<string, string> = {
  unsupported: tk('fora do GitHub'),
  no_access: tk('sem acesso'),
};

const levelLabel = (autonomy: string): string => (autonomy in AUTONOMY_LABEL ? t(AUTONOMY_LABEL[autonomy as TAutomationAutonomy]) : autonomy);

/** The block shows only for a project with more than one repository: a single-repo project sees the screen as before. */
export const showRepos = (view: TProjectReposResponse | null): view is TProjectReposResponse => view !== null && view.repos.length > 1;

/** One row per repository, in the server's order, with one presence entry per machine linked to the project. */
export function repoRows(view: TProjectReposResponse): RepoRow[] {
  return view.repos.map((r) => {
    // the project's linked machines, then any machine a checkout names that is no longer linked
    const machines = [...view.machines, ...r.machines.filter((c) => !view.machines.some((m) => m.machine_id === c.machine_id))];
    const presence = machines.map((m) => {
      const c = r.machines.find((x) => x.machine_id === m.machine_id);
      return { machine: m.machine, dir: c && !c.missing ? c.dir : null };
    });
    const status = STATUS_NOTE[r.status];
    const note = !r.enabled ? t('desligado') : status ? t(status) : null;
    return { label: r.key ?? r.full_name, full_name: r.full_name, level: levelLabel(r.autonomy), note, presence };
  });
}
