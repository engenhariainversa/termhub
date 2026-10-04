// The chat store (design spec §6): the projects list, one slot per conversation (keyed by project
// id, `''` for the account-wide chat), the live fold of the answer being written, sending,
// decisions, reset and the host. A factory over injected services so tests drive it against the
// mock transport and a real session store; `useChatStore.ts` builds the app's one instance.
//
// One socket for the whole app, opened by the first `open` and closed by `close()` or the end of
// the session. The thread grows through its events, merged by id; `send` shows the person's row at
// once under a local id and renames it when the server accepts it. Only a reconnect re-reads the
// thread (no replay).
//
// Every async action captures `generation` before its first `await` and drops its result when
// `close()` (or the end of the session) bumped it meanwhile, so a late answer never repopulates a
// store that was just reset.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SessionState } from '@/features/session/model/session.types';
import { appBackgrounded, messageSent, sessionEnded } from '@/features/shared/signals';
import { STANDING_KIND_LABEL, standingKindOf, type TChatAttachment, type TChatProjectItem, type THostOptionsResponse, type TTabQuestionAnswerBody } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { randomId } from '@/services/crypto/random';
import type { MobileApi } from '@/services/api/types';
import { mmkvStateStorage } from '@/services/storage';
import { applyEvent, applyStandingGrantEvent, droppedRows, mergeThread, settlePending, upsertTabQuestion } from '../model/events';
import { belongsTo } from '../model/filter';
import { CHAT_MSG } from '../model/messages';
import { upsertTabLimit } from '../model/tab-limit-text';
import { closeLive, emptyFold, pruneLive, seedLive, type LiveFold } from '../model/live';
import type { PickedFile } from './attachments';
import { createThrottledStorage } from './throttled-storage';
import type { ChatAction, ChatConversation, ChatEvent, ChatGrant, ChatHostState, ChatMessage, ChatProjectGrant, ChatStandingGrant, SubagentView, TabLimit, TabQuestion, TabSuggestion } from '../model/types';
import { replyBody, replyOnRow, replyRefOfRow, type ReplyRef } from '../model/reply';

/** `approve_tab` approves the card *and* trusts its tab for send_input ("Permitir sempre nesta aba");
 * `approve_project` approves it *and* trusts its project's board ("Permitir sempre neste projeto");
 * `approve_tab_terminal` trusts the tab's keys and shell ("Liberar teclas e shell nesta aba") and
 * `approve_project_all` everything in the project ("Liberar tudo neste projeto"); `approve_project_always`
 * trusts one kind of action on the card's project with no expiry ("Liberar sem prazo", TER-386). */
export type ChatDecision = 'approve' | 'deny' | 'approve_tab' | 'approve_project' | 'approve_tab_terminal' | 'approve_project_all' | 'approve_project_always';

/** What the chat store needs from the session store (read through a getter, so tests can inject
 * a session store built over the same mock transport). */
