// "Memória do chat" (chat decision memory spec 2026-09-26 §5.2): the mobile twin of the web's
// `ChatMemoryPage` — the suggestion switch and the searchable, paginated list of remembered
// decisions. A factory over injected services, same shape as the other feature stores, so tests
// drive it against the mock transport; `useChatMemoryStore.ts` builds the app's one instance.
//
// Search and "Carregar mais" share one request-generation counter (`gen`, module-private to this
// factory): every fresh first page — the initial `load()` and every debounced `search()` — bumps
// it, and a page (first or "more") that resolves after a newer one started is dropped, so a slow,
// superseded search can never overwrite what a faster, later one already showed. This mirrors
// `ChatMemoryPage`'s `genRef`.
//
// `toggle()`/`forget()` deliberately do NOT share that counter: sharing it would let an unrelated
// search finishing first make the switch fall back to its pre-toggle value, or bring back a row
// just forgotten. They apply their own result unconditionally instead — this mirrors
// `ChatMemoryPage`'s `mountedRef` being kept apart from `genRef`. A first page, in turn, counts
// completed toggles (`toggles`) when it starts and drops its `memory` if one completed meanwhile:
// that read may predate the PATCH and would flip the switch back (its list still applies) — the
// same rule as `ChatMemoryPage`'s `togglesRef`.
//
// Unlike a component, this store is never itself "unmounted" — it is a singleton that outlives the
// screen — but the *screen* still needs a way to say "I am gone, drop whatever you were about to
// show me": `cancel()` clears a still-pending debounce timer and bumps `gen`, so neither a search
// typed right before leaving nor one already in flight can land later and clobber the next visit's
// fresh `load()`. The screen calls it from its unmount cleanup; `toggle()`/`forget()` are untouched
// by it on purpose (see above) — the store is still alive to receive their result, and the next
// visit re-reads everything from scratch anyway.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import { t } from '@/i18n';
import type { TChatDecision, TChatMemory, TConciergeNote, TLessonItem, TMemoryReplacement, TMemoryStatus } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';

/** What this store needs from the session store: `auth()` for every call, `handleApiError` for a
 * session-ending answer — the same small contract the notifications store's `SessionApi` uses. */
export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface ChatMemoryDeps {
  api: MobileApi;
  session: () => SessionApi;
  /** The delay before `search` re-queries; defaults to 300ms (design spec §5.2, same as the web).
   * Overridable so a test does not need to drive real timers. */
  debounceMs?: number;
}

export interface ChatMemoryState {
  memory: TChatMemory | null;
  decisions: TChatDecision[] | null;
  cursor: string | null;
  q: string;
  loadingMore: boolean;
  switching: boolean;
  /** The decision whose "Esquecer" is in flight. */
  forgettingId: string | null;
  error: string | null;

  /** "Anotações do concierge" (spec D12/§8): its own list, independent of the search box above
   * (which only ever filters decisions) — read by its own `loadNotes()`, not `load()`, same as the
   * web page's own effect for `api.chatNotes()`. */
  notes: TConciergeNote[] | null;
  notesCursor: string | null;
  loadingMoreNotes: boolean;
  /** The note whose "Esquecer" is in flight. */
  forgettingNoteId: string | null;
  notesError: string | null;

  /** The first read: both the switch/count and the (possibly already filtered, by `q`) list, at
   * once — call once when the screen mounts. */
  load(): Promise<void>;
  /** Updates the search text right away and re-queries after the debounce (`ChatMemoryPage`'s own
   * delay); the store's own `load()` is the only read that ever runs without waiting for it. */
  search(q: string): void;
  /** The next page, appended; a no-op with no `cursor` or while one is already loading. */
  loadMore(): Promise<void>;
  /** Flips the suggestion switch. */
  toggle(): Promise<void>;
  /** "Responder sozinho quando houver precedente" (spec D8): flips at once (optimistic — no PATCH to
   * wait on before the switch itself moves), then keeps the server's confirmed value; a failure rolls
   * the switch back and shows "Não foi possível alterar a configuração". Ignored while another call
   * to it is in flight (the memory it would roll back to would be the wrong one). */
  setAutodecide(next: boolean): Promise<void>;
  /** "Responder perguntas do Codex pelo chat": the same optimistic flip and rollback as `setAutodecide`, its own in-flight guard. */
  setCodexReplies(next: boolean): Promise<void>;
  /** "Esquecer": the same hard delete as a card's "Esquecer esta decisão". */
  forget(id: string): Promise<void>;
  /** "Anotações do concierge": the first page — call once when the screen mounts, alongside `load()`. */
  loadNotes(): Promise<void>;
  /** The next page of notes, appended; a no-op with no cursor or while one is already loading. */
  loadMoreNotes(): Promise<void>;
  /** "Esquecer" on a note: the same hard delete as a decision's, its own busy id and error line. */
  forgetNote(id: string): Promise<void>;

