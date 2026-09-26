// The chat store (design spec §6): the projects list, one slot per conversation (keyed by project
// id, `''` for the account-wide chat), the live buffer of the answer being written, sending,
// decisions, reset and the host. A factory over injected services so tests drive it against the
// mock transport and a real session store; `useChatStore.ts` builds the app's one instance.
//
// One socket for the whole app, opened by the first `open` and closed by `close()` or the end of
// the session. The thread only ever grows through its events — `send` never appends locally — and
// every `message` event re-reads the thread, the web's rule (no replay: a reconnect re-reads too).
//
// Every async action captures `generation` before its first `await` and drops its result when
// `close()` (or the end of the session) bumped it meanwhile, so a late answer never repopulates a
// store that was just reset.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { SessionState } from '@/features/session/model/session.types';
import { sessionEnded } from '@/features/shared/signals';
import type { TChatProjectItem, THostOptionsResponse, TTabQuestionAnswerBody } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { MobileApi } from '@/services/api/types';
import { mmkvStateStorage } from '@/services/storage';
import { applyEvent, settlePending } from '../model/events';
import { belongsTo } from '../model/filter';
import { CHAT_MSG } from '../model/messages';
import type { ChatAction, ChatConversation, ChatEvent, ChatGrant, ChatHostState, ChatMessage, TabQuestion, TabSuggestion } from '../model/types';

/** `approve_tab` approves the card *and* trusts its tab for send_input ("Permitir sempre nesta aba"). */
export type ChatDecision = 'approve' | 'deny' | 'approve_tab';

/** What the chat store needs from the session store (read through a getter, so tests can inject
 * a session store built over the same mock transport). */
export type SessionApi = Pick<SessionState, 'auth' | 'handleApiError' | 'requestPinProof' | 'requestPinProofs' | 'phase'>;

export interface ChatDeps {
  api: MobileApi;
  session: () => SessionApi;
}

export interface ConversationSlot {
  conversation: ChatConversation | null;
  messages: ChatMessage[];
  actions: ChatAction[];
  /** The tabs trusted in this conversation (the server lists those still in force). */
  grants: ChatGrant[];
  /** The tabs' questions pushed into this conversation (spec 2026-09-25 §6.3). */
  tabQuestions: TabQuestion[];
  /** The tabs' suggestions pushed into this conversation. */
  tabSuggestions: TabSuggestion[];
  host: ChatHostState | null;
  /** A `GET chat` answered since this store started (a persisted slot is shown, but not loaded). */
  loaded: boolean;
  /** Why the last `GET chat` of this conversation failed. */
  error: string | null;
}

export interface ChatState {
  projects: TChatProjectItem[];
  loadingProjects: boolean;
  conversations: Record<string /* project id, or '' for the account-wide chat */, ConversationSlot>;
  /** The open conversation's project: `null` is the account-wide chat, `undefined` is none. */
  activeProject: string | null | undefined;
  /** Events of the open conversation's answer being written, folded by `foldLive`. */
  live: ChatEvent[];
  connected: boolean;
  sending: boolean;
  decidingId: string | null;
  /** The grant whose "Revogar" is in flight. */
  revokingId: string | null;
  /** The tab questions whose answer is in flight (spec 2026-09-26 §4.13): two different cards may be
   * answered at once, one card never twice. */
  answeringQuestionIds: string[];
  /** Why the last answer of each card failed (pt-BR), by question id: shown in that card, never in the banner. */
  questionErrors: Record<string, string>;
  /** The tab suggestions whose send or dismiss is in flight, one entry per card. */
  busySuggestionIds: string[];
  /** Why the last send or dismiss of each suggestion failed (pt-BR), by id. */
  suggestionErrors: Record<string, string>;
  hostOptions: THostOptionsResponse | null;
  /** The last failed action of the screen on show, in pt-BR. */
  error: string | null;