export type SessionApi = Pick<SessionState, 'auth' | 'handleApiError' | 'requestPinProof' | 'requestPinProofs' | 'phase' | 'tokenStale' | 'renewToken'>;

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
  /** The projects' boards trusted in this conversation ("Permitir sempre neste projeto", design spec
   * 2026-09-26 §7); the server lists those still in force. */
  projectGrants: ChatProjectGrant[];
  /** The standing grants ("Liberar sem prazo", spec 2026-09-28 TER-386) on this slot's project — all of
   * them in the account-wide chat. Not bound to the conversation: a reset keeps them. */
  standingGrants: ChatStandingGrant[];
  /** The tabs' questions pushed into this conversation (spec 2026-09-25 §6.3). */
  tabQuestions: TabQuestion[];
  /** The tabs' suggestions pushed into this conversation. */
  tabSuggestions: TabSuggestion[];
  /** The usage-limit cards of the project's tabs (spec 2026-09-30 project AI accounts §7.2). */
  tabLimits: TabLimit[];
  /** The subagents panel of this conversation, newest first (spec 2026-09-26 panel §4). */
  subagents: SubagentView[];
  /** Ids whose "Cancelar" came back with `subagent_cancel_failed`, or any other cancel failure (a
   * 404, a 5xx, a dropped connection) marked the same way — cleared once a fresh `subagent` event
   * for that id arrives. */
  cancelFailed: string[];
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
  /** The open conversation's answer being written: streamed text, tool calls and started rows by
   * message id, folded incrementally (`applyLive`) — a row subscribes to its own entry. */
  live: LiveFold;
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
  /** The usage-limit cards whose answer is in flight, one entry per card. */
  busyLimitIds: string[];
  /** Why the last answer of each usage-limit card failed (pt-BR), by id: a failed swap keeps the card open. */
  limitErrors: Record<string, string>;
  hostOptions: THostOptionsResponse | null;
  /** The last failed action of the screen on show, in pt-BR. */
  error: string | null;
  /** The latest `attachment_status` heard for each attachment of the open conversation, by id (the
   * web's `ChatPanel` map): the thread takes the event into its message; the composer's chips take
   * it from here, since a chip's file has no message yet. Small rows; starts over with the conversation. */
  attachmentStatuses: Record<string, TChatAttachment>;

  /** `quiet` is a background refresh (the iPad split keeping its list live, spec 2026-09-28 §2.3): it
   * never spins the pull-to-refresh nor touches `error` — the banner may be the open pane's, and a
   * failed refresh behind the person's back has nothing to tell them. */
  loadProjects(opts?: { quiet?: boolean }): Promise<void>;
  /** Pins or unpins a project in Favoritos (TER-541): the row changes at once, and goes back with the
   * banner when the server refuses. */
  setFavorite(projectId: string, favorite: boolean): Promise<void>;
  open(projectId: string | null): Promise<void>;
  /** The `app/chat/[id]` param: a conversation id (deep links), a project id, or `general`. */
  openByRoute(id: string): Promise<void>;
  close(): void;
  /** Resolves `true` once the server accepted the message (`202`). `text` may be empty with attachments.
   *  `replyTo` is the message (TER-447) or card (TER-849) it answers: shown on the row at once, its id sent with it. */
  send(text: string, attachments?: TChatAttachment[], replyTo?: ReplyRef): Promise<boolean>;
  /** Uploads one picked file into the open conversation; the composer's chip follows `onProgress`. */
  uploadAttachment(file: PickedFile, onProgress: (fraction: number) => void): Promise<TChatAttachment>;
  /** Drops an unsent attachment (a chip's ✕). Already gone (404) or already sent (409): nothing to do. */
  deleteAttachment(id: string): Promise<void>;
  /** `<Image source>` for a sent image: the url plus signed headers. */
  attachmentSource(id: string): Promise<{ uri: string; headers: Record<string, string> }>;
  /** "Tentar de novo" on a row whose send failed: the row goes, and its text is sent again as a new one. */
  retrySend(messageId: string): Promise<boolean>;
  decide(actionId: string, decision: ChatDecision): Promise<void>;
  /** A grouped confirmation of the open conversation: one request, and one PIN entry for all its
   * approvals (none for a batch of denials). `decidingId` holds the first id while it is in flight. */
  decideMany(decisions: { id: string; decision: 'approve' | 'deny' }[]): Promise<void>;
  /** "Revogar" a trusted tab, a trusted project or a standing grant shown in the open conversation. A
   * grant already revoked elsewhere (409) is dropped quietly: it is gone either way. */
  revokeGrant(grantId: string): Promise<void>;
  /** Answers a tab's question from its card — no PIN. A question the tab moved past (409) says so in its card and re-reads. */
  answerTabQuestion(questionId: string, body: TTabQuestionAnswerBody): Promise<void>;
  /** "Cancelar" on a countdown (concierge memory spec 2026-09-26 §6): nothing is sent, the proposed
   * answer stays on the card as its own pre-selection. The returned card replaces the question in
   * the store; 409 `NOT_SCHEDULED` (the countdown already sent, or someone else cancelled it first)
   * reads as its own sentence, in the card like `answerTabQuestion`'s own failures. */
  cancelAutoAnswer(questionId: string): Promise<void>;
  /** The tab's live excerpt for a permission card; null when it cannot be read (closed, offline). */
  loadTabQuestionScreen(questionId: string): Promise<string | null>;
  /** Sends a tab's suggestion, as edited — no PIN. A suggestion the tab moved past (409) says so in its card and re-reads. */
  sendTabSuggestion(suggestionId: string, text: string): Promise<void>;
  /** "Dispensar": the card closes; the tab is not touched. */
  dismissTabSuggestion(suggestionId: string): Promise<void>;
  /** A usage-limit card's answer — no PIN: swap the tab to `accountId`, or `null` for "Esperar". A failed
   * swap (409) says why in the card, which stays open; the event (or a re-read) brings the closed card. */
  answerTabLimit(limitId: string, accountId: string | null): Promise<void>;
  /** "Cancelar" on a subagent's row (spec 2026-09-26 panel §5.4) — no PIN. A 409 (already at rest, or
   * its process gone) re-reads the trail; any other failure marks that row `cancelFailed`. */
  cancelSubagent(subagentId: string): Promise<void>;
  /** "Esquecer esta decisão" on a tab question's suggestion line (chat decision memory spec
   * 2026-09-26 §5.1): the card itself clears its own pre-selection regardless of the outcome, so a
   * session-ending error is the only thing worth reacting to here. */
  forgetDecision(decisionId: string): Promise<void>;
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