  /** The ref (`decision:<id>` / `note:<id>`) whose status change (TER-1013) is in flight. */
  statusBusyRef: string | null;
  /** "Desatualizada" / "Errada" / "Substituída por…" on a decision or note, `current` for "Desfazer"
   * (TER-1013): the row is replaced by the server's answer; a failure goes to the list's own error
   * line (`error` for decisions, `notesError` for notes). Resolves whether it worked. */
  setStatus(kind: 'decision' | 'note', id: string, status: TMemoryStatus, supersededBy?: string): Promise<boolean>;
  /** "Substituída por…"'s picker: the user's other current decisions and notes matching `q`. Not
   * kept in the store — the picker owns its results; a failure resolves `null`. */
  searchReplacements(q: string, exclude: string): Promise<TMemoryReplacement[] | null>;

  /** "Lições" (spec 2026-09-27 failure lessons §6/§8): its own search box and pagination,
   * independent of both `decisions` and `notes` above — the mobile twin of `ChatMemoryPage`'s own
   * `lessons`/`lessonsCursor`/`lessonsQ`. */
  lessons: TLessonItem[] | null;
  lessonsCursor: string | null;
  lessonsQ: string;
  loadingMoreLessons: boolean;
  /** The lesson whose "Verificar"/"Desfazer verificação" is in flight. */
  verifyingLessonId: string | null;
  /** The lesson whose "Esquecer" is in flight. */
  forgettingLessonId: string | null;
  lessonsError: string | null;
  /** The server's `note` from the last successful "Esquecer" (present only for a file-origin
   * lesson); cleared at the start of every new `forgetLesson`. */
  lessonsNote: string | null;

  /** The first page — call once when the screen mounts, alongside `load()`/`loadNotes()`. */
  loadLessons(): Promise<void>;
  /** Updates `lessonsQ` at once and re-queries after the debounce, same as `search()`. */
  searchLessons(q: string): void;
  /** The next page, appended; a no-op with no `lessonsCursor` or while one is already loading. */
  loadMoreLessons(): Promise<void>;
  /** "Verificar" / "Desfazer verificação": one call, the direction picked by `verified` (the row's
   * own current state, mirroring `ChatMemoryPage`'s `toggleLessonVerified`) — `true` unverifies,
   * `false` verifies. 404 (silently, like every other memory-item id here) is not expected — the
   * row shown is always this user's own. */
  toggleLessonVerified(id: string, verified: boolean): Promise<void>;
  /** "Esquecer": the same hard delete as a decision's/note's, plus the server's `note` (if any) in
   * `lessonsNote` for the screen to show. */
  forgetLesson(id: string): Promise<void>;

  /** Cancels a pending debounce timer and drops any first-page/"more" response still in flight,
   * without touching what is currently shown. Call this from the screen's unmount — see the note
   * above `toggle()`/`forget()` for why they are not affected. */
  cancel(): void;
}

type Data = Omit<ChatMemoryState, { [K in keyof ChatMemoryState]: ChatMemoryState[K] extends (...args: never[]) => unknown ? K : never }[keyof ChatMemoryState]>;

const initialData = (): Data => ({
  memory: null,
  decisions: null,
  cursor: null,
  q: '',
  loadingMore: false,
  switching: false,
  forgettingId: null,
  error: null,
  notes: null,
  notesCursor: null,
  loadingMoreNotes: false,
  forgettingNoteId: null,
  notesError: null,
  statusBusyRef: null,
  lessons: null,
  lessonsCursor: null,
  lessonsQ: '',
  loadingMoreLessons: false,
  verifyingLessonId: null,
  forgettingLessonId: null,
  lessonsError: null,
  lessonsNote: null,
});

