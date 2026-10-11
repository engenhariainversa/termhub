// One file preview screen's state (spec 2026-10-04 file preview D15): the file read on its machine on
// demand, or why it could not be. Nothing of the file is kept once the screen goes.
import { create } from 'zustand';
import { t } from '@/i18n';
import type { TFilePreviewOk, TFilePreviewQuery } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';
import { refusalText } from '../model/refusals';

export interface FilePreviewDeps {
  api: Pick<MobileApi, 'filePreview'>;
  session(): { auth(): Auth; handleApiError(e: unknown): boolean };
  query: TFilePreviewQuery;
}

export type FilePreviewState =
  | { phase: 'loading' }
  | { phase: 'ok'; file: TFilePreviewOk }
  /** `outdated`: the machine's agent cannot read files yet (409 AGENT_OUTDATED). */
  | { phase: 'refused'; text: string; machine: string | null; outdated: boolean };

const isLocked = (e: unknown) => e instanceof Error && e.message === 'LOCKED';

export function createFilePreviewStore({ api, session, query }: FilePreviewDeps) {
  let generation = 0;
  return create<{ state: FilePreviewState; load(): Promise<void> }>()((set) => ({
    state: { phase: 'loading' },
    async load() {
      const gen = ++generation;
      set({ state: { phase: 'loading' } });
      try {
        const res = await api.filePreview(session().auth(), query);
        if (gen !== generation) return;
        if (res.status === 'ok' && 'content' in res) set({ state: { phase: 'ok', file: res as TFilePreviewOk } });
        else set({ state: { phase: 'refused', text: refusalText(res.status), machine: res.machine?.name ?? null, outdated: false } });
      } catch (e) {
        if (gen !== generation || isLocked(e)) return;
        if (session().handleApiError(e)) return;
        const outdated = e instanceof ApiError && e.code === 'AGENT_OUTDATED';
        set({ state: { phase: 'refused', text: e instanceof Error && e.message ? e.message : t('Não foi possível abrir o arquivo.'), machine: null, outdated } });
      }
    },
  }));
}
