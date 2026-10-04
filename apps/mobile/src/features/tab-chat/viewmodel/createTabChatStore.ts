// The session store (spec 2026-10-01 tab chat §6): one per open session screen, for one tab. The first
// page over REST, then the tab's socket from that page's `live` cursor; items are merged by id. A
// `reset` (a `/clear`, an account swap) empties the conversation and loads the new session's first page,
// holding the frames that arrive meanwhile. Nothing is persisted: no `persist` middleware, no storage.
//
// Every async action captures `generation` before its first `await` and drops its result once
// `close()` bumped it, so a late answer never lands in a closed screen's store.
import { create } from 'zustand';
import { CHAT_MSG } from '@/features/chat/model/messages';
import { upsertTabQuestion } from '@/features/chat/model/events';
import type { PickedFile } from '@/features/chat/viewmodel/attachments';
import { sessionEnded } from '@/features/shared/signals';
import {
  TAB_MESSAGE_MAX_CHARS,
  type TChatEvent,
  type TTabChatAction,
  type TTabChatFrame,
  type TTabChatItem,
  type TTabChatPage,
  type TTabFileResponse,
  type TTabQuestion,
  type TTabQuestionAnswerBody,
  type TTabSuggestion,
  type TTabSummary,
} from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';
import { TAB_CHAT_MSG } from '../model/messages';
import { mergeItems } from '../model/timeline';

export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface TabChatDeps {
  api: MobileApi;
  session: () => SessionApi;
  tabId: string;
}

export interface TabChatState {
  status: 'loading' | 'ready' | 'error';
  tab: TTabSummary | null;
  /** A `tabChatAvailability` value, read as a plain string (a newer server may add one). */
  availability: string;
  sessionId: string | null;
  items: TTabChatItem[];
  /** The cursor of the page before the oldest item shown; null at the start of the session. */
  before: string | null;
  /** The cursor the socket follows from; null while there is no transcript to follow. */
  live: string | null;
  mode: string | null;
  degraded: boolean;
  questions: TTabQuestion[];
  suggestions: TTabSuggestion[];
  sending: boolean;
  loadingEarlier: boolean;
  /** The last failure of the screen, in pt-BR. */
  error: string | null;
  answeringQuestionIds: string[];
  questionErrors: Record<string, string>;
  busySuggestionIds: string[];
  suggestionErrors: Record<string, string>;

  open(): Promise<void>;
  close(): void;
  loadEarlier(): Promise<void>;
  /** Resolves `true` once the server typed it into the tab; `false` leaves the text with the composer. */
  send(text: string): Promise<boolean>;
  act(action: TTabChatAction): Promise<void>;
  clearError(): void;
  /** A chat socket event: the card events of this tab update `questions` / `suggestions`. */
  noteQuestionEvent(e: TChatEvent): void;
  answerTabQuestion(questionId: string, body: TTabQuestionAnswerBody): Promise<void>;
  cancelAutoAnswer(questionId: string): Promise<void>;
  loadTabQuestionScreen(questionId: string): Promise<string | null>;
  sendTabSuggestion(suggestionId: string, text: string): Promise<void>;
  dismissTabSuggestion(suggestionId: string): Promise<void>;
  /** Saves a picked file on the tab's machine; rejects when it could not. */
  uploadFile(file: PickedFile): Promise<TTabFileResponse>;
  /** The tab's pane as plain text; null when it cannot be read. */
  loadScreen(lines?: number): Promise<string | null>;
}

type Data = Omit<TabChatState, { [K in keyof TabChatState]: TabChatState[K] extends (...args: never[]) => unknown ? K : never }[keyof TabChatState]>;

const initialData = (): Data => ({
  status: 'loading',
  tab: null,
  availability: 'ready',
  sessionId: null,
  items: [],
  before: null,
  live: null,
  mode: null,
  degraded: false,
  questions: [],
  suggestions: [],
  sending: false,
  loadingEarlier: false,
  error: null,
  answeringQuestionIds: [],
  questionErrors: {},
  busySuggestionIds: [],
  suggestionErrors: {},
});