const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export function createChatMemoryStore(deps: ChatMemoryDeps) {
  const { api, session } = deps;
  const debounceMs = deps.debounceMs ?? 300;

  let gen = 0;
  let toggles = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** `setAutodecide`'s own in-flight guard: a second call while the first's PATCH is still out would
   * capture a `previous` memory to roll back to that is itself unconfirmed. Not reactive state — the
   * switch already shows the optimistic value the instant the first call sets it. */
  let settingAutodecide = false;
  let settingCodexReplies = false;
  /** "Lições"'s own request-generation counter and debounce timer — kept apart from `gen`/`timer`
   * above (decisions' own), same reasoning as `ChatMemoryPage`'s `lessonsGenRef` next to `genRef`:
   * a slow, superseded lessons search must never clobber a newer one, and neither list's search
   * should ever cancel or supersede the other's. */
  let lessonsGen = 0;
  let lessonsTimer: ReturnType<typeof setTimeout> | null = null;

  /** Clears a pending debounce timer and bumps `gen`, so a first-page/"more" response already in
   * flight is dropped by its own `gen !== myGen` check once it resolves. Shared by `cancel()` and
   * the `sessionEnded` reset below. */
  const cancelPending = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    gen++;
  };

  /** Same as `cancelPending`, for "Lições"'s own `lessonsGen`/`lessonsTimer`. */
  const cancelLessonsPending = (): void => {
    if (lessonsTimer) {
      clearTimeout(lessonsTimer);
      lessonsTimer = null;
    }
    lessonsGen++;
  };

  const store = create<ChatMemoryState>()((set, get) => {
    const runFirstPage = async (query: string): Promise<void> => {
      const myGen = ++gen;
      const myToggles = toggles;
      set({ error: null });
      try {
        const [memory, page] = await Promise.all([api.chatMemory(session().auth()), api.chatDecisions(session().auth(), query || undefined)]);
        if (gen !== myGen) return; // superseded by a newer search
        // A toggle that completed meanwhile holds the newer switch value; keep it.
        set(toggles === myToggles ? { memory, decisions: page.decisions, cursor: page.next_cursor } : { decisions: page.decisions, cursor: page.next_cursor });
      } catch (e) {
        if (gen !== myGen) return;
        if (session().handleApiError(e)) return;
        set({ error: isApiError(e) ? e.message : t('Não foi possível carregar a memória do chat') });
      }
    };

    /** "Lições"'s own first-page read, `lessonsGen`-guarded exactly like `runFirstPage` above but
     * against its own counter — a slow, superseded lessons search must never clobber a newer one,
     * and neither list's search can ever supersede the other's. */
    const runLessonsFirstPage = async (query: string): Promise<void> => {
      const myGen = ++lessonsGen;
      set({ lessonsError: null });
      try {
        const page = await api.chatLessons(session().auth(), query || undefined);
        if (lessonsGen !== myGen) return; // superseded by a newer search
        set({ lessons: page.lessons, lessonsCursor: page.next_cursor });
      } catch (e) {
        if (lessonsGen !== myGen) return;
        if (session().handleApiError(e)) return;
        set({ lessonsError: isApiError(e) ? e.message : t('Não foi possível carregar as lições') });
      }
    };

    return {
      ...initialData(),

      load() {
        return runFirstPage(get().q);
      },

      search(q) {
        set({ q });
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void runFirstPage(q);
        }, debounceMs);
      },

      async loadMore() {
        const cursor = get().cursor;
        if (!cursor || get().loadingMore) return;
        const myGen = gen; // not bumped: "more" of the search that is current when it starts
        set({ loadingMore: true, error: null });
        try {
          const page = await api.chatDecisions(session().auth(), get().q || undefined, cursor);
          if (gen !== myGen) return; // a newer search started (or finished) meanwhile
          set((s) => ({ decisions: [...(s.decisions ?? []), ...page.decisions], cursor: page.next_cursor, loadingMore: false }));
        } catch (e) {
          if (gen !== myGen) return;
          set({ loadingMore: false });
          if (session().handleApiError(e)) return;
          set({ error: isApiError(e) ? e.message : t('Não foi possível carregar mais decisões') });
        }
      },

      async toggle() {
        const memory = get().memory;
        if (!memory || get().switching) return;
        set({ switching: true, error: null });
        try {
          const next = await api.setChatMemory(session().auth(), !memory.enabled);
          toggles++;
          set({ memory: next, switching: false });
        } catch (e) {
          set({ switching: false });
          if (session().handleApiError(e)) return;
          set({ error: isApiError(e) ? e.message : t('Não foi possível alterar a sugestão de respostas') });
        }
      },

      async setAutodecide(next) {
        const previous = get().memory;
        if (!previous || settingAutodecide) return;
        settingAutodecide = true;
        set({ memory: { ...previous, autodecide: next }, error: null }); // optimistic
        try {
          const updated = await api.setChatMemory(session().auth(), { autodecide: next });
          toggles++;
          set({ memory: updated });
        } catch (e) {
          set({ memory: previous }); // rollback
          if (!session().handleApiError(e)) set({ error: isApiError(e) ? e.message : t('Não foi possível alterar a configuração') });
        } finally {
          settingAutodecide = false;
        }
      },

      async setCodexReplies(next) {
        const previous = get().memory;
        if (!previous || settingCodexReplies) return;
        settingCodexReplies = true;
        set({ memory: { ...previous, codex_replies: next }, error: null }); // optimistic
        try {
          const updated = await api.setChatMemory(session().auth(), { codex_replies: next });
          toggles++;
          set({ memory: updated });
        } catch (e) {
          set({ memory: previous }); // rollback
          if (!session().handleApiError(e)) set({ error: isApiError(e) ? e.message : t('Não foi possível alterar a configuração') });
        } finally {
          settingCodexReplies = false;
        }
      },

      async forget(id) {
        if (get().forgettingId !== null) return;
        set({ forgettingId: id, error: null });
        try {
          await api.forgetChatDecision(session().auth(), id);
          set((s) => ({ decisions: (s.decisions ?? []).filter((d) => d.id !== id), forgettingId: null }));
        } catch (e) {
          set({ forgettingId: null });
          if (session().handleApiError(e)) return;
          set({ error: isApiError(e) ? e.message : t('Não foi possível esquecer a decisão') });
        }
      },

      async loadNotes() {
        set({ notesError: null });
        try {
          const page = await api.chatNotes(session().auth());
          set({ notes: page.notes, notesCursor: page.next_cursor });
        } catch (e) {
          if (session().handleApiError(e)) return;
          set({ notesError: isApiError(e) ? e.message : t('Não foi possível carregar as anotações do concierge') });
        }
      },

      async loadMoreNotes() {
        const cursor = get().notesCursor;
        if (!cursor || get().loadingMoreNotes) return;
        set({ loadingMoreNotes: true, notesError: null });
        try {
          const page = await api.chatNotes(session().auth(), cursor);
          set((s) => ({ notes: [...(s.notes ?? []), ...page.notes], notesCursor: page.next_cursor, loadingMoreNotes: false }));
        } catch (e) {
          set({ loadingMoreNotes: false });
          if (session().handleApiError(e)) return;
          set({ notesError: isApiError(e) ? e.message : t('Não foi possível carregar mais anotações') });
        }
      },

      async forgetNote(id) {
        if (get().forgettingNoteId !== null) return;
        set({ forgettingNoteId: id, notesError: null });
        try {
          await api.forgetChatNote(session().auth(), id);
          set((s) => ({ notes: (s.notes ?? []).filter((n) => n.id !== id), forgettingNoteId: null }));
        } catch (e) {
          set({ forgettingNoteId: null });
          if (session().handleApiError(e)) return;
          set({ notesError: isApiError(e) ? e.message : t('Não foi possível esquecer a anotação') });
        }
      },

      async setStatus(kind, id, status, supersededBy) {
        const ref = `${kind}:${id}`;
        if (get().statusBusyRef !== null) return false;
        const showError = (message: string | null) => set(kind === 'decision' ? { error: message } : { notesError: message });
        set({ statusBusyRef: ref });
        showError(null);
        try {
          if (kind === 'decision') {
            const updated = await api.setChatDecisionStatus(session().auth(), id, status, supersededBy);
            set((s) => ({ decisions: (s.decisions ?? []).map((d) => (d.id === updated.id ? updated : d)), statusBusyRef: null }));
          } else {
            const updated = await api.setChatNoteStatus(session().auth(), id, status, supersededBy);
            set((s) => ({ notes: (s.notes ?? []).map((n) => (n.id === updated.id ? updated : n)), statusBusyRef: null }));
          }
          return true;
        } catch (e) {
          set({ statusBusyRef: null });
          if (session().handleApiError(e)) return false;
          showError(isApiError(e) ? e.message : t('Não foi possível alterar o estado do item'));
          return false;
        }
      },

      async searchReplacements(q, exclude) {
        try {
          return (await api.chatMemoryReplacements(session().auth(), q.trim(), exclude)).items;
        } catch (e) {
          if (!session().handleApiError(e)) set({ error: isApiError(e) ? e.message : t('Não foi possível buscar os itens da memória') });
          return null;
        }
      },

      loadLessons() {
        return runLessonsFirstPage(get().lessonsQ);
      },

      searchLessons(q) {
        set({ lessonsQ: q });
        if (lessonsTimer) clearTimeout(lessonsTimer);
        lessonsTimer = setTimeout(() => {
          lessonsTimer = null;
          void runLessonsFirstPage(q);
        }, debounceMs);
      },

      async loadMoreLessons() {
        const cursor = get().lessonsCursor;
        if (!cursor || get().loadingMoreLessons) return;
        const myGen = lessonsGen; // not bumped: "more" of the search that is current when it starts
        set({ loadingMoreLessons: true, lessonsError: null });
        try {
          const page = await api.chatLessons(session().auth(), get().lessonsQ || undefined, cursor);
          if (lessonsGen !== myGen) return; // a newer search started (or finished) meanwhile
          set((s) => ({ lessons: [...(s.lessons ?? []), ...page.lessons], lessonsCursor: page.next_cursor, loadingMoreLessons: false }));
        } catch (e) {
          if (lessonsGen !== myGen) return;
          set({ loadingMoreLessons: false });
          if (session().handleApiError(e)) return;
          set({ lessonsError: isApiError(e) ? e.message : t('Não foi possível carregar mais lições') });
        }
      },

      async toggleLessonVerified(id, verified) {
        if (get().verifyingLessonId !== null) return;
        set({ verifyingLessonId: id, lessonsError: null });
        try {
          const updated = verified ? await api.unverifyChatLesson(session().auth(), id) : await api.verifyChatLesson(session().auth(), id);
          set((s) => ({ lessons: (s.lessons ?? []).map((l) => (l.id === updated.id ? updated : l)), verifyingLessonId: null }));
        } catch (e) {
          set({ verifyingLessonId: null });
          if (session().handleApiError(e)) return;
          set({ lessonsError: isApiError(e) ? e.message : t('Não foi possível verificar a lição') });
        }
      },

      async forgetLesson(id) {
        if (get().forgettingLessonId !== null) return;
        set({ forgettingLessonId: id, lessonsError: null, lessonsNote: null });
        try {
          const r = await api.forgetChatLesson(session().auth(), id);
          set((s) => ({ lessons: (s.lessons ?? []).filter((l) => l.id !== id), forgettingLessonId: null, lessonsNote: r.note ?? null }));
        } catch (e) {
          set({ forgettingLessonId: null });
          if (session().handleApiError(e)) return;
          set({ lessonsError: isApiError(e) ? e.message : t('Não foi possível esquecer a lição') });
        }
      },

      cancel() {
        cancelPending();
        cancelLessonsPending();
      },
    };
  });

  // Design spec §5.5: the end of a session resets every store that holds per-session data, so the
  // next enrolled device never sees the previous session's decisions.
  sessionEnded.subscribe(() => {
    cancelPending();
    cancelLessonsPending();
    store.setState(initialData());
  });

  return store;
}