  loadProjects(): Promise<void>;
  open(projectId: string | null): Promise<void>;
  /** The `app/chat/[id]` param: a conversation id (deep links), a project id, or `general`. */
  openByRoute(id: string): Promise<void>;
  close(): void;
  /** Resolves `true` once the server accepted the message (`202`). */
  send(text: string): Promise<boolean>;
  decide(actionId: string, decision: ChatDecision): Promise<void>;
  /** A grouped confirmation of the open conversation: one request, and one PIN entry for all its
   * approvals (none for a batch of denials). `decidingId` holds the first id while it is in flight. */
  decideMany(decisions: { id: string; decision: 'approve' | 'deny' }[]): Promise<void>;
  /** "Revogar" a trusted tab of the open conversation. A grant already revoked elsewhere (409) is
   * dropped quietly: it is gone either way. */
  revokeGrant(grantId: string): Promise<void>;
  /** Answers a tab's question from its card — no PIN. A question the tab moved past (409) says so in its card and re-reads. */
  answerTabQuestion(questionId: string, body: TTabQuestionAnswerBody): Promise<void>;
  /** The tab's live excerpt for a permission card; null when it cannot be read (closed, offline). */
  loadTabQuestionScreen(questionId: string): Promise<string | null>;
  /** Sends a tab's suggestion, as edited — no PIN. A suggestion the tab moved past (409) says so in its card and re-reads. */
  sendTabSuggestion(suggestionId: string, text: string): Promise<void>;
  /** "Dispensar": the card closes; the tab is not touched. */
  dismissTabSuggestion(suggestionId: string): Promise<void>;
  reset(): Promise<void>;
  loadHostOptions(): Promise<void>;
  setHost(machineId: string, aiAccountId?: string): Promise<void>;
  /** Re-reads one conversation's slot (`GET chat`) in place, updating `conversations[key]` only —
   * never `activeProject`, `live` or the socket. For a screen that wants a slot's current data
   * (e.g. Ajustes showing the general chat's host) without switching what is actually open. */
  refresh(projectId: string | null): Promise<void>;
  /** The project of a conversation this store holds: `null` for the account-wide chat,
   * `undefined` when the id is unknown here. */
  conversationIdToProject(id: string): string | null | undefined;
  /** Every raw event of the app's one socket, before the open conversation's filter — the
   * notifications store taps in here for a `confirmation` while no screen is watching for it.
   * Returns an unsubscribe function. */
  subscribeEvents(fn: (e: ChatEvent) => void): () => void;
}

type Data = Omit<ChatState, { [K in keyof ChatState]: ChatState[K] extends (...args: never[]) => unknown ? K : never }[keyof ChatState]>;

type PersistedSlot = Pick<ConversationSlot, 'conversation' | 'messages' | 'actions' | 'grants' | 'tabQuestions' | 'tabSuggestions' | 'host'>;
type Persisted = { projects: TChatProjectItem[]; conversations: Record<string, PersistedSlot> };

const initialData = (): Data => ({
  projects: [],
  loadingProjects: false,
  conversations: {},
  activeProject: undefined,
  live: [],
  connected: false,
  sending: false,
  decidingId: null,
  revokingId: null,
  answeringQuestionIds: [],
  questionErrors: {},
  busySuggestionIds: [],
  suggestionErrors: {},
  hostOptions: null,
  error: null,
});

const emptySlot = (): ConversationSlot => ({ conversation: null, messages: [], actions: [], grants: [], tabQuestions: [], tabSuggestions: [], host: null, loaded: false, error: null });
const keyOf = (projectId: string | null): string => projectId ?? '';
const projectOf = (key: string): string | null => (key === '' ? null : key);

const isApiError = (e: unknown, code?: string): e is ApiError => e instanceof ApiError && (code === undefined || e.code === code);
const isLocked = (e: unknown) => e instanceof Error && e.message === 'LOCKED';
const isCancelled = (e: unknown) => e instanceof Error && e.message === 'CANCELLED';
/** `record` without `id`'s entry. */
const without = (record: Record<string, string>, id: string): Record<string, string> => {
  const { [id]: _dropped, ...rest } = record;
  return rest;
};