const isApiError = (e: unknown, code?: string): e is ApiError => e instanceof ApiError && (code === undefined || e.code === code);
const isLocked = (e: unknown) => e instanceof Error && e.message === 'LOCKED';
const without = (record: Record<string, string>, id: string): Record<string, string> => {
  const { [id]: _dropped, ...rest } = record;
  return rest;
};
const upsertSuggestion = (list: TTabSuggestion[], s: TTabSuggestion): TTabSuggestion[] =>
  list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];

export function createTabChatStore(deps: TabChatDeps) {
  const { api, session, tabId } = deps;
  let generation = 0;
  let closeSocket: (() => void) | null = null;
  /** Frames held while a `reset` loads the new session's first page: applied after it, in order. */
  let held: TTabChatFrame[] | null = null;
  let unsubscribeSessionEnded: (() => void) | null = null;

  const store = create<TabChatState>()((set, get) => {
    /** The page's fields, as the store keeps them. */
    const fromPage = (page: TTabChatPage): Partial<Data> => ({
      tab: page.tab,
      availability: page.tab.availability,
      sessionId: page.session_id,
      items: page.items,
      before: page.before,
      live: page.live,
      mode: page.mode,
      degraded: page.degraded,
      questions: page.questions,
      suggestions: page.suggestions,
    });

    /** A failed action: session-ending errors go to the session store, a locked one says nothing. */
    const handled = (gen: number, e: unknown): boolean => gen !== generation || isLocked(e) || session().handleApiError(e);

    /** The cards only, re-read from the newest page: the socket carries no card events. */
    const refreshCards = async (): Promise<void> => {
      const gen = generation;
      try {
        const page = await api.tabChat(session().auth(), tabId);
        if (gen !== generation) return;
        set({ questions: page.questions, suggestions: page.suggestions });
      } catch (e) {
        handled(gen, e);
      }
    };

    const reload = async (): Promise<void> => {
      const gen = generation;
      held = [];
      set({ items: [], before: null, live: null, degraded: false });
      try {
        const page = await api.tabChat(session().auth(), tabId);
        if (gen !== generation) return;
        set(fromPage(page));
      } catch (e) {
        if (handled(gen, e)) return;
        set({ error: TAB_CHAT_MSG.loadFailed });
      } finally {
        if (gen === generation) {
          const frames = held ?? [];
          held = null;
          for (const f of frames) onFrame(f);
        }
      }
    };

    const onFrame = (f: TTabChatFrame): void => {
      if (held !== null && f.type !== 'reset') {
        held.push(f);
        return;
      }
      switch (f.type) {
        case 'hello':
          set({ availability: f.availability });
          return;
        case 'items':
          set((s) => ({ items: mergeItems(s.items, f.items, 'append'), live: f.live, mode: f.mode ?? s.mode }));
          return;
        case 'state': {
          const previous = get().tab;
          set({ tab: f.tab, availability: f.tab.availability });
          // The cards come with the page, not over this socket: a tab that starts or stops needing the
          // person is when one appeared or went.
          if (previous && previous.needs_you !== f.tab.needs_you) void refreshCards();
          return;
        }
        case 'reset':
          void reload();
          return;
        case 'unavailable':
          set({ availability: f.availability });
          return;
      }
    };

    const openSocket = (): void => {
      if (closeSocket) return;
      const gen = generation;
      closeSocket = api.tabEvents(() => session().auth(), tabId, {
        after: () => get().live,
        onFrame: (f) => {
          if (gen === generation) onFrame(f);
        },
        onClose: (code, final) => {
          if (gen !== generation || !final) return;
          closeSocket = null;
          if (code === 4401) session().handleApiError(new ApiError(401, 'DEVICE_REVOKED', ''));
          else if (code === 4400) set({ error: TAB_CHAT_MSG.updateApp });
          else if (code === 4403) set({ error: TAB_CHAT_MSG.noAccess });
          else set({ error: TAB_CHAT_MSG.notFound });
        },
      });
    };

    /** Per-card flow shared by the question and suggestion cards: one action per card at a time, the
     * failure in that card, and a re-read of the cards afterwards (the chat socket may be down). */
    const onCard = async (kind: 'question' | 'suggestion', id: string, call: () => Promise<void>, changedCode: string, changed: string): Promise<void> => {
      const busyKey = kind === 'question' ? 'answeringQuestionIds' : 'busySuggestionIds';
      const errorKey = kind === 'question' ? 'questionErrors' : 'suggestionErrors';
      if (get()[busyKey].includes(id)) return;
      const gen = generation;
      set((s) => ({ [busyKey]: [...s[busyKey], id], [errorKey]: without(s[errorKey], id) }) as Partial<TabChatState>);
      try {
        await call();
        if (gen === generation) void refreshCards();
      } catch (e) {
        if (handled(gen, e)) return;
        const text = isApiError(e, changedCode) ? changed : isApiError(e) ? e.message : CHAT_MSG.network;
        set((s) => ({ [errorKey]: { ...s[errorKey], [id]: text } }) as Partial<TabChatState>);
        if (isApiError(e, changedCode)) void refreshCards();
      } finally {
        if (gen === generation) set((s) => ({ [busyKey]: s[busyKey].filter((x) => x !== id) }) as Partial<TabChatState>);
      }
    };

    return {
      ...initialData(),

      async open() {
        const gen = generation;
        set({ status: 'loading', error: null });
        try {
          const page = await api.tabChat(session().auth(), tabId);
          if (gen !== generation) return;
          set({ ...fromPage(page), status: 'ready' });
          openSocket();
        } catch (e) {
          if (gen !== generation) return;
          set({ status: 'error' });
          if (handled(gen, e)) return;
          set({ error: isApiError(e) && e.status === 404 ? TAB_CHAT_MSG.notFound : isApiError(e) && e.status === 403 ? TAB_CHAT_MSG.noAccess : TAB_CHAT_MSG.loadFailed });
        }
      },

      close() {
        generation++;
        held = null;
        // The store goes with its screen: no listener outlives it.
        unsubscribeSessionEnded?.();
        unsubscribeSessionEnded = null;
        closeSocket?.();
        closeSocket = null;
      },

      async loadEarlier() {
        const { before, loadingEarlier, sessionId } = get();
        if (before === null || loadingEarlier || held !== null) return;
        const gen = generation;
        set({ loadingEarlier: true });
        try {
          const page = await api.tabChat(session().auth(), tabId, before);
          if (gen !== generation) return;
          // A `/clear` meanwhile: this page is the old session's.
          if (page.session_id !== sessionId || get().sessionId !== sessionId) return;
          set((s) => ({ items: mergeItems(s.items, page.items, 'prepend'), before: page.before, degraded: s.degraded || page.degraded }));
        } catch (e) {
          if (handled(gen, e)) return;
          set({ error: TAB_CHAT_MSG.loadFailed });
        } finally {
          if (gen === generation) set({ loadingEarlier: false });
        }
      },

      async send(text) {
        const body = text.trim();
        if (!body || get().sending) return false;
        if (body.length > TAB_MESSAGE_MAX_CHARS) {
          set({ error: TAB_CHAT_MSG.tooLong });
          return false;
        }
        const gen = generation;
        set({ sending: true, error: null });
        try {
          await api.sendTabMessage(session().auth(), tabId, body);
          if (gen === generation) set({ sending: false });
          return true;
        } catch (e) {
          if (gen !== generation) return false;
          set({ sending: false });
          if (handled(gen, e)) return false;
          set({ error: isApiError(e, 'WAITING_PERMISSION') ? TAB_CHAT_MSG.waitingPermission : TAB_CHAT_MSG.sendFailed });
          return false;
        }
      },

      async act(action) {
        const gen = generation;
        set({ error: null });
        try {
          const res = await api.tabAction(session().auth(), tabId, action);
          if (gen !== generation) return;
          if (action === 'cycle_mode' && res.mode !== null && res.mode !== 'unknown') set({ mode: res.mode });
        } catch (e) {
          if (handled(gen, e)) return;
          // The server explains its refusals (a dialog open, an old agent, the machine offline) in pt-BR.
          set({ error: isApiError(e) && !e.code.startsWith('HTTP_') && e.code !== 'BAD_RESPONSE' ? e.message : TAB_CHAT_MSG.actionFailed });
        }
      },

      clearError() {
        set({ error: null });
      },

      noteQuestionEvent(e) {
        switch (e.type) {
          case 'tab_question':
          case 'tab_question_answered':
          case 'tab_question_closed':
            if (e.question.tab_id === tabId) set((s) => ({ questions: upsertTabQuestion(s.questions, e.question) }));
            return;
          case 'tab_suggestion':
          case 'tab_suggestion_closed':
            if (e.suggestion.tab_id === tabId) set((s) => ({ suggestions: upsertSuggestion(s.suggestions, e.suggestion) }));
            return;
          default:
            return;
        }
      },

      answerTabQuestion(questionId, body) {
        return onCard('question', questionId, () => api.answerTabQuestion(session().auth(), questionId, body), 'TAB_PROMPT_CHANGED', CHAT_MSG.tabPromptChanged);
      },

      async cancelAutoAnswer(questionId) {
        if (get().answeringQuestionIds.includes(questionId)) return;
        const gen = generation;
        set((s) => ({ answeringQuestionIds: [...s.answeringQuestionIds, questionId], questionErrors: without(s.questionErrors, questionId) }));
        try {
          const { tab_question } = await api.cancelAutoAnswer(session().auth(), questionId);
          if (gen === generation) set((s) => ({ questions: upsertTabQuestion(s.questions, tab_question) }));
        } catch (e) {
          if (handled(gen, e)) return;
          const text = isApiError(e, 'NOT_SCHEDULED') ? CHAT_MSG.autoAnswerAlreadySent : isApiError(e) ? e.message : CHAT_MSG.network;
          set((s) => ({ questionErrors: { ...s.questionErrors, [questionId]: text } }));
        } finally {
          if (gen === generation) set((s) => ({ answeringQuestionIds: s.answeringQuestionIds.filter((id) => id !== questionId) }));
        }
      },

      async loadTabQuestionScreen(questionId) {
        try {
          return (await api.tabQuestionScreen(session().auth(), questionId)).text;
        } catch {
          return null;
        }
      },

      sendTabSuggestion(suggestionId, text) {
        return onCard('suggestion', suggestionId, () => api.sendTabSuggestion(session().auth(), suggestionId, { text }), 'TAB_PROMPT_CHANGED', CHAT_MSG.tabSuggestionChanged);
      },

      dismissTabSuggestion(suggestionId) {
        return onCard('suggestion', suggestionId, () => api.dismissTabSuggestion(session().auth(), suggestionId), 'TAB_PROMPT_CHANGED', CHAT_MSG.tabSuggestionChanged);
      },

      uploadFile(file) {
        return api.uploadTabFile(session().auth(), tabId, file.uri, file.name, file.mime);
      },

      async loadScreen(lines) {
        try {
          return (await api.tabScreen(session().auth(), tabId, lines)).text;
        } catch (e) {
          if (!isLocked(e)) session().handleApiError(e);
          return null;
        }
      },
    };
  });

  // The end of the session closes the socket and forgets the conversation.
  unsubscribeSessionEnded = sessionEnded.subscribe(() => {
    store.getState().close();
    store.setState(initialData());
  });

  return store;
}
