// "Permissões do chat" (spec 2026-09-26 §5, design spec 2026-09-26 §7): this user's chat grants —
// tab and project — active and a paged history. A factory over injected services like the other
// feature stores; `useChatGrantsStore.ts` builds the app's one instance. Revoking needs no PIN: it
// only takes power away. It also holds the screen's "Resposta automática" block (TER-642): the chat
// memory settings, read apart from the lists so neither read can hide the other.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import { t } from '@/i18n';
import type { TChatGrantListItem, TChatMemory } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';

export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface ChatGrantsDeps {
  api: MobileApi;
  session: () => SessionApi;
}

export interface ChatGrantsState {
  active: TChatGrantListItem[] | null;
  history: TChatGrantListItem[] | null;
  next: string | null;
  loading: boolean;
  loadingMore: boolean;
  revokingId: string | null;
  error: string | null;
  /** The chat memory settings, for the automatic answer's thresholds (TER-642); null until read. */
  memory: TChatMemory | null;
  savingThresholds: boolean;
  thresholdsError: string | null;
  load(): Promise<void>;
  loadMore(): Promise<void>;
  revoke(id: string): Promise<void>;
  /** Reads the thresholds in force. A failure leaves the block out: the screen is about the grants. */
  loadMemory(): Promise<void>;
  /** Pins the thresholds by hand, or with null hands them back to the automatic adjustment. True once saved. */
  setThresholds(thresholds: { high: number; low: number } | null): Promise<boolean>;
}

const networkMsg = () => t('Não foi possível falar com o servidor. Tente de novo.');

export function createChatGrantsStore(deps: ChatGrantsDeps) {
  const { api, session } = deps;
  let generation = 0;
  const empty = { active: null, history: null, next: null, loading: false, loadingMore: false, revokingId: null, error: null, memory: null, savingThresholds: false, thresholdsError: null };

  const store = create<ChatGrantsState>()((set, get) => {
    const fail = (gen: number, e: unknown) => {
      if (gen !== generation || session().handleApiError(e)) return;
      set({ loading: false, loadingMore: false, error: e instanceof ApiError ? e.message : networkMsg() });
    };
    return {
      ...empty,

      async load() {
        const gen = generation;
        set({ loading: true, error: null });
        try {
          const auth = session().auth();
          const [a, h] = await Promise.all([api.listGrants(auth, { state: 'active' }), api.listGrants(auth, { state: 'ended' })]);
          if (gen !== generation) return;
          set({ active: a.grants, history: h.grants, next: h.next_cursor, loading: false });
        } catch (e) {
          fail(gen, e);
        }
      },

      async loadMore() {
        const { next, loadingMore } = get();
        if (!next || loadingMore) return;
        const gen = generation;
        set({ loadingMore: true, error: null });
        try {
          const h = await api.listGrants(session().auth(), { state: 'ended', cursor: next });
          if (gen !== generation) return;
          set((s) => ({ history: [...(s.history ?? []), ...h.grants], next: h.next_cursor, loadingMore: false }));
        } catch (e) {
          fail(gen, e);
        }
      },

      async revoke(id) {
        if (get().revokingId !== null) return;
        const gen = generation;
        set({ revokingId: id, error: null });
        try {
          await api.revokeGrant(session().auth(), id);
        } catch (e) {
          // 409: already revoked elsewhere — the list is stale, not wrong.
          if (!(e instanceof ApiError) || e.status !== 409) {
            if (gen === generation) set({ revokingId: null });
            return fail(gen, e);
          }
        }
        if (gen !== generation) return;
        set({ revokingId: null });
        await get().load();
      },

      async loadMemory() {
        const gen = generation;
        try {
          const memory = await api.chatMemory(session().auth());
          // A save that is in flight holds the newer thresholds.
          if (gen === generation && !get().savingThresholds) set({ memory });
        } catch (e) {
          if (gen === generation) session().handleApiError(e);
        }
      },

      async setThresholds(thresholds) {
        if (get().savingThresholds) return false;
        const gen = generation;
        set({ savingThresholds: true, thresholdsError: null });
        try {
          const memory = await api.setChatMemory(session().auth(), { auto_thresholds: thresholds });
          if (gen !== generation) return false;
          set({ memory, savingThresholds: false });
          return true;
        } catch (e) {
          if (gen !== generation) return false;
          set({ savingThresholds: false });
          if (!session().handleApiError(e)) set({ thresholdsError: e instanceof ApiError ? e.message : networkMsg() });
          return false;
        }
      },
    };
  });

  sessionEnded.subscribe(() => {
    generation++;
    store.setState(empty);
  });

  return store;
}
