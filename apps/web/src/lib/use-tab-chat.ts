import { useCallback, useEffect, useRef, useState } from 'react';
import { i18n } from '../i18n';
import { api, ApiError } from './api';
import { reconnectDelay } from './reconnect';
import { mergeItems } from './tab-chat';
import { PROMPT_CHANGED_TEXT, upsertTabQuestion } from '../components/chat/tab-question-text';
import { SUGGESTION_CHANGED_TEXT, upsertTabSuggestion } from '../components/chat/tab-suggestion-text';
import type { TabChatAction, TabChatFrame, TabChatItem, TabChatPage, TabChatSummary, TabQuestion, TabQuestionAnswer, TabSuggestion } from './types';

const RECONNECT_MS = 3_000;
/** The phone's limit (`TAB_MESSAGE_MAX_CHARS`): the server refuses anything longer. */
export const TAB_MESSAGE_MAX_CHARS = 4000;

export interface TabChatData {
  status: 'loading' | 'ready' | 'error';
  tab: TabChatSummary | null;
  /** A `TabChatAvailability`, read as a plain string (a newer server may add one). */
  availability: string;
  sessionId: string | null;
  items: TabChatItem[];
  /** The cursor of the page before the oldest item shown; null at the start of the session. */
  before: string | null;
  /** The cursor the socket follows from; null while there is no transcript to follow. */
  live: string | null;
  mode: string | null;
  degraded: boolean;
  questions: TabQuestion[];
  suggestions: TabSuggestion[];
  loadingEarlier: boolean;
  /** The socket is open: the conversation follows the session live. */
  connected: boolean;
  /** The last failure of the view, translated. */
  error: string | null;
}

export const initialTabChat = (): TabChatData => ({
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
  loadingEarlier: false,
  connected: false,
  error: null,
});

/** A page's fields, as the view keeps them. */
export function fromPage(page: TabChatPage): Partial<TabChatData> {
  return {
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
  };
}

/** One frame of the socket applied to the data. `reset` is the caller's (it reloads); everything else is pure. */
export function applyFrame(s: TabChatData, f: Exclude<TabChatFrame, { type: 'reset' }>): TabChatData {
  switch (f.type) {
    case 'hello':
      return { ...s, availability: f.availability };
    case 'items':
      return { ...s, items: mergeItems(s.items, f.items, 'append'), live: f.live, mode: f.mode ?? s.mode };
    case 'state':
      return { ...s, tab: f.tab, availability: f.tab.availability };
    case 'unavailable':
      return { ...s, availability: f.availability };
  }
}

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError && e.code && !e.code.startsWith('HTTP_') ? e.message : fallback);

export interface TabChat extends TabChatData {
  loadEarlier(): Promise<void>;
  /** Resolves `true` once the server typed it into the tab; `false` leaves the text with the composer. */
  send(text: string): Promise<boolean>;
  act(action: TabChatAction): Promise<void>;
  clearError(): void;
  answeringQuestionId: string | null;
  questionErrors: Record<string, string>;
  answerQuestion(id: string, body: TabQuestionAnswer): void;
  cancelAutoAnswer(id: string): void;
  busySuggestionId: string | null;
  suggestionErrors: Record<string, string>;
  sendSuggestion(id: string, text: string): void;
  dismissSuggestion(id: string): void;
}

/**
 * A Claude Code tab read as a conversation (TER-1003), the web's twin of the phone's session store
 * (spec 2026-10-01 tab chat §6): the newest page over REST, then `/ws/tabs/:id/chat` from that page's
 * `live` cursor, items merged by id. A `reset` (a `/clear`, an account swap) empties the conversation and
 * loads the new session's first page, holding the frames that arrive meanwhile. The socket reconnects
 * from the last cursor. Nothing is persisted: closing the view forgets the conversation.
 *
 * `enabled` false (the view is not on screen) keeps nothing open: no socket, so the server stops
 * following the session for this viewer.
 */