type PersistedSlot = Pick<ConversationSlot, 'conversation' | 'messages' | 'actions' | 'grants' | 'projectGrants' | 'standingGrants' | 'tabQuestions' | 'tabSuggestions' | 'tabLimits' | 'subagents' | 'host'>;
type Persisted = { projects: TChatProjectItem[]; conversations: Record<string, PersistedSlot> };

const initialData = (): Data => ({
  projects: [],
  loadingProjects: false,
  conversations: {},
  activeProject: undefined,
  live: emptyFold(),
  connected: false,
  sending: false,
  decidingId: null,
  revokingId: null,
  answeringQuestionIds: [],
  questionErrors: {},
  busySuggestionIds: [],
  suggestionErrors: {},
  busyLimitIds: [],
  limitErrors: {},
  hostOptions: null,
  error: null,
  attachmentStatuses: {},
});

const emptySlot = (): ConversationSlot => ({ conversation: null, messages: [], actions: [], grants: [], projectGrants: [], standingGrants: [], tabQuestions: [], tabSuggestions: [], tabLimits: [], subagents: [], cancelFailed: [], host: null, loaded: false, error: null });
const keyOf = (projectId: string | null): string => projectId ?? '';
const projectOf = (key: string): string | null => (key === '' ? null : key);

/** How many early events (see `early` in the store) are held while the open slot has no conversation: the web's cap. */
const EARLY_EVENTS_CAP = 500;

