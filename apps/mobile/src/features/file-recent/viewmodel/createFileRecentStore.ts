// The Arquivos screen's state (spec 2026-10-04 recent Markdown files D7): a project's recent Markdown files
// listed on its machines on demand, the chip that filters them, and the machines left out.
import { create } from 'zustand';
import { t } from '@/i18n';
import type { TFileRecentResponse } from '@/services/api/contract';
import type { Auth, MobileApi } from '@/services/api/types';
import type { FileRecentFilter } from '../model/format';

export interface FileRecentDeps {
  api: Pick<MobileApi, 'fileRecent'>;
  session(): { auth(): Auth; handleApiError(e: unknown): boolean };
  projectId: string;
}

export type FileRecentState =
  | { phase: 'loading' }
  | { phase: 'ok'; items: TFileRecentResponse['items']; skipped: TFileRecentResponse['skipped'] }
  | { phase: 'error'; text: string };

export interface FileRecentStore {
  state: FileRecentState;
  /** A pull-to-refresh keeps the list on screen while it reloads. */
  refreshing: boolean;
  filter: FileRecentFilter;
  setFilter(filter: FileRecentFilter): void;
  load(opts?: { refresh?: boolean }): Promise<void>;
}

const isLocked = (e: unknown) => e instanceof Error && e.message === 'LOCKED';

export function createFileRecentStore({ api, session, projectId }: FileRecentDeps) {
  let generation = 0;
  return create<FileRecentStore>()((set, get) => ({
    state: { phase: 'loading' },
    refreshing: false,
    filter: 'all',
    setFilter: (filter) => set({ filter }),
    async load(opts) {
      const gen = ++generation;
      const keep = opts?.refresh === true && get().state.phase === 'ok';
      set(keep ? { refreshing: true } : { state: { phase: 'loading' }, refreshing: false });
      try {
        const res = await api.fileRecent(session().auth(), projectId);
        if (gen !== generation) return;
        set({ state: { phase: 'ok', items: res.items, skipped: res.skipped }, refreshing: false });
      } catch (e) {
        if (gen !== generation) return;
        set({ refreshing: false });
        if (isLocked(e) || session().handleApiError(e)) return;
        set({ state: { phase: 'error', text: e instanceof Error && e.message ? e.message : t('Não foi possível listar os arquivos.') } });
      }
    },
  }));
}