export function useTabChat(tabId: string, enabled: boolean): TabChat {
  const [data, setData] = useState<TabChatData>(initialTabChat);
  const latest = useRef(data);
  latest.current = data;
  const set = useCallback((patch: Partial<TabChatData> | ((s: TabChatData) => Partial<TabChatData>)) => {
    setData((s) => {
      const next = { ...s, ...(typeof patch === 'function' ? patch(s) : patch) };
      latest.current = next;
      return next;
    });
  }, []);
  /** Bumped when the view closes or changes tab: a late answer of the previous one is dropped. */
  const generation = useRef(0);

  /** The cards only, re-read from the newest page: the socket carries no card events. */
  const refreshCards = useCallback(async () => {
    const gen = generation.current;
    try {
      const page = await api.tabChat.page(tabId);
      if (gen === generation.current) set({ questions: page.questions, suggestions: page.suggestions });
    } catch {
      /* the next state change tries again */
    }
  }, [tabId, set]);

  useEffect(() => {
    if (!enabled) return;
    const gen = ++generation.current;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Frames held while a `reset` loads the new session's first page: applied after it, in order. */
    let held: TabChatFrame[] | null = null;
    const alive = () => gen === generation.current;

    const onFrame = (f: TabChatFrame) => {
      if (held !== null && f.type !== 'reset') {
        held.push(f);
        return;
      }
      if (f.type === 'reset') {
        void reload();
        return;
      }
      const previous = latest.current.tab;
      set((s) => applyFrame(s, f));
      // A tab that starts or stops needing the person is when a card appeared or went.
      if (f.type === 'state' && previous && (previous.needs_you !== f.tab.needs_you || previous.state !== f.tab.state)) void refreshCards();
    };

    const reload = async () => {
      held = [];
      set({ items: [], before: null, live: null, degraded: false });
      try {
        const page = await api.tabChat.page(tabId);
        if (alive()) set(fromPage(page));
      } catch {
        if (alive()) set({ error: i18n.t('Não foi possível abrir a conversa.') });
      } finally {
        if (alive()) {
          const frames = held ?? [];
          held = null;
          for (const f of frames) onFrame(f);
        }
      }
    };

    /** `from`: the first page's cursor (the state it was just set into may not be rendered yet); a
     *  reconnect follows from the last cursor seen. */
    const connect = (from?: string | null) => {
      if (!alive()) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const after = from !== undefined ? from : latest.current.live;
      ws = new WebSocket(`${proto}://${location.host}/ws/tabs/${tabId}/chat${after ? `?after=${encodeURIComponent(after)}` : ''}`);
      ws.onopen = () => alive() && set({ connected: true });
      ws.onmessage = (ev) => {
        if (!alive()) return;
        try {
          onFrame(JSON.parse(String(ev.data)) as TabChatFrame);
        } catch {
          /* a frame we cannot read */
        }
      };
      ws.onclose = (ev) => {
        ws = null;
        if (!alive()) return;
        set({ connected: false });
        timer = setTimeout(() => connect(), reconnectDelay(ev.code, RECONNECT_MS));
      };
      ws.onerror = () => ws?.close();
    };

    setData(initialTabChat());
    latest.current = initialTabChat();
    void (async () => {
      try {
        const page = await api.tabChat.page(tabId);
        if (!alive()) return;
        set({ ...fromPage(page), status: 'ready' });
        connect(page.live);
      } catch (e) {
        if (!alive()) return;
        set({
          status: 'error',
          error:
            e instanceof ApiError && e.status === 404
              ? i18n.t('Aba não encontrada.')
              : e instanceof ApiError && e.status === 403
                ? i18n.t('Seu acesso não inclui terminais.')
                : i18n.t('Não foi possível abrir a conversa.'),
        });
      }
    })();

    return () => {
      generation.current++;
      clearTimeout(timer);
      const open = ws;
      ws = null;
      open?.close();
    };
  }, [tabId, enabled, set, refreshCards]);

  const loadEarlier = useCallback(async () => {
    const { before, loadingEarlier, sessionId } = latest.current;
    if (before === null || loadingEarlier) return;
    const gen = generation.current;
    set({ loadingEarlier: true });
    try {
      const page = await api.tabChat.page(tabId, before);
      if (gen !== generation.current) return;
      // A `/clear` meanwhile: this page is the old session's.
      if (page.session_id !== sessionId || latest.current.sessionId !== sessionId) return;
      set((s) => ({ items: mergeItems(s.items, page.items, 'prepend'), before: page.before, degraded: s.degraded || page.degraded }));
    } catch {
      if (gen === generation.current) set({ error: i18n.t('Não foi possível abrir a conversa.') });
    } finally {
      if (gen === generation.current) set({ loadingEarlier: false });
    }
  }, [tabId, set]);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body) return false;
      if (body.length > TAB_MESSAGE_MAX_CHARS) {
        set({ error: i18n.t('Mensagem longa demais (máximo de {{max}} caracteres)', { max: TAB_MESSAGE_MAX_CHARS }) });
        return false;
      }
      set({ error: null });
      try {
        await api.tabChat.send(tabId, body);
        return true;
      } catch (e) {
        set({
          error: e instanceof ApiError && e.code === 'WAITING_PERMISSION' ? i18n.t('Responda a pergunta acima antes de enviar uma mensagem') : errorText(e, i18n.t('Não foi possível enviar. Tente de novo.')),
        });
        return false;
      }
    },
    [tabId, set],
  );

  const act = useCallback(
    async (action: TabChatAction) => {
      set({ error: null });
      try {
        const res = await api.tabChat.action(tabId, action);
        if (action === 'cycle_mode' && res.mode !== null && res.mode !== 'unknown') set({ mode: res.mode });
      } catch (e) {
        // The server explains its refusals (a dialog open, an old agent, the machine offline).
        set({ error: errorText(e, i18n.t('Não foi possível enviar o comando. Tente de novo.')) });
      }
    },
    [tabId, set],
  );

  const clearError = useCallback(() => set({ error: null }), [set]);

  // --- The tab's question and suggestion cards (TER-995): the chat's own routes -----------------------
  const [answeringQuestionId, setAnsweringQuestionId] = useState<string | null>(null);
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>({});
  const onQuestion = useCallback(
    async (id: string, call: () => Promise<{ tab_question: TabQuestion }>, fallback: string, changed?: { code: string; text: string }) => {
      setAnsweringQuestionId(id);
      setQuestionErrors(({ [id]: _dropped, ...rest }) => rest);
      try {
        const { tab_question } = await call();
        set((s) => ({ questions: upsertTabQuestion(s.questions, tab_question) }));
      } catch (e) {
        const text = changed && e instanceof ApiError && e.code === changed.code ? changed.text : e instanceof ApiError ? e.message : fallback;
        setQuestionErrors((prev) => ({ ...prev, [id]: text }));
      } finally {
        setAnsweringQuestionId(null);
      }
    },
    [set],
  );
  const answerQuestion = useCallback(
    (id: string, body: TabQuestionAnswer) => void onQuestion(id, () => api.answerTabQuestion(id, body), i18n.t('Não foi possível responder'), { code: 'TAB_PROMPT_CHANGED', text: i18n.t(PROMPT_CHANGED_TEXT) }),
    [onQuestion],
  );
  const cancelAutoAnswer = useCallback(
    (id: string) => void onQuestion(id, () => api.cancelAutoAnswer(id), i18n.t('Não foi possível cancelar'), { code: 'NOT_SCHEDULED', text: i18n.t('A resposta automática já foi enviada.') }),
    [onQuestion],
  );

  const [busySuggestionId, setBusySuggestionId] = useState<string | null>(null);
  const [suggestionErrors, setSuggestionErrors] = useState<Record<string, string>>({});
  const onSuggestion = useCallback(
    async (id: string, call: () => Promise<{ tab_suggestion: TabSuggestion }>, fallback: string) => {
      setBusySuggestionId(id);
      setSuggestionErrors(({ [id]: _dropped, ...rest }) => rest);
      try {
        const { tab_suggestion } = await call();
        set((s) => ({ suggestions: upsertTabSuggestion(s.suggestions, tab_suggestion) }));
      } catch (e) {
        const text = e instanceof ApiError && e.code === 'TAB_PROMPT_CHANGED' ? i18n.t(SUGGESTION_CHANGED_TEXT) : e instanceof ApiError ? e.message : fallback;
        setSuggestionErrors((prev) => ({ ...prev, [id]: text }));
      } finally {
        setBusySuggestionId(null);
      }
    },
    [set],
  );
  const sendSuggestion = useCallback((id: string, text: string) => void onSuggestion(id, () => api.sendTabSuggestion(id, text), i18n.t('Não foi possível enviar')), [onSuggestion]);
  const dismissSuggestion = useCallback((id: string) => void onSuggestion(id, () => api.dismissTabSuggestion(id), i18n.t('Não foi possível dispensar')), [onSuggestion]);

  return {
    ...data,
    loadEarlier,
    send,
    act,
    clearError,
    answeringQuestionId,
    questionErrors,
    answerQuestion,
    cancelAutoAnswer,
    busySuggestionId,
    suggestionErrors,
    sendSuggestion,
    dismissSuggestion,
  };
}