/** No ids: what a re-read of a slot that is not on screen merges with (its fold is not in the store). */
const NO_IDS: ReadonlySet<string> = new Set();

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
  /** Favorite writes in flight, by project (TER-541): the last tap's number and the chain of its writes. */
  const favoriteWrites = new Map<string, { seq: number; done: Promise<unknown> }>();
  /** The number of the last tap on each project's pin, kept after its write: a list read that
   * started before that tap holds an older state than the row. */
  const favoriteTapped = new Map<string, number>();
  let favoriteSeq = 0;
  let closeSocket: (() => void) | null = null;
  /** Per conversation, the latest `GET chat` in flight: an older answer never overwrites a newer. */
  const readSeq = new Map<string, number>();
  /**
   * Per conversation key, one set per `GET chat` in flight, filled with the ids whose `message` event
   * (or whose 202, for the person's own row) reached the store meanwhile: those rows are newer than
   * the snapshot, and a row it lacks is kept only if it is one of them (spec 2026-09-29 §5 rule 3).
   */
  const reads = new Map<string, Set<Set<string>>>();
  /** Tells every read of `key` in flight that row `id` arrived after its snapshot. */
  const arrivedDuringReads = (key: string, id: string): void => {
    reads.get(key)?.forEach((arrived) => arrived.add(id));
  };
  /**
   * Live events tagged with a conversation that reached the open slot (`key`) before it knew its
   * conversation (its first `GET chat` in flight). Held, not dropped, as on the web: the deltas and
   * the final `message` of an answer under way exist nowhere else, and the snapshot may be older than
   * them. The read that gives the slot its conversation replays those of that conversation, in order,
   * through the same path as live ones; the others go. Emptied when another conversation opens.
   */
  let early: { key: string; events: ChatEvent[] } | null = null;
  /** App-level taps into every raw event (`subscribeEvents`), independent of the open conversation
   * and never cleared by `close()`/`generation` — a subscriber outlives any one socket connection. */
  const eventListeners = new Set<(e: ChatEvent) => void>();
  /** The persisted slice's writer (spec §4.2 "Persistence"): at most one MMKV write per 2 s, plus a
   * flush at the end of a run and when the app goes to the background. */
  const storage = createThrottledStorage<Persisted>(mmkvStateStorage);

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
          const arrived = new Set<string>();
          const inFlight = reads.get(key) ?? new Set<Set<string>>();
          reads.set(key, inFlight.add(arrived));
          try {
            const res = await api.chat(session().auth(), projectOf(key));
            if (stale()) return;
            // The same conversation: the snapshot merges into the thread by id (spec 2026-09-29 §5):
            // a row that ended or was removed while the GET was in flight is not brought back, a row
            // whose `message` event landed meanwhile (a final answer, the person's row renamed on its
            // 202) survives the older snapshot, and a row the server no longer has leaves. Another
            // conversation (a reset, here or elsewhere) replaces the thread. This device's own unsent
            // rows stay either way.
            const same = get().conversations[key]?.conversation?.id === res.conversation.id;
            const onScreen = key === activeKey();
            const dropped = same && onScreen ? droppedRows(get().conversations[key]?.messages ?? [], res.messages, arrived) : [];
            patchSlot(key, (slot) => ({
              conversation: res.conversation,
              messages: same ? mergeThread(slot.messages, res.messages, onScreen ? get().live.removed : NO_IDS, arrived) : [...res.messages, ...slot.messages.filter((m) => m.local !== undefined)],
              actions: res.actions,
              grants: res.grants,
              projectGrants: res.project_grants,
              standingGrants: res.standing_grants,
              tabQuestions: res.tab_questions,
              tabSuggestions: res.tab_suggestions,
              tabLimits: res.tab_limits,
              subagents: res.subagents,
              host: res.host,
              loaded: true,
              error: null,
            }));
            // The fold is the open conversation's: a row the snapshot shows answered carries its text
            // now, so what streamed for it goes and it is closed; a row the merge dropped is closed too
            // (its started mark must not outlive it); one still empty keeps its streamed prefix on
            // screen. Then the rows the server lists as still to be answered are started, unless
            // closed. An older server sends no list (`[]` by default): nothing is seeded.
            if (onScreen) {
              const live = seedLive(same ? closeLive(pruneLive(get().live, res.messages), dropped) : emptyFold(), res.open_answer_ids);
              if (live !== get().live) set({ live });
              // The slot knows its conversation now: what arrived before it is newer than this snapshot.
              if (early?.key === key) {
                const held = early.events;
                early = null;
                for (const e of held) if ('conversation_id' in e && e.conversation_id === res.conversation.id) applyOwn(key, e);
              }
            }
          } catch (e) {
            if (stale() || isLocked(e) || session().handleApiError(e)) return;
            patchSlot(key, () => ({ error: isApiError(e) ? e.message : CHAT_MSG.network }));
          } finally {
            // Not a `.finally` on the GET: that would add a tick between its answer and the merge.
            inFlight.delete(arrived);
            if (inFlight.size === 0 && reads.get(key) === inFlight) reads.delete(key);
          }
        };

        /** A standing grant's event reaches every slot that shows it, open or not (`applyStandingGrantEvent`). */
        const onStandingGrantEvent = (e: ChatEvent): void => {
          const conversations = get().conversations;
          let changed = false;
          const next = Object.fromEntries(
            Object.entries(conversations).map(([key, slot]) => {
              const standingGrants = applyStandingGrantEvent(slot.standingGrants, projectOf(key), e);
              if (standingGrants === slot.standingGrants) return [key, slot];
              changed = true;
              return [key, { ...slot, standingGrants }];
            }),
          );
          if (changed) set({ conversations: next });
        };

        const onEvent = (e: ChatEvent): void => {
          if (e.type === 'standing_grant' || e.type === 'standing_grant_revoked') {
            onStandingGrantEvent(e);
            return;
          }
          const key = activeKey();
          if (key === null) return;
          const conversationId = get().conversations[key]?.conversation?.id ?? null;
          if (conversationId === null && 'conversation_id' in e) {
            const events = early?.key === key ? early.events : [];
            early = { key, events: [...events.slice(-(EARLY_EVENTS_CAP - 1)), e] };
            return;
          }
          if (!belongsTo(conversationId)(e)) return;
          applyOwn(key, e);
        };

        /** One event of the open conversation, live or held: the slice takes it, then its side effects. */
        const applyOwn = (key: string, e: ChatEvent): void => {
          const current = get().conversations[key] ?? emptySlot();
          const before = {
            messages: current.messages,
            actions: current.actions,
            live: get().live,
            grants: current.grants,
            projectGrants: current.projectGrants,
            tabQuestions: current.tabQuestions,
            tabSuggestions: current.tabSuggestions,
            tabLimits: current.tabLimits,
            subagents: current.subagents,
            cancelFailed: current.cancelFailed,
          };
          const slice = applyEvent(before, e);
          // One `set` per event, touching only what changed: a delta used to cost two (the slot,
          // then `live`), each one a persist write, and a new slot object for rows that did not move.
          const liveChanged = slice.live !== before.live;
          const slotChanged =
            slice.messages !== before.messages ||
            slice.actions !== before.actions ||
            slice.grants !== before.grants ||
            slice.projectGrants !== before.projectGrants ||
            slice.tabQuestions !== before.tabQuestions ||
            slice.tabSuggestions !== before.tabSuggestions ||
            slice.tabLimits !== before.tabLimits ||
            slice.subagents !== before.subagents ||
            slice.cancelFailed !== before.cancelFailed;
          if (liveChanged || slotChanged) {
            set((s) => ({
              ...(liveChanged ? { live: slice.live } : {}),
              ...(slotChanged
                ? {
                    conversations: {
                      ...s.conversations,
                      [key]: {
                        ...(s.conversations[key] ?? emptySlot()),
                        messages: slice.messages,
                        actions: slice.actions,
                        grants: slice.grants,
                        projectGrants: slice.projectGrants,
                        tabQuestions: slice.tabQuestions,
                        tabSuggestions: slice.tabSuggestions,
                        tabLimits: slice.tabLimits,
                        subagents: slice.subagents,
                        cancelFailed: slice.cancelFailed,
                      },
                    },
                  }
                : {}),
            }));
          }
          if (e.type === 'message') arrivedDuringReads(key, e.message.id);
          if (e.type === 'attachment_status') set((s) => ({ attachmentStatuses: { ...s.attachmentStatuses, [e.attachment.id]: e.attachment } }));
          // The answer is complete (or failed): what streamed in is worth an MMKV write now.
          if (e.type === 'run_finished') storage.flush();
          // A run that could not even be attempted: nobody awaits it, so this is where it is said.
          // Only for its own conversation: `belongsTo` already dropped the others, and the line is the
          // screen's banner (where a failed send's goes), set after the re-read only if that same
          // conversation is still the one on screen — another project may have opened meanwhile.
          if (e.type === 'run_finished' && e.message_id === null && !e.ok) {
            const gen = generation;
            const conversationId = e.conversation_id;
            void reread(key).then(() => {
              if (gen === generation && activeKey() === key && get().conversations[key]?.conversation?.id === conversationId) set({ error: CHAT_MSG.setupFailed });
            });
          }
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
              // `live` stays: what streamed before the drop is still the best view of a row the
              // re-read shows unanswered. The re-read prunes what it shows finished (`pruneLive`).
              set({ connected: true });
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

        /** A usage-limit card's answer, per card like a suggestion's: two cards may be answered at once, one
         * card never twice; the event brings the closed card; a failure is that card's error, and a 409 (a
         * failed swap, or a card that closed meanwhile) re-reads, so the card shows how it stands. */
        const answerLimit = async (limitId: string, accountId: string | null): Promise<void> => {
          const projectId = get().activeProject;
          if (projectId === undefined || get().busyLimitIds.includes(limitId)) return;
          const key = keyOf(projectId);
          const gen = generation;
          set((s) => ({ busyLimitIds: [...s.busyLimitIds, limitId], limitErrors: without(s.limitErrors, limitId) }));
          try {
            const limit = await api.answerTabLimit(session().auth(), limitId, accountId);
            if (gen !== generation) return;
            // The answer is the card as it now stands: shown at once, even with the socket down.
            const slot = get().conversations[key];
            if (slot?.tabLimits.some((l) => l.id === limit.id)) patchSlot(key, (current) => ({ tabLimits: upsertTabLimit(current.tabLimits, limit) }));
          } catch (e) {
            if (gen !== generation || isLocked(e) || session().handleApiError(e)) return;
            set((s) => ({ limitErrors: { ...s.limitErrors, [limitId]: isApiError(e) ? e.message : CHAT_MSG.network } }));
            if (isApiError(e) && e.status === 409) void reread(key);
          } finally {
            if (gen === generation) set((s) => ({ busyLimitIds: s.busyLimitIds.filter((id) => id !== limitId) }));
          }
        };

        return {
          ...initialData(),

          async loadProjects(opts) {
            const quiet = opts?.quiet === true;
            const gen = generation;
            if (!quiet) set({ loadingProjects: true, error: null });
            try {
              const readFrom = favoriteSeq;
              const read = await api.chatProjects(session().auth());
              if (gen !== generation) return;
              // A pin still being written wins over a list read that may have started before it.
              const local = new Map(get().projects.map((p) => [p.id, p.favorite_position]));
              const newer = (id: string) => favoriteWrites.has(id) || (favoriteTapped.get(id) ?? 0) > readFrom;
              const projects = read.projects.map((p) => (newer(p.id) && local.has(p.id) ? { ...p, favorite_position: local.get(p.id) ?? null } : p));
              set(quiet ? { projects } : { projects, loadingProjects: false });
            } catch (e) {
              if (!quiet) {
                if (gen === generation) set({ loadingProjects: false });
                fail(gen, e);
              } else if (gen === generation && !isLocked(e)) {
                // Silent, but a session-ending answer still ends the session.
                session().handleApiError(e);
              }
            }
          },

          async setFavorite(projectId, favorite) {
            const gen = generation;
            const placeOf = (id: string) => get().projects.find((p) => p.id === id)?.favorite_position ?? null;
            const before = placeOf(projectId);
            const places = get().projects.map((p) => p.favorite_position ?? -1);
            const next = favorite ? (before ?? Math.max(-1, ...places) + 1) : null;
            const put = (value: number | null) => set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, favorite_position: value } : p)) }));
            put(next);
            // One write at a time per project, in tap order, so the server ends where the last tap says.
            const seq = ++favoriteSeq;
            favoriteTapped.set(projectId, seq);
            const previous = favoriteWrites.get(projectId)?.done ?? Promise.resolve();
            const done = previous.then(() => api.setProjectFavorite(session().auth(), projectId, favorite));
            favoriteWrites.set(projectId, { seq, done: done.catch(() => undefined) });
            try {
              await done;
            } catch (e) {
              // A later tap on the same row owns it now: this failure must not undo it.
              if (gen === generation && favoriteWrites.get(projectId)?.seq === seq) put(before);
              fail(gen, e);
            } finally {
              if (favoriteWrites.get(projectId)?.seq === seq) favoriteWrites.delete(projectId);
            }
          },

          async open(projectId) {
            const key = keyOf(projectId);
            if (early !== null && early.key !== key) early = null;
            set((s) => ({
              activeProject: projectId,
              error: null,
              // Another conversation's half-written answer has nothing to do with this one, nor its uploads' statuses.
              live: s.activeProject === projectId ? s.live : emptyFold(),
              attachmentStatuses: s.activeProject === projectId ? s.attachmentStatuses : {},
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
            early = null;
            closeSocket?.();
            closeSocket = null;
            readSeq.clear();
            set({ connected: false, live: emptyFold(), activeProject: undefined, sending: false, decidingId: null, revokingId: null, answeringQuestionIds: [], questionErrors: {}, busySuggestionIds: [], suggestionErrors: {}, busyLimitIds: [], limitErrors: {}, attachmentStatuses: {} });
          },

          async send(text, attachments = [], replyTo) {
            const body = text.trim();
            const projectId = get().activeProject;
            if ((!body && attachments.length === 0) || projectId === undefined || get().sending) return false;
            const key = keyOf(projectId);
            const gen = generation;
            // The person's row, at once (spec §4.2 "Optimistic user bubble"): renamed to the server's
            // id on the 202, or kept with the reason when the send fails.
            const localId = `local:${randomId(8)}`;
            const row: ChatMessage = {
              id: localId,
              conversation_id: get().conversations[key]?.conversation?.id ?? '',
              role: 'user',
              text: body,
              usage: null,
              error_code: null,
              created_at: new Date().toISOString(),
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(replyTo ? { reply_to: replyOnRow(replyTo) } : {}),
              local: 'sending',
            };
            set({ sending: true, error: null });
            patchSlot(key, (slot) => ({ messages: [...slot.messages, row] }));
            try {
              // A `409 ATTACHMENT_UNAVAILABLE` takes the generic path below: its pt-BR message is the server's.
              const accepted = await api.sendMessage(session().auth(), { text: body, project_id: projectId, ...(attachments.length > 0 ? { attachment_ids: attachments.map((a) => a.id) } : {}), ...(replyTo ? replyBody(replyTo) : {}) });
              if (gen !== generation) return false;
              // Accepted: the row exists on the server now, newer than any snapshot still in flight.
              arrivedDuringReads(key, accepted.user_message_id);
              patchSlot(key, (slot) => ({
                // The socket's echo may have landed first: then the local row simply goes; otherwise
                // it becomes the server's row where it is, and the echo merges into it by id.
                messages: slot.messages.some((m) => m.id === accepted.user_message_id)
                  ? slot.messages.filter((m) => m.id !== localId)
                  : slot.messages.map((m) => (m.id === localId ? { ...m, id: accepted.user_message_id, local: undefined } : m)),
              }));
              set({ sending: false });
              messageSent.emit();
              // Events no longer re-read the thread; with the socket down nothing else would show the answer.
              if (!get().connected) void reread(key);
              return true;
            } catch (e) {
              if (gen !== generation) return false;
              set({ sending: false });
              if (isApiError(e, 'CHAT_BUSY')) set({ error: CHAT_MSG.busy });
              else fail(gen, e);
              const why = get().error ?? (isApiError(e) ? e.message : CHAT_MSG.network);
              patchSlot(key, (slot) => ({ messages: slot.messages.map((m) => (m.id === localId ? { ...m, local: 'failed', local_error: why } : m)) }));
              return false;
            }
          },

          async retrySend(messageId) {
            const projectId = get().activeProject;
            // `send` refuses while another send is in flight: the failed row must not go before then.
            if (projectId === undefined || get().sending) return false;
            const key = keyOf(projectId);
            const row = get().conversations[key]?.messages.find((m) => m.id === messageId && m.local === 'failed');
            if (!row) return false;
            patchSlot(key, (slot) => ({ messages: slot.messages.filter((m) => m.id !== messageId) }));
            // A failed reply is sent again as the same reply: a local row's quote always names what it answers.
            return get().send(row.text, row.attachments, replyRefOfRow(row.reply_to));
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
                const card = get().conversations[key]?.actions.find((a) => a.id === actionId);
                // "Liberar sem prazo": the PIN sheet's title is the card's button label, kind included.
                const standingKind = word === 'approve_project_always' && card ? standingKindOf({ tool: card.tool, args: card.args, tab_id: card.tab_id, project_id: card.project_id }) : null;
                const title = standingKind ? `Liberar sem prazo: ${STANDING_KIND_LABEL[standingKind]} neste projeto` : undefined;
                const withPin = () => session().requestPinProof(actionId, (proof) => api.decide(session().auth(), actionId, { decision: word, ...proof }), word, title);
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
                  // The proof signs the decision word, so every grant word asks the PIN for exactly that.
                  await withPin();
                }
              }
              if (gen !== generation) return;
              // The `decision` event confirms it; this only saves a flicker back to "pending". Only a
              // card still pending moves: a re-read may already have it executed, failed or expired.
              patchSlot(key, (slot) => ({ actions: settlePending(slot.actions, actionId, decision === 'deny' ? 'denied' : 'approved') }));
              // The `grant`/`project_grant`/`standing_grant` event brings the new grant; the re-read puts
              // it on screen even if the socket is down.
              if (decision !== 'approve' && decision !== 'deny') void reread(key);
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
            const drop = () =>
              patchSlot(key, (slot) => ({
                grants: slot.grants.filter((g) => g.id !== grantId),
                projectGrants: slot.projectGrants.filter((g) => g.id !== grantId),
                standingGrants: slot.standingGrants.filter((g) => g.id !== grantId),
              }));
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

          async cancelAutoAnswer(questionId) {
            const projectId = get().activeProject;
            if (projectId === undefined || get().answeringQuestionIds.includes(questionId)) return;
            const key = keyOf(projectId);
            const gen = generation;
            set((s) => ({ answeringQuestionIds: [...s.answeringQuestionIds, questionId], questionErrors: without(s.questionErrors, questionId) }));
            try {
              const { tab_question } = await api.cancelAutoAnswer(session().auth(), questionId);
              if (gen === generation) patchSlot(key, (slot) => ({ tabQuestions: upsertTabQuestion(slot.tabQuestions, tab_question) }));
            } catch (e) {
              if (gen !== generation || isLocked(e) || session().handleApiError(e)) return;
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
            return actOnSuggestion(suggestionId, () => api.sendTabSuggestion(session().auth(), suggestionId, { text }));
          },

          dismissTabSuggestion(suggestionId) {
            return actOnSuggestion(suggestionId, () => api.dismissTabSuggestion(session().auth(), suggestionId));
          },

          answerTabLimit(limitId, accountId) {
            return answerLimit(limitId, accountId);
          },

          /**
           * "Cancelar" on a subagent's row (spec 2026-09-26 panel §5.4): a 409 (`SUBAGENT_NOT_RUNNING`
           * or `SUBAGENT_GONE` — already at rest, or its process gone) re-reads the trail, since the
           * server publishes no `subagent` event for that exact click. Any other failure (404 gone,
           * 5xx, a dropped connection) marks the row the same way a real `subagent_cancel_failed`
           * event would — the click did not go through, so it reads that way; the row itself is not
           * changed (nothing did). Real-time updates (the row turning `stopping`, or a genuine
           * `subagent_cancel_failed` after the server's own cancel timeout) arrive over the socket,
           * which the server call already publishes to, so this does not duplicate that state itself.
           */
          async cancelSubagent(subagentId) {
            const projectId = get().activeProject;
            if (projectId === undefined) return;
            const key = keyOf(projectId);
            const gen = generation;
            try {
              await api.cancelSubagent(session().auth(), subagentId);
            } catch (e) {
              if (gen !== generation || isLocked(e) || session().handleApiError(e)) return;
              if (isApiError(e) && e.status === 409) {
                void reread(key);
                return;
              }
              patchSlot(key, (slot) => ({ cancelFailed: slot.cancelFailed.includes(subagentId) ? slot.cancelFailed : [...slot.cancelFailed, subagentId] }));
            }
          },

          uploadAttachment(file, onProgress) {
            const projectId = get().activeProject;
            if (projectId === undefined) return Promise.reject(new Error('NO_CONVERSATION'));
            return api.uploadAttachment(session().auth(), file, projectId, onProgress).catch((e: unknown) => {
              // A revoked device or an expired session ends here like anywhere else; the chip shows the rest.
              session().handleApiError(e);
              throw e;
            });
          },

          deleteAttachment(id) {
            return api.deleteAttachment(session().auth(), id).catch((e: unknown) => {
              // Already gone, or already sent with a message: the chip goes either way.
              if (isApiError(e) && (e.status === 404 || e.status === 409)) return;
              throw e;
            });
          },

          async attachmentSource(id) {
            // `<Image>` fetches the url itself, so it never gets the client's TOKEN_EXPIRED retry. A
            // token that expired while the app slept (the renewal timer does not run in the
            // background) is renewed here first, through the session's single flight (TER-198).
            if (session().tokenStale()) await session().renewToken();
            return api.attachmentSource(session().auth(), id);
          },

          async forgetDecision(decisionId) {
            const gen = generation;
            try {
              await api.forgetChatDecision(session().auth(), decisionId);
            } catch (e) {
              // The card already cleared its pre-selection optimistically (it does so regardless
              // of this call's outcome — the server's own `DELETE` is idempotent, 204 even for a
              // decision already gone), so a non-session failure here is not "nothing happened" to
              // the user: it looks forgotten but may not be. A short banner says so; the server's
              // own message is not shown (there is no meaningful business-rule case here, unlike
              // `TAB_PROMPT_CHANGED` elsewhere). Session-ending errors still go to the session store.
              if (gen !== generation || isLocked(e)) return;
              if (session().handleApiError(e)) return;
              set({ error: CHAT_MSG.forgetDecisionFailed });
            }
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
              set({ live: emptyFold() });
              // A reset ends the old conversation's grants too — not the standing ones, which outlive it.
              patchSlot(key, () => ({ messages: [], actions: [], grants: [], projectGrants: [], tabQuestions: [], tabSuggestions: [], tabLimits: [], subagents: [], cancelFailed: [] }));
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
        storage,
        partialize: (s): Persisted => ({
          projects: s.projects,
          conversations: Object.fromEntries(
            // A row still in flight, or one that failed, is this device's alone: not worth a restart.
            Object.entries(s.conversations).map(([key, c]) => [
              key,
              { conversation: c.conversation, messages: c.messages.filter((m) => m.local === undefined), actions: c.actions, grants: c.grants, projectGrants: c.projectGrants, standingGrants: c.standingGrants, tabQuestions: c.tabQuestions, tabSuggestions: c.tabSuggestions, tabLimits: c.tabLimits, subagents: c.subagents, host: c.host },
            ]),
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
  appBackgrounded.subscribe(() => storage.flush());

  return store;
}
