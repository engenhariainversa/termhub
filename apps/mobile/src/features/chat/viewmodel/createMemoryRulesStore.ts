// "Regras vigentes" (TER-1010, spec 2026-10-07 current rules) in "Memória do chat": the approved
// rules and the proposals waiting for the person — the mobile twin of the web's rules section. Its
// own small store, apart from `createChatMemoryStore`, so the section stays a self-contained piece of
// the screen; `useMemoryRulesStore.ts` builds the app's one instance.
//
// Every decision ("Aprovar", "Recusar", "Remover") re-reads the whole list afterwards rather than
// patching it locally: the server consolidates on that read, so an approval can merge or retire
// other proposals, and a removal makes its sources current again.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import { t } from '@/i18n';
import type { TMemoryRule } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { MobileApi } from '@/services/api/types';
import type { SessionApi } from './createChatMemoryStore';

export interface MemoryRulesDeps {
  api: MobileApi;
  session: () => SessionApi;
}

export interface MemoryRulesState {
  /** The approved rules; `null` until the first read answers. */
  rules: TMemoryRule[] | null;
  /** The proposals (`proposed` or `awaiting_confirmation`); `null` until the first read answers. */
  proposals: TMemoryRule[] | null;
  /** The rule whose "Aprovar"/"Recusar"/"Remover" is in flight — one at a time. */
  busyId: string | null;
  error: string | null;
  /** A line to show after the last decision ("Recusada, ela não volta por 180 dias.", or, after
   * approving a policy, the reminder to confirm it in each project's chat); cleared at the start of
   * every new decision. */
  notice: string | null;

  /** The list — call once when the section mounts. */
  load(): Promise<void>;
  /** "Aprovar": a rule now; a policy asks its confirmation in each project's chat. */
  approve(id: string): Promise<void>;
  /** "Recusar": the same proposal stays away for 180 days. */
  reject(id: string): Promise<void>;
  /** "Remover": an approved rule only (the screen confirms first). */
  remove(id: string): Promise<void>;
}

type Data = Pick<MemoryRulesState, 'rules' | 'proposals' | 'busyId' | 'error' | 'notice'>;

const initialData = (): Data => ({ rules: null, proposals: null, busyId: null, error: null, notice: null });

const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export function createMemoryRulesStore(deps: MemoryRulesDeps) {
  const { api, session } = deps;

  const store = create<MemoryRulesState>()((set, get) => {
    const read = async (): Promise<void> => {
      try {
        const r = await api.chatRules(session().auth());
        set({ rules: r.rules, proposals: r.proposals });
      } catch (e) {
        if (session().handleApiError(e)) return;
        // Stop "Carregando…" (an empty list under the error line), keep whatever was already shown.
        set((s) => ({ rules: s.rules ?? [], proposals: s.proposals ?? [], error: isApiError(e) ? e.message : t('Não foi possível carregar as regras') }));
      }
    };

    /** One decision, then a fresh read. `notice` is shown only when the call succeeded. */
    const decide = async (id: string, call: () => Promise<unknown>, notice: string | null): Promise<void> => {
      if (get().busyId !== null) return;
      set({ busyId: id, error: null, notice: null });
      try {
        await call();
      } catch (e) {
        set({ busyId: null });
        if (session().handleApiError(e)) return;
        set({ error: isApiError(e) ? e.message : t('Não foi possível salvar a decisão') });
        await read(); // already decided elsewhere (409): show what is current
        return;
      }
      set({ notice });
      await read();
      set({ busyId: null });
    };

    return {
      ...initialData(),

      async load() {
        set({ error: null });
        await read();
      },

      approve(id) {
        const policy = get().proposals?.find((r) => r.id === id)?.kind === 'policy';
        return decide(id, () => api.approveChatRule(session().auth(), id), policy ? t('Confirme cada projeto no chat para a política mudar.') : null);
      },

      reject(id) {
        return decide(id, () => api.rejectChatRule(session().auth(), id), t('Recusada, ela não volta por 180 dias.'));
      },

      remove(id) {
        return decide(id, () => api.removeChatRule(session().auth(), id), null);
      },
    };
  });

  // Design spec §5.5: the end of a session resets every store that holds per-session data.
  sessionEnded.subscribe(() => store.setState(initialData()));

  return store;
}