export function createChatStore(deps: ChatDeps) {
  const { api, session } = deps;

  let generation = 0;
  let closeSocket: (() => void) | null = null;
  /** Per conversation, the latest `GET chat` in flight: an older answer never overwrites a newer. */
  const readSeq = new Map<string, number>();
  /** App-level taps into every raw event (`subscribeEvents`), independent of the open conversation
   * and never cleared by `close()`/`generation` — a subscriber outlives any one socket connection. */
  const eventListeners = new Set<(e: ChatEvent) => void>();

  const store = create<ChatState>()(
    persist(
      (set, get) => {
        const patchSlot = (key: string, patch: (slot: ConversationSlot) => Partial<ConversationSlot>) =>
          set((s) => {
            const current = s.conversations[key] ?? emptySlot();
            return { conversations: { ...s.conversations, [key]: { ...current, ...patch(current) } } };
          });

        const activeKey = (): string | null => {
          const projectId = get().activeProject;
          return projectId === undefined ? null : keyOf(projectId);
        };

        /** A failed action: session-ending errors go to the session store; a locked session says
         * nothing (the router is already showing the unlock screen); anything else shows its text. */
        const fail = (gen: number, e: unknown): void => {
          if (gen !== generation || isLocked(e)) return;
          if (session().handleApiError(e)) return;
          set({ error: isApiError(e) ? e.message : CHAT_MSG.network });
        };

        /** What a card's failed action says in that card (pt-BR), or null when nothing should: a stale
         * generation, a locked session (the unlock screen is up) or a session-ending error (the session
         * store has it). */
        const cardFailure = (gen: number, e: unknown, changed: string): string | null => {
          if (gen !== generation || isLocked(e) || session().handleApiError(e)) return null;
          if (isApiError(e, 'TAB_PROMPT_CHANGED')) return changed;
          return isApiError(e) ? e.message : CHAT_MSG.network;
        };

        const reread = async (key: string): Promise<void> => {
          const gen = generation;
          const seq = (readSeq.get(key) ?? 0) + 1;
          readSeq.set(key, seq);
          const stale = () => gen !== generation || readSeq.get(key) !== seq;
          try {
            const res = await api.chat(session().auth(), projectOf(key));
            if (stale()) return;
            patchSlot(key, () => ({
              conversation: res.conversation,
              messages: res.messages,
              actions: res.actions,
              grants: res.grants,
              tabQuestions: res.tab_questions,
              tabSuggestions: res.tab_suggestions,
              host: res.host,
              loaded: true,
              error: null,
            }));
          } catch (e) {
            if (stale() || isLocked(e) || session().handleApiError(e)) return;
            patchSlot(key, () => ({ error: isApiError(e) ? e.message : CHAT_MSG.network }));
          }
        };

        const onEvent = (e: ChatEvent): void => {
          const key = activeKey();
          if (key === null) return;
          const current = get().conversations[key] ?? emptySlot();
          if (!belongsTo(current.conversation?.id ?? null)(e)) return;
          const before = { messages: current.messages, actions: current.actions, live: get().live, grants: current.grants, tabQuestions: current.tabQuestions, tabSuggestions: current.tabSuggestions };
          const { slice, reread: mustReread } = applyEvent(before, e);
          if (slice === before) return;
          patchSlot(key, () => ({ messages: slice.messages, actions: slice.actions, grants: slice.grants, tabQuestions: slice.tabQuestions, tabSuggestions: slice.tabSuggestions }));
          set({ live: slice.live });
          if (mustReread) void reread(key);
        };

        const ensureSocket = (): void => {
          if (closeSocket) return;
          const gen = generation;
          // A factory: the socket reads the current token at every (re)connect. Locked, it throws,
          // which the socket client treats as a dropped connection and retries.
          closeSocket = api.events(() => session().auth(), {
            onEvent: (e) => {
              if (gen !== generation) return;
              eventListeners.forEach((fn) => fn(e));
              onEvent(e);
            },
            onReconnect: () => {
              if (gen !== generation) return;
              set({ connected: true, live: [] });
              const key = activeKey();
              if (key !== null) void reread(key);
            },
            onClose: (code, final) => {
              if (gen !== generation) return;
              set({ connected: false });
              if (!final) return;
              if (code === 4401) session().handleApiError(new ApiError(401, 'DEVICE_REVOKED', ''));
              else if (code === 4400) set({ error: CHAT_MSG.updateApp });
            },
          });
        };

        /** Enviar / Dispensar share one flow, per card (spec 2026-09-26 §4.13): two cards may act at once, one
         * card never twice; the event brings the card; a failure is that card's error, and a 409 re-reads. */
        const actOnSuggestion = async (suggestionId: string, call: () => Promise<void>): Promise<void> => {
          const projectId = get().activeProject;
          if (projectId === undefined || get().busySuggestionIds.includes(suggestionId)) return;
          const key = keyOf(projectId);
          const gen = generation;
          set((s) => ({ busySuggestionIds: [...s.busySuggestionIds, suggestionId], suggestionErrors: without(s.suggestionErrors, suggestionId) }));
          try {
            await call();
            // The `tab_suggestion_closed` event brings the card; the re-read covers a socket that is down.
            if (gen === generation) void reread(key);
          } catch (e) {
            const text = cardFailure(gen, e, CHAT_MSG.tabSuggestionChanged);
            if (text === null) return;
            set((s) => ({ suggestionErrors: { ...s.suggestionErrors, [suggestionId]: text } }));
            if (isApiError(e, 'TAB_PROMPT_CHANGED')) void reread(key); // show how it ended
          } finally {
            if (gen === generation) set((s) => ({ busySuggestionIds: s.busySuggestionIds.filter((id) => id !== suggestionId) }));
          }
        };

        return {
          ...initialData(),

          async loadProjects() {
            const gen = generation;
            set({ loadingProjects: true, error: null });
            try {
              const { projects } = await api.chatProjects(session().auth());
              if (gen !== generation) return;
              set({ projects, loadingProjects: false });
            } catch (e) {
              if (gen === generation) set({ loadingProjects: false });
              fail(gen, e);
            }
          },

          async open(projectId) {
            const key = keyOf(projectId);
            set((s) => ({
              activeProject: projectId,
              error: null,
              // Another conversation's half-written answer has nothing to do with this one.
              live: s.activeProject === projectId ? s.live : [],
              conversations: s.conversations[key] ? s.conversations : { ...s.conversations, [key]: emptySlot() },
            }));
            // Locked: the persisted thread is all there is until the PIN.
            if (session().phase !== 'unlocked') return;
            ensureSocket();
            await reread(key);
          },

          async openByRoute(id) {
            const { conversationIdToProject, projects, open } = get();
            const fromConversation = conversationIdToProject(id);
            if (fromConversation !== undefined) return open(fromConversation);
            if (projects.some((p) => p.id === id)) return open(id);
            if (id === 'general') return open(null);
            await open(null);
            set({ error: CHAT_MSG.notFound });
          },

          close() {
            generation++;
            closeSocket?.();
            closeSocket = null;
            readSeq.clear();
            set({ connected: false, live: [], activeProject: undefined, sending: false, decidingId: null, revokingId: null, answeringQuestionIds: [], questionErrors: {}, busySuggestionIds: [], suggestionErrors: {} });
          },

          async send(text) {
            const body = text.trim();
            const projectId = get().activeProject;
            if (!body || projectId === undefined || get().sending) return false;
            const gen = generation;
            set({ sending: true, error: null });
            try {
              await api.sendMessage(session().auth(), { text: body, project_id: projectId });
              if (gen === generation) set({ sending: false });
              return true;
            } catch (e) {
              if (gen !== generation) return false;
              set({ sending: false });
              if (isApiError(e, 'CHAT_BUSY')) set({ error: CHAT_MSG.busy });
              else fail(gen, e);
              return false;
            }
          },

          async decide(actionId, decision) {
            const projectId = get().activeProject;
            if (projectId === undefined || get().decidingId !== null) return;
            const key = keyOf(projectId);
            const gen = generation;
            set({ decidingId: actionId, error: null });
            try {
              if (decision === 'deny') {
                await api.decide(session().auth(), actionId, { decision: 'deny' });
              } else {
                const word = decision; // keeps the narrowed type (no 'deny') inside the closures below
                const withPin = () => session().requestPinProof(actionId, (proof) => api.decide(session().auth(), actionId, { decision: word, ...proof }), word);
                const card = get().conversations[key]?.actions.find((a) => a.id === actionId);
                // TER-92: a write card approves with the unlocked session; the server is the judge and
                // answers PIN_REQUIRED when it disagrees, which falls back to the sheet. A server rolled
                // back to the old schema (no optional proof) answers VALIDATION instead: same fallback,
                // so a rollback keeps approvals working (with the PIN).
                if (word === 'approve' && card?.class === 'write') {
                  try {
                    await api.decide(session().auth(), actionId, { decision: 'approve' });
                  } catch (e) {
                    if (!isApiError(e, 'PIN_REQUIRED') && !isApiError(e, 'VALIDATION')) throw e;
                    // The conversation may have been left (closed/switched) while this rejection was
                    // in flight: do not pop the PIN sheet for an action nobody is looking at any more.
                    if (gen !== generation) return;
                    await withPin();
                  }
                } else {
                  // The session store performs the call with the proof while its PIN sheet stays open:
                  // a wrong PIN is answered there, and this only resolves once the server accepted it.
                  // The proof signs the decision word, so `approve_tab` asks the PIN for exactly that.
                  await withPin();
                }
              }
              if (gen !== generation) return;
              // The `decision` event confirms it; this only saves a flicker back to "pending". Only a
              // card still pending moves: a re-read may already have it executed, failed or expired.
              patchSlot(key, (slot) => ({ actions: settlePending(slot.actions, actionId, decision === 'deny' ? 'denied' : 'approved') }));
              // The `grant` event brings the trusted tab; the re-read puts it on screen even if the socket is down.
              if (decision === 'approve_tab') void reread(key);
            } catch (e) {
              if (gen !== generation || isCancelled(e)) return;
              if (isApiError(e) && e.status === 409) {
                set({ error: CHAT_MSG.alreadyDecided });
                void reread(key); // show how it was decided
              } else {
                fail(gen, e);
              }
            } finally {
              if (gen === generation) set({ decidingId: null });
            }
          },

          async decideMany(decisions) {
            const projectId = get().activeProject;
            if (projectId === undefined || get().decidingId !== null || decisions.length === 0) return;
            const key = keyOf(projectId);
            const gen = generation;
            set({ decidingId: decisions[0]!.id, error: null });
            const approveIds = decisions.filter((d) => d.decision === 'approve').map((d) => d.id);
            const send = (proofs: Record<string, { challenge: string; pin_proof: string }>) =>
              api.decideMany(session().auth(), {
                decisions: decisions.map((d) => (d.decision === 'approve' ? { id: d.id, decision: 'approve' as const, ...proofs[d.id] } : { id: d.id, decision: 'deny' as const })),
              });
            // Like `decide`: the session store performs the call while its PIN sheet stays open.
            const withPin = () => session().requestPinProofs(approveIds, send, 'approve');
            const actions = get().conversations[key]?.actions ?? [];
            // TER-92, as in `decide`: approvals of `write` cards only go with the unlocked session. One
            // irreversible card in the batch asks the PIN once, and then every approval carries a proof
            // (still one PIN entry). The server is the judge: PIN_REQUIRED — or VALIDATION from a server
            // rolled back to proofs-always — falls back to the sheet.
            const pinFree = approveIds.every((id) => actions.find((a) => a.id === id)?.class === 'write');
            try {
              if (approveIds.length === 0) await send({});
              else if (!pinFree) await withPin();
              else {
                try {
                  await send({});
                } catch (e) {
                  if (!isApiError(e, 'PIN_REQUIRED') && !isApiError(e, 'VALIDATION')) throw e;
                  if (gen !== generation) return;
                  await withPin();
                }
              }
              if (gen !== generation) return;
              // The `decision` events confirm them; this only saves a flicker back to "pending".
              patchSlot(key, (slot) => ({
                actions: decisions.reduce((actions, d) => settlePending(actions, d.id, d.decision === 'deny' ? 'denied' : 'approved'), slot.actions),
              }));
            } catch (e) {
              if (gen !== generation || isCancelled(e)) return;
              if (isApiError(e) && e.status === 409) {
                set({ error: CHAT_MSG.alreadyDecided });
                void reread(key); // show how they were decided
              } else {
                fail(gen, e);
              }
            } finally {
              if (gen === generation) set({ decidingId: null });
            }
          },

          async revokeGrant(grantId) {
            const projectId = get().activeProject;
            if (projectId === undefined || get().revokingId !== null) return;
            const key = keyOf(projectId);
            const gen = generation;
            set({ revokingId: grantId, error: null });
            const drop = () => patchSlot(key, (slot) => ({ grants: slot.grants.filter((g) => g.id !== grantId) }));
            try {
              await api.revokeGrant(session().auth(), grantId);
              if (gen === generation) drop();
            } catch (e) {
              if (gen !== generation) return;
              if (isApiError(e) && e.status === 409) drop();
              else fail(gen, e);
            } finally {
              if (gen === generation) set({ revokingId: null });
            }
          },

          async answerTabQuestion(questionId, body) {
            const projectId = get().activeProject;
            if (projectId === undefined || get().answeringQuestionIds.includes(questionId)) return;
            const key = keyOf(projectId);
            const gen = generation;
            set((s) => ({ answeringQuestionIds: [...s.answeringQuestionIds, questionId], questionErrors: without(s.questionErrors, questionId) }));
            try {
              await api.answerTabQuestion(session().auth(), questionId, body);
              // The `tab_question_answered` event brings the card; the re-read covers a socket that is down.
              if (gen === generation) void reread(key);
            } catch (e) {
              const text = cardFailure(gen, e, CHAT_MSG.tabPromptChanged);
              if (text === null) return;
              set((s) => ({ questionErrors: { ...s.questionErrors, [questionId]: text } }));
              if (isApiError(e, 'TAB_PROMPT_CHANGED')) void reread(key); // show how it ended
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
            return actOnSuggestion(suggestionId, () => api.sendTabSuggestion(session().auth(), suggestionId, { text }));
          },

          dismissTabSuggestion(suggestionId) {
            return actOnSuggestion(suggestionId, () => api.dismissTabSuggestion(session().auth(), suggestionId));
          },

          async reset() {
            const projectId = get().activeProject;
            if (projectId === undefined) return;
            const key = keyOf(projectId);
            const gen = generation;
            set({ error: null });
            try {
              await api.reset(session().auth(), projectId);
              if (gen !== generation) return;
              set({ live: [] });
              patchSlot(key, () => ({ messages: [], actions: [], grants: [], tabQuestions: [], tabSuggestions: [] })); // a reset ends the old conversation's grants too
              await reread(key);
            } catch (e) {
              fail(gen, e);
            }
          },

          async loadHostOptions() {
            const gen = generation;
            try {
              const hostOptions = await api.hostOptions(session().auth());
              if (gen === generation) set({ hostOptions });
            } catch (e) {
              fail(gen, e);
            }
          },

          async setHost(machineId, aiAccountId) {
            const gen = generation;
            set({ error: null });
            try {
              await api.setHost(session().auth(), { machine_id: machineId, ai_account_id: aiAccountId ?? null });
              if (gen !== generation) return;
              // The host is only ever chosen for the account-wide chat.
              await reread(keyOf(null));
            } catch (e) {
              fail(gen, e);
            }
          },

          async refresh(projectId) {
            await reread(keyOf(projectId));
          },

          conversationIdToProject(id) {
            for (const [key, slot] of Object.entries(get().conversations)) {
              if (slot.conversation?.id === id) return projectOf(key);
            }
            return undefined;
          },

          subscribeEvents(fn) {
            eventListeners.add(fn);
            return () => {
              eventListeners.delete(fn);
            };
          },
        };
      },
      {
        name: 'chat',
        storage: createJSONStorage(() => mmkvStateStorage),
        partialize: (s): Persisted => ({
          projects: s.projects,
          conversations: Object.fromEntries(
            Object.entries(s.conversations).map(([key, c]) => [key, { conversation: c.conversation, messages: c.messages, actions: c.actions, grants: c.grants, tabQuestions: c.tabQuestions, tabSuggestions: c.tabSuggestions, host: c.host }]),
          ),
        }),
        merge: (persisted, current) => {
          const p = (persisted ?? {}) as Partial<Persisted>;
          return {
            ...current,
            projects: p.projects ?? current.projects,
            conversations: Object.fromEntries(Object.entries(p.conversations ?? {}).map(([key, c]) => [key, { ...emptySlot(), ...c }])),
          };
        },
      },
    ),
  );

  // Design spec §5.5: the end of a session resets every store and closes the event stream.
  sessionEnded.subscribe(() => {
    store.getState().close();
    store.setState(initialData());
  });

  return store;
}
