import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChatActionCard } from './ChatActionCard';
import { ChatActionGroup, type BatchDecision } from './ChatActionGroup';
import { ChatComposer } from './ChatComposer';
import { ChatContextMeter } from './ChatContextMeter';
import { ChatHost } from './ChatHost';
import { ChatPendingBar } from './ChatPendingBar';
import { ChatSubagents } from './ChatSubagents';
import { ChatThread } from './ChatThread';
import { ChatTurn } from './ChatTurn';
import { TabQuestionCard } from './TabQuestionCard';
import { TabSuggestionCard } from './TabSuggestionCard';
import { TabLimitCard } from './TabLimitCard';
import { ConfirmDialog } from '../Modal';
import { api, ApiError } from '../../lib/api';
import { patchMessageAttachment } from '../../lib/attachments';
import { useChatStream } from '../../lib/chat';
import { compactDoneText, compactFailedText, isCompactCommand, isCompactShortcut } from '../../lib/chat-context';
import { useChatLive } from '../../lib/chat-live';
import { droppedRows, mergeMessage, mergeThread } from '../../lib/chat-merge';
import { replyTargetOf, replyTargetOfAction, replyTargetOfQuestion, type ReplyTarget } from '../../lib/chat-reply';
import { chatTimeline, groupPendingActions } from '../../lib/chat-timeline';
import { activeGrantsLabel } from './grant-list-text';
import { isGrantActive } from './grant-time';
import { isActive, upsertSubagent } from '../../lib/subagents';
import { PROMPT_CHANGED_TEXT, upsertTabQuestion } from './tab-question-text';
import { SUGGESTION_CHANGED_TEXT, upsertTabSuggestion } from './tab-suggestion-text';
import { useAuth } from '../../lib/auth';
import type { AiAccount, ChatAction, ChatAttachment, ChatDecisionWord, ChatEvent, ChatGrant, ChatHostMachine, ChatHostState, ChatMessage, ChatProjectGrant, ChatStandingGrant, SubagentView, TabQuestion, TabLimit, TabQuestionAnswer, TabSuggestion } from '../../lib/types';

/** How often the panel's elapsed labels ("há N min") refresh while it is open. */
const SUBAGENTS_REFRESH_MS = 30_000;

/**
 * Why the box refuses, one short line per host state — the long version is the card above the thread
 * (`ChatHost`). Every state that is not `ready` has one: a disabled composer must always say why.
 */
const COMPOSER_REASON: Record<Exclude<ChatHostState['kind'], 'ready'>, string> = {
  no_machine: 'cadastre uma máquina para conversar',
  not_chosen: 'escolha a máquina do chat',
  offline: 'a máquina do chat está offline',
  agent_too_old: 'atualize o agente da máquina',
};

/**
 * The four 409s a send (or a decision) comes back with when the host cannot run it. Each carries its
 * own pt-BR sentence, so nothing here composes one; what this set decides is that the answer was not a
 * failure of the click — the decision is already durably recorded server-side.
 */
const HOST_CODES = new Set(['CHAT_NO_MACHINE', 'CHAT_HOST_NOT_CHOSEN', 'CHAT_HOST_OFFLINE', 'CHAT_AGENT_TOO_OLD']);
/** How many early events (see `early` in the panel) are held while the conversation id is unknown. */
const EARLY_EVENTS_CAP = 500;
/** A run that could not even be attempted (`run_finished` with no message id): nobody awaits it, so the panel says it. */
const SETUP_FAILED_TEXT = 'O concierge não conseguiu começar a resposta. Tente de novo.';

/** A re-grant of the same kind on the same project replaces the older one, as on the server. */
const upsertStandingGrant = (prev: ChatStandingGrant[], grant: ChatStandingGrant): ChatStandingGrant[] => [
  ...prev.filter((g) => g.id !== grant.id && !(g.project_id === grant.project_id && g.kind === grant.kind)),
  grant,
];

/** A Claude account of one of the user's machines, as the host picker needs it. */
type HostAccountRow = Pick<AiAccount, 'id' | 'label' | 'machine_id'>;

/** Replaces the card with the same id, or appends it: the server sends the whole card each time. */
function upsertById<T extends { id: string }>(prev: T[], next: T): T[] {
  return prev.some((x) => x.id === next.id) ? prev.map((x) => (x.id === next.id ? next : x)) : [...prev, next];
}

/**
 * `TabSuggestionCard` takes `onSend(text)` and `onDismiss()` with no id (its body belongs to TER-96 and
 * is not changed here), so this wrapper makes the per-card closures once per id and hands the card
 * stable props: the panel passes the same two id-taking callbacks to every row.
 */
const TabSuggestionRow = memo(function TabSuggestionRow({
  suggestion,
  busy,
  error,
  onSend,
  onDismiss,
}: {
  suggestion: TabSuggestion;
  busy: boolean;
  error?: string;
  onSend: (id: string, text: string) => void;
  onDismiss: (id: string) => void;
}) {
  const id = suggestion.id;
  const send = useCallback((text: string) => onSend(id, text), [id, onSend]);
  const dismiss = useCallback(() => onDismiss(id), [id, onDismiss]);
  return <TabSuggestionCard suggestion={suggestion} busy={busy} error={error} onSend={send} onDismiss={dismiss} />;
});

/**
 * The concierge chat: streamed live over /ws/chat and persisted over REST. `projectId === null` is the
 * account-wide chat (`/chat`, where the host is chosen); a project id is that project's own chat,
 * always hosted on the account-wide conversation's machine — this panel never offers a picker for one,
 * only a pointer to `/chat`. The socket is per user and carries every one of these at once, so a panel
 * only ever renders the events of its own conversation (see `mine` below).
 */
export function ChatPanel({ projectId }: { projectId: string | null }) {
  /**
   * The signed-in user, and never the one an admin is "viewing as": the chat is strictly the signed-in
   * user's own (`request.scope.user`, not `request.scope.ownerId`), so this is what the machines and
   * accounts offered here have to belong to.
   */
  const { user, viewAs } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /**
   * The gate's action trail. Always sourced from `GET /api/chat` on load/reconnect — never rebuilt
   * from live events alone, which is what made it vanish on a reload before this task. A `confirmation`
   * event adds a card without waiting for a refetch; a `decision` event (possibly from another tab)
   * updates one by its id. Every row is keyed by its own `id`: a denial that lapsed leaves the old
   * decided row sitting beside a newer pending one for the very same proposal, so this must never
   * assume one row per proposal or per tool.
   */
  const [actions, setActions] = useState<ChatAction[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** A `queued: true` decision is not an error: the pt-BR note the server sent, shown under that card
   * until the next reload replaces it with the real, applied state. */
  const [queuedNotes, setQueuedNotes] = useState<Record<string, string>>({});
  /** "Ver separadas": the pending cards shown one by one instead of grouped, until the pending set changes. */
  const [separate, setSeparate] = useState(false);
  const [batchDeciding, setBatchDeciding] = useState(false);
  /** The conversation's trusted-tab grants, sourced the same way as `actions`: `GET /api/chat` on
   *  load/reconnect, kept live by `grant`/`grant_revoked` events. */
  const [grants, setGrants] = useState<ChatGrant[]>([]);
  /** The conversation's trusted-project grants ("Permitir sempre neste projeto"), sourced and kept
   *  live the same way as `grants`, through `project_grant`/`project_grant_revoked`. */
  const [projectGrants, setProjectGrants] = useState<ChatProjectGrant[]>([]);
  /** The user's standing grants ("Liberar sem prazo") on this conversation's project (all of them in the
   *  account-wide chat): from `GET /api/chat`, kept live by `standing_grant`/`standing_grant_revoked`.
   *  They never expire and are not bound to a conversation. */
  const [standingGrants, setStandingGrants] = useState<ChatStandingGrant[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  /** The tabs' questions of this conversation (spec 2026-09-25 §6.2), from `GET /api/chat` and the three events. */
  const [tabQuestions, setTabQuestions] = useState<TabQuestion[]>([]);
  const [answeringQuestionId, setAnsweringQuestionId] = useState<string | null>(null);
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>({});
  /** The tabs' suggestions of this conversation (spec 2026-09-25 tab suggestions §6.4), from `GET /api/chat` and their two events. */
  const [tabSuggestions, setTabSuggestions] = useState<TabSuggestion[]>([]);
  const [busySuggestionId, setBusySuggestionId] = useState<string | null>(null);
  const [suggestionErrors, setSuggestionErrors] = useState<Record<string, string>>({});
  const [tabLimits, setTabLimits] = useState<TabLimit[]>([]);
  const [busyLimitId, setBusyLimitId] = useState<string | null>(null);
  const [limitErrors, setLimitErrors] = useState<Record<string, string>>({});
  /** The subagents panel (spec 2026-09-26 §4): sourced from `GET /api/chat` like `actions`, kept live
   *  by `subagent` events. Recently-ended rows stay for a while (the server's own window), so the list
   *  can be non-empty with the toolbar button gone — only `active` (running/stopping) counts for that. */
  const [subagents, setSubagents] = useState<SubagentView[]>([]);
  /** Ids whose "Cancelar" came back with `subagent_cancel_failed`; cleared once a fresh `subagent` event for that id arrives. */
  const [cancelFailed, setCancelFailed] = useState<Set<string>>(new Set());
  /** The panel opens from the toolbar button and stays open across events until closed by hand. */
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  /** Refreshed every 30s while the panel is open, so "há N min" keeps moving without a re-render source of its own. */
  const [subagentsNow, setSubagentsNow] = useState(() => Date.now());
  /** Sends whose POST is still open (it answers once the message is stored). Several can be in flight:
   *  the box never waits for an answer (spec 2026-09-26). */
  const [inFlight, setInFlight] = useState(0);
  const sending = inFlight > 0;
  const [error, setError] = useState<string | null>(null);
  /**
   * The latest `attachment_status` heard for each attachment of this conversation, by id. The thread
   * takes the event straight into its message (`patchMessageAttachment`); the composer's chips take it
   * from here, since a chip's file has no message yet. Small rows, one per attachment of this
   * session: never pruned, and nothing reads it but the composer.
   */
  const [attachmentStatuses, setAttachmentStatuses] = useState<Record<string, ChatAttachment>>({});
  /** How full the session is (TER-315), from `GET /api/chat` and the `context` event; null until an
   *  answer reports it. */
  const [context, setContext] = useState<{ tokens: number; window: number | null } | null>(null);
  /** "Compactar" is under way: from the click (or `GET /api/chat`, for a screen opened meanwhile) until
   *  its `compact` event says done or failed. */
  const [compacting, setCompacting] = useState(false);
  /** What the last compaction did, in the composer's status line until the next message goes. */
  const [compactNote, setCompactNote] = useState<string | null>(null);

  /**
   * Which machine and which account run this conversation, or why none can — resolved by the server on
   * every `GET /api/chat` and never re-derived here. `null` only until the first read answers: an older
   * server that does not send it simply shows no host line rather than an invented one.
   */
  const [host, setHost] = useState<ChatHostState | null>(null);
  /** The change picker is open. Nothing has been changed while it is: the warning is read first. */
  const [picking, setPicking] = useState(false);
  /** The machines to change to, read only when the change is asked for (`not_chosen` brings its own). */
  const [hostMachines, setHostMachines] = useState<ChatHostMachine[] | null>(null);
  /**
   * Every Claude account of the user's machines, read beside the machines and filtered per host below.
   * `'error'` when that read failed on its own — `ai_accounts` is a resource of its own in the
   * permission matrix, so a role that can change the chat's machine may still not be allowed to read a
   * machine's logins, and that must cost the account half of the picker and nothing more.
   */
  const [hostAccounts, setHostAccounts] = useState<HostAccountRow[] | 'error' | null>(null);
  /**
   * The account stored on the conversation — the raw column, not a resolved state: it is what says which
   * option in the picker is the current one, and an id that no longer names an account of the host
   * machine (the `lost` state the server resolves) matches none of them, which is the right answer too.
   */
  const [hostAccountId, setHostAccountId] = useState<string | null>(null);
  const [changingHost, setChangingHost] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);

  /**
   * The machine hosting the conversation right now, or `null` when there is none: the account half of
   * the pair only means anything on a machine, and it is that machine's logins that may be chosen.
   */
  const hostMachineId = host && (host.kind === 'ready' || host.kind === 'offline' || host.kind === 'agent_too_old') ? host.machine.id : null;

  /**
   * Whether `GET /api/chat` has ever answered. Only the empty state reads it: without it, opening a
   * long conversation shows "peça algo…" over an empty thread until the fetch resolves, and a fetch
   * that fails leaves that line on screen for ever.
   */
  const [loaded, setLoaded] = useState(false);

  /**
   * The conversation this panel shows. Live events of any other one — the account-wide chat and every
   * project chat share one socket per user — are dropped, so two open chats never mix their answers.
   * Before the first `GET /chat` resolves, `conversationId` is still null and this panel does not yet
   * know which conversation is its own: a tagged event is dropped rather than admitted on that
   * uncertainty (a panel just opened while another chat is mid-answer must never flash that chat's
   * deltas or cards). `load()` re-reads the trail over REST regardless, so nothing tagged is lost for good —
   * only an untagged event (`conversation_id === undefined`, an older server) is let through unknown,
   * because there is no id it could ever be checked against.
   */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const mine = useCallback((e: ChatEvent) => e.conversation_id === undefined || e.conversation_id === conversationId, [conversationId]);

  /**
   * What has streamed for each answer being written (text, tool chips, whether the run showed a sign
   * of life), folded in one event at a time, and which answers are closed for good. `version` moves on
   * every change, which is what re-renders this panel for a delta; the rows themselves are read through
   * `fold.get` while rendering. `seed` marks the answers `GET /api/chat` lists as open; `clear` forgets
   * everything when another conversation takes the screen.
   */
  const { fold, version, push, seed, clear, closeRows } = useChatLive();
  /** The conversation whose thread is on screen, as `load` last read it: a re-read of the same one merges. */
  const shown = useRef<string | null>(null);
  /**
   * One set per read of the conversation in flight, filled with the ids whose `message` event reached
   * the panel meanwhile: those rows are newer than the snapshot, and a row it lacks is kept only if it
   * is one of them. Two reads can overlap (a reconnect and a send), so each has its own set.
   */
  const reads = useRef(new Set<Set<string>>());
  /** The thread as last committed: what a re-read compares with to know which rows it drops. */
  const thread = useRef<ChatMessage[]>([]);
  useLayoutEffect(() => {
    thread.current = messages;
  }, [messages]);

  const load = useCallback(async () => {
    // No project = the account-wide chat: called with no argument, because the response must be
    // `request<...>('GET', '/chat')` exactly — a server that predates project chats knows nothing else.
    const arrived = new Set<string>();
    reads.current.add(arrived);
    const { conversation, messages, open_answer_ids, actions, host, grants, project_grants, standing_grants, tab_questions, tab_suggestions, tab_limits, subagents, compacting } = await (projectId ? api.chat(projectId) : api.chat()).finally(() => reads.current.delete(arrived));
    // The same conversation: the snapshot merges into the thread, so a row that ended or was removed
    // while this read was in flight is not brought back, and a row the server deleted leaves and is
    // closed (its started mark must not outlive it). Another one (a reset, another project) replaces
    // the thread, and what was known about the old rows goes with it. On the very first read the fold
    // holds only what this conversation streamed (tagged events wait in `early`), so it is kept.
    const first = shown.current === null;
    const same = shown.current === conversation.id;
    shown.current = conversation.id;
    if (!same && !first) clear();
    const removed = fold.removed();
    // A row the snapshot shows answered (text or an error) carries its answer now: what streamed for
    // it goes and it is closed, with the dropped ones — the phone's `pruneLive`.
    if (same) closeRows([...droppedRows(thread.current, messages, arrived), ...messages.filter((m) => m.role === 'assistant' && (m.text || m.error_code)).map((m) => m.id)]);
    setMessages((prev) => (same ? mergeThread(prev, messages, removed, arrived) : messages));
    // An older server sends no list: nothing is seeded, and an empty row counts as started only on a sign of life.
    seed(open_answer_ids ?? []);
    setActions(actions ?? []);
    setGrants(grants ?? []);
    setProjectGrants(project_grants ?? []);
    setStandingGrants(standing_grants ?? []);
    setTabQuestions(tab_questions ?? []);
    setTabSuggestions(tab_suggestions ?? []);
    setTabLimits(tab_limits ?? []);
    setSubagents(subagents ?? []);
    setHost(host ?? null);
    setHostAccountId(conversation.ai_account_id ?? null);
    setContext(typeof conversation.context_tokens === 'number' ? { tokens: conversation.context_tokens, window: conversation.context_window ?? null } : null);
    setCompacting(compacting === true);
    setConversationId(conversation.id);
    setLoaded(true);
  }, [projectId, fold, seed, clear, closeRows]);

  useEffect(() => {
    // A project deleted in another tab, or any other read failure, must not leave an unhandled
    // rejection and a silently empty panel: `loaded` stays false (no "peça algo…" over a conversation
    // that never opened) and the error line the panel already has for sends says why.
    load().catch((e) => setError(e instanceof ApiError ? e.message : 'Não foi possível abrir a conversa'));
  }, [load]);

  /**
   * Live events tagged with a conversation id that arrived before this panel knew its own. Held, not
   * dropped: `load()` re-reads everything a REST read can give back, but the deltas and tool calls of
   * an answer already under way exist nowhere else. Replayed through `applyOwn` (the fold and the
   * thread) the moment `conversationId` is known — the ones of another conversation are dropped then. A layout
   * effect, not a passive one: `onEvent` below stops holding as soon as the id is in state, so a delta
   * arriving between that commit and a passive effect's flush would be folded in ahead of the held ones.
   */
  const early = useRef<ChatEvent[]>([]);

  /** One event of this conversation, live or held: the fold takes what is its business, the thread the rest. */
  const applyOwn = useCallback(
    (e: ChatEvent) => {
      push(e);
      if (e.type === 'message') {
        // Newer than every read in flight: none of them may drop it for lacking it.
        for (const arrived of reads.current) arrived.add(e.message.id);
        setMessages((prev) => mergeMessage(prev, e.message));
      } else if (e.type === 'message_removed') setMessages((prev) => (prev.some((m) => m.id === e.message_id) ? prev.filter((m) => m.id !== e.message_id) : prev));
      else if (e.type === 'run_finished' && e.message_id === null && !e.ok) {
        // The run could not even be attempted, and nobody awaits it any more: this is where it is said.
        setError(SETUP_FAILED_TEXT);
        void load().catch(() => undefined);
      }
    },
    [push, load],
  );

  useLayoutEffect(() => {
    if (conversationId === null) return;
    const held = early.current;
    early.current = [];
    // Through the same path as a live event, not into the fold alone: a held final `message` or
    // `message_removed` is newer than the snapshot `load` just put on screen, and the thread must take it.
    for (const e of held) if (e.conversation_id === conversationId) applyOwn(e);
  }, [conversationId, applyOwn]);

  // A `message` event carries the stored row (the user's message, the announced empty answer, or the
  // final text): it is merged in place by id — no refetch, so no row gets a new object for nothing and
  // the streamed text is never swapped out for a moment. A reconnect and a finished `send()` still
  // re-read the whole conversation over REST, as before.
  const onEvent = useCallback(
    (e: ChatEvent) => {
      if (conversationId === null && e.conversation_id !== undefined) {
        early.current = [...early.current.slice(-(EARLY_EVENTS_CAP - 1)), e];
        return;
      }
      // A standing grant is not bound to a conversation: its events are tagged with the one that
      // created it, but they apply to every panel that shows it — the same set `GET /api/chat` returns
      // (this project's, or all of them in the account-wide chat); a revoke is simply applied by id.
      if (e.type === 'standing_grant_revoked') {
        setStandingGrants((prev) => prev.filter((g) => g.id !== e.grant_id));
        return;
      }
      if (e.type === 'standing_grant') {
        if (!projectId || e.grant.project_id === projectId) setStandingGrants((prev) => upsertStandingGrant(prev, e.grant));
        return;
      }
      if (!mine(e)) return;
      // The fold takes what is its business (deltas, tool calls, resets, run starts and ends, removals),
      // the thread the stored rows and the removals.
      applyOwn(e);
      if (e.type === 'confirmation') {
        // Enriched server-side exactly like GET /api/chat's trail (same summary, same ids): no name
        // is resolved and no sentence is built here. A repeated event for an id already on screen is
        // the live run telling us which subagent proposed it after the card was already published
        // with none, or the card brought back to the end of the chat (`resurfaced`, TER-477, with a
        // new `surfaced_at`) — merged in, never re-added.
        setActions((prev) =>
          prev.some((a) => a.id === e.action_id)
            ? prev.map((a) => (a.id === e.action_id ? { ...a, ...(e.subagent ? { subagent: e.subagent } : {}), ...(e.surfaced_at ? { surfaced_at: e.surfaced_at } : {}) } : a))
            : [...prev, { id: e.action_id, tool: e.tool, args: e.args, class: e.class, status: 'pending', machine_id: e.machine_id, project_id: e.project_id, tab_id: e.tab_id, summary: e.summary, subagent: e.subagent, created_at: e.created_at, surfaced_at: e.surfaced_at ?? null }],
        );
      } else if (e.type === 'decision') {
        // Someone answered — possibly in another open tab. Keyed on the action id alone.
        setActions((prev) => prev.map((a) => (a.id === e.action_id ? { ...a, status: e.status } : a)));
      } else if (e.type === 'action_status') {
        // The gate ran it, or it failed or went stale (TER-477): the card reads so without a reload. An
        // id not on screen (outside the loaded window) is left to the next read.
        setActions((prev) => (prev.some((a) => a.id === e.action_id) ? prev.map((a) => (a.id === e.action_id ? { ...a, status: e.status, error_code: e.error_code } : a)) : prev));
      } else if (e.type === 'grant') setGrants((prev) => [...prev.filter((g) => g.id !== e.grant.id && !(g.tab_id === e.grant.tab_id && g.tool === e.grant.tool)), e.grant]);
      else if (e.type === 'grant_revoked') setGrants((prev) => prev.filter((g) => g.id !== e.grant_id));
      else if (e.type === 'project_grant') setProjectGrants((prev) => [...prev.filter((g) => g.id !== e.grant.id && g.project_id !== e.grant.project_id), e.grant]);
      else if (e.type === 'project_grant_revoked') setProjectGrants((prev) => prev.filter((g) => g.id !== e.grant_id));
      else if (e.type === 'granted_action') setActions((prev) => (prev.some((a) => a.id === e.action.id) ? prev.map((a) => (a.id === e.action.id ? e.action : a)) : [...prev, e.action]));
      else if (e.type === 'tab_question' || e.type === 'tab_question_answered' || e.type === 'tab_question_closed') setTabQuestions((prev) => upsertTabQuestion(prev, e.question));
      else if (e.type === 'tab_suggestion' || e.type === 'tab_suggestion_closed') setTabSuggestions((prev) => upsertTabSuggestion(prev, e.suggestion));
      else if (e.type === 'tab_limit' || e.type === 'tab_limit_closed') setTabLimits((prev) => upsertById(prev, e.notice));
      else if (e.type === 'attachment_status') {
        // Into the message that carries it (no refetch: only that row gets a new object) and into the
        // composer's chips, for a file uploaded but not yet sent.
        setMessages((prev) => patchMessageAttachment(prev, e.attachment));
        setAttachmentStatuses((prev) => ({ ...prev, [e.attachment.id]: e.attachment }));
      } else if (e.type === 'subagent') {
        setSubagents((prev) => upsertSubagent(prev, e.subagent));
        // Whatever this row is now, a stale "Cancelar" failure from before no longer applies.
        setCancelFailed((prev) => (prev.has(e.subagent.id) ? new Set([...prev].filter((id) => id !== e.subagent.id)) : prev));
      } else if (e.type === 'subagent_cancel_failed') setCancelFailed((prev) => new Set(prev).add(e.subagent_id));
      else if (e.type === 'context') setContext({ tokens: e.tokens, window: e.window });
      else if (e.type === 'compact') {
        // Every open screen of this conversation hears it, not only the one that clicked.
        setCompacting(e.state === 'started');
        if (e.state === 'done') setCompactNote(compactDoneText(e.tokens_before, e.tokens));
        else if (e.state === 'failed') setError(compactFailedText(e.error_code));
      }
    },
    [conversationId, mine, applyOwn, projectId],
  );
  const { connected } = useChatStream(load, onEvent);

  const decide = useCallback(async (id: string, decision: ChatDecisionWord) => {
    setDecidingId(id);
    setActionError(null);
    try {
      const res = await api.decideChatAction(id, decision);
      // The response's `action` is the raw decided row, not the enriched card (no `summary`): only
      // its status is applied, keeping the card's already-known summary and other fields as they are.
      setActions((prev) => prev.map((a) => (a.id === id ? { ...a, status: res.action.status } : a)));
      if (res.queued && res.note) setQueuedNotes((prev) => ({ ...prev, [id]: res.note! }));
      // A re-grant for the same tab and tool replaces the older one, as on the server (a narrow grant
      // never drops an active terminal one; widening revokes the narrow one via `grant_revoked`).
      if (res.grant) setGrants((prev) => [...prev.filter((g) => g.id !== res.grant!.id && !(g.tab_id === res.grant!.tab_id && g.tool === res.grant!.tool)), res.grant!]);
      // A re-grant for the same project replaces the older one, as on the server.
      if (res.project_grant) setProjectGrants((prev) => [...prev.filter((g) => g.id !== res.project_grant!.id && g.project_id !== res.project_grant!.project_id), res.project_grant!]);
      if (res.standing_grant) setStandingGrants((prev) => upsertStandingGrant(prev, res.standing_grant!));
    } catch (e) {
      // A host that cannot run the answer right now (offline, most often) answers this with its own
      // 409 — but `decide` already recorded the decision before that throw, and the server injects it
      // the next time the conversation runs. So it reads as what it is: answered, and waiting on the
      // machine. Anything else really did fail.
      if (e instanceof ApiError && e.code !== undefined && HOST_CODES.has(e.code)) {
        const status = decision === 'deny' ? 'denied' : 'approved';
        setActions((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
        setQueuedNotes((prev) => ({ ...prev, [id]: `${e.message} A decisão já está registrada e será aplicada quando o chat voltar a rodar.` }));
        // …and the host line above the thread must agree with that sentence. The grant itself (for
        // approve_tab) was only created if the server got that far before the busy/offline answer;
        // this re-read is what brings it in when it was.
        await load();
      } else setActionError(e instanceof ApiError ? e.message : 'Não foi possível registrar a decisão');
    } finally {
      setDecidingId(null);
    }
  }, [load]);

  /** A grouped confirmation: one request, one injected sentence (spec 2026-09-26 §7). Stable, like `decide`. */
  const decideBatch = useCallback(async (decisions: BatchDecision[]) => {
    setBatchDeciding(true);
    setActionError(null);
    try {
      const res = await api.decideChatActions(decisions);
      const statusOf = new Map(res.actions.map((a) => [a.id, a.status]));
      setActions((prev) => prev.map((a) => (statusOf.has(a.id) ? { ...a, status: statusOf.get(a.id)! } : a)));
      // One note for the whole batch, under its first decided card.
      const first = res.actions[0]?.id;
      if (res.queued && res.note && first) setQueuedNotes((prev) => ({ ...prev, [first]: res.note! }));
    } catch (e) {
      // As in `decide`: a host that cannot run the answer right now still had every decision recorded first.
      if (e instanceof ApiError && e.code !== undefined && HOST_CODES.has(e.code)) {
        const statusOf = new Map(decisions.map((d) => [d.id, d.decision === 'deny' ? ('denied' as const) : ('approved' as const)]));
        setActions((prev) => prev.map((a) => (statusOf.has(a.id) ? { ...a, status: statusOf.get(a.id)! } : a)));
        const first = decisions[0]?.id;
        if (first) setQueuedNotes((prev) => ({ ...prev, [first]: `${e.message} A decisão já está registrada e será aplicada quando o chat voltar a rodar.` }));
        await load();
      } else setActionError(e instanceof ApiError ? e.message : 'Não foi possível registrar as decisões');
    } finally {
      setBatchDeciding(false);
    }
  }, [load]);

  const onDecideBatch = useCallback((d: BatchDecision[]) => void decideBatch(d), [decideBatch]);
  /** "Aprovar as reversíveis" in the pending bar (TER-477): the group card's batch call, with only those ids. */
  const approveReversible = useCallback((ids: string[]) => void decideBatch(ids.map((id) => ({ id, decision: 'approve' }))), [decideBatch]);
  const onShowSeparately = useCallback(() => setSeparate(true), []);

  /** "Revogar", from the card that granted it — a tab, project or standing grant, this call does not
   *  care which: it drops the id from every list, since only one of them will ever have it. Stable:
   *  every card gets this same one. */
  const revoke = useCallback(async (grantId: string) => {
    setRevokingId(grantId);
    setActionError(null);
    try {
      await api.revokeChatGrant(grantId);
      setGrants((prev) => prev.filter((g) => g.id !== grantId));
      setProjectGrants((prev) => prev.filter((g) => g.id !== grantId));
      setStandingGrants((prev) => prev.filter((g) => g.id !== grantId));
    } catch (e) {
      // 409: it was already revoked (another tab, or it expired and a reset ended it) — the list is
      // stale, not wrong.
      if (e instanceof ApiError && e.status === 409) {
        setGrants((prev) => prev.filter((g) => g.id !== grantId));
        setProjectGrants((prev) => prev.filter((g) => g.id !== grantId));
        setStandingGrants((prev) => prev.filter((g) => g.id !== grantId));
      } else setActionError(e instanceof ApiError ? e.message : 'Não foi possível revogar a permissão');
    } finally {
      setRevokingId(null);
    }
  }, []);

  /** A click on a tab question's card is the answer: no confirmation, no model turn. */
  const answerQuestion = useCallback(async (id: string, body: TabQuestionAnswer) => {
    setAnsweringQuestionId(id);
    setQuestionErrors(({ [id]: _dropped, ...rest }) => rest);
    try {
      const { tab_question } = await api.answerTabQuestion(id, body);
      setTabQuestions((prev) => upsertTabQuestion(prev, tab_question));
    } catch (e) {
      const text = e instanceof ApiError && e.code === 'TAB_PROMPT_CHANGED' ? PROMPT_CHANGED_TEXT : e instanceof ApiError ? e.message : 'Não foi possível responder';
      setQuestionErrors((prev) => ({ ...prev, [id]: text }));
    } finally {
      setAnsweringQuestionId(null);
    }
  }, []);
  /** "Cancelar" on a countdown (spec 2026-09-26 concierge memory §6): nothing is sent, the proposed
   *  answer stays on the card as its own pre-selection. 409 `NOT_SCHEDULED` — the countdown already sent,
   *  or someone else cancelled it first — gets its own sentence; anything else is the server's message,
   *  same as `answerQuestion` above. */
  const cancelAutoAnswer = useCallback(async (id: string) => {
    setAnsweringQuestionId(id);
    setQuestionErrors(({ [id]: _dropped, ...rest }) => rest);
    try {
      const { tab_question } = await api.cancelAutoAnswer(id);
      setTabQuestions((prev) => upsertTabQuestion(prev, tab_question));
    } catch (e) {
      const text = e instanceof ApiError && e.code === 'NOT_SCHEDULED' ? 'A resposta automática já foi enviada.' : e instanceof ApiError ? e.message : 'Não foi possível cancelar';
      setQuestionErrors((prev) => ({ ...prev, [id]: text }));
    } finally {
      setAnsweringQuestionId(null);
    }
  }, []);
  /** Stable, so the permission card's effect runs once per question. */
  const loadTabQuestionScreen = useCallback(async (id: string) => (await api.tabQuestionScreen(id)).text, []);

  /** "Esquecer esta decisão" on a suggestion line: hard delete, 204 even if it is already gone — the
   *  card clears its own pre-selection regardless (see `TabQuestionCard`), so a failure here is not
   *  worth a card-wide error line for what is, either way, best effort. */
  const forgetDecision = useCallback(async (decisionId: string) => {
    try {
      await api.forgetChatDecision(decisionId);
    } catch {
      // best effort: the card already cleared its pre-selection, and the memory page (if open) will
      // show the true state on its own next read
    }
  }, []);

  /** Enviar / Dispensar on a suggestion card: one click, no confirmation, no model turn. */
  const actOnSuggestion = useCallback(async (id: string, act: () => Promise<{ tab_suggestion: TabSuggestion }>, fallback: string) => {
    setBusySuggestionId(id);
    setSuggestionErrors(({ [id]: _dropped, ...rest }) => rest);
    try {
      const { tab_suggestion } = await act();
      setTabSuggestions((prev) => upsertTabSuggestion(prev, tab_suggestion));
    } catch (e) {
      const text = e instanceof ApiError && e.code === 'TAB_PROMPT_CHANGED' ? SUGGESTION_CHANGED_TEXT : e instanceof ApiError ? e.message : fallback;
      setSuggestionErrors((prev) => ({ ...prev, [id]: text }));
    } finally {
      setBusySuggestionId(null);
    }
  }, []);
  const sendSuggestion = useCallback((id: string, text: string) => void actOnSuggestion(id, () => api.sendTabSuggestion(id, text), 'Não foi possível enviar'), [actOnSuggestion]);
  const dismissSuggestion = useCallback((id: string) => void actOnSuggestion(id, () => api.dismissTabSuggestion(id), 'Não foi possível dispensar'), [actOnSuggestion]);

  /** A usage-limit card (TER-589): "Trocar para X" swaps the tab, "Esperar" closes the card. A failed swap keeps it open. */
  const answerLimit = useCallback(async (id: string, accountId: string | null) => {
    setBusyLimitId(id);
    setLimitErrors(({ [id]: _dropped, ...rest }) => rest);
    try {
      const { tab_limit } = await api.answerTabLimit(id, accountId);
      setTabLimits((prev) => upsertById(prev, tab_limit));
    } catch (e) {
      setLimitErrors((prev) => ({ ...prev, [id]: e instanceof ApiError ? e.message : 'Não foi possível trocar a conta' }));
    } finally {
      setBusyLimitId(null);
    }
  }, []);
  const onAnswerLimit = useCallback((id: string, accountId: string | null) => void answerLimit(id, accountId), [answerLimit]);

  /**
   * "Cancelar" on a subagent's row (spec 2026-09-26 §4): a 409 (already at rest) re-reads the trail,
   * since the server publishes no `subagent` event for that case. Any other failure (404 gone, 5xx, a
   * dropped connection) gets the same treatment as a real `subagent_cancel_failed`: the row is not
   * updated (nothing changed), but the click itself did not go through, so it reads that way.
   */
  const cancelSubagent = useCallback(
    async (id: string) => {
      try {
        await api.cancelSubagent(id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) await load();
        else setCancelFailed((prev) => new Set(prev).add(id));
      }
    },
    [load],
  );
  /** Only running/stopping rows count for the toolbar button: an ended one may still sit in the list
   *  (the server keeps it a while for "levou N min"), but it is not what the button is counting. */
  const activeSubagents = useMemo(() => subagents.filter(isActive), [subagents]);
  /** "há N min" keeps moving while the panel is open; closed, there is nobody to refresh it for. It is
   *  refreshed the moment the panel opens too, or it would show the time of the last open (or mount). */
  useEffect(() => {
    if (!subagentsOpen) return;
    setSubagentsNow(Date.now());
    const id = setInterval(() => setSubagentsNow(Date.now()), SUBAGENTS_REFRESH_MS);
    return () => clearInterval(id);
  }, [subagentsOpen]);
  /** The toggle button and the popover it opens, so Escape/outside-click can tell "inside" from "outside"
   *  and hand focus back — same pattern as `ProjectGroupsMenu`. */
  const subagentsToggleRef = useRef<HTMLButtonElement>(null);
  const subagentsPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!subagentsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setSubagentsOpen(false);
      subagentsToggleRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (subagentsPanelRef.current?.contains(t) || subagentsToggleRef.current?.contains(t)) return;
      setSubagentsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [subagentsOpen]);

  /**
   * Opens the change picker and reads the two halves of the pair, once, on demand: they are only needed
   * by someone who asked to change the host. Only agent machines can host a conversation (the server
   * refuses the others), so only those are offered — and only machines of the signed-in user's own:
   * `GET /machines` follows the admin "view as" scope, while `POST /chat/host` is strictly self-scoped,
   * so anything else here would be offered and then answered 404.
   *
   * The accounts are read whole and filtered per machine below, so changing the machine does not need a
   * second request; `not_chosen` brings its own machines but no accounts, and has no host to have them on.
   *
   * The two reads are sequential and answered separately on purpose. `ai_accounts` is its own resource
   * in the permission matrix: read together, a role without `ai_accounts:read` could no longer change
   * the chat's *machine* at all — including when the host is offline and this picker is the only way
   * out. So the machines decide whether the picker opens, and the accounts only decide whether its
   * second half has a list.
   */
  const openPicker = async () => {
    setPicking(true);
    setHostError(null);
    if (hostMachines !== null) return;
    let own: Set<string>;
    try {
      const { machines } = await api.machines.list();
      own = new Set(machines.filter((m) => m.owner_id === user?.id).map((m) => m.id));
      setHostMachines(machines.filter((m) => m.type === 'agent' && own.has(m.id)).map((m) => ({ id: m.id, name: m.name })));
    } catch (e) {
      // The picker closes again: left open it would say "carregando…" over a list that is never coming.
      // The reason stays on screen, and the button that opened it is how it is tried again.
      setPicking(false);
      setHostError(e instanceof ApiError ? e.message : 'Não foi possível ler as suas máquinas');
      return;
    }
    try {
      const { accounts } = await api.aiAccounts.list();
      // The chat runs on Claude, so a login for another provider is not an option here.
      setHostAccounts(accounts.filter((a) => a.provider === 'claude' && own.has(a.machine_id)).map((a) => ({ id: a.id, label: a.label, machine_id: a.machine_id })));
    } catch {
      // Said as what it is, next to a machine list that still works — never as "this machine has no
      // other account", which is a claim about the machine and not about a read that was refused.
      setHostAccounts('error');
    }
  };

  /**
   * Sets the host pair — only ever from a click on the button that named what it changes to, which is
   * why the warning about the fresh session (spec §3) has already been read by the time this runs.
   * Machine and account travel in the same call, because they are one pair: choosing a machine sends no
   * account, since an account belongs to a machine and a new host starts on that machine's own default
   * Claude login; choosing an account keeps the machine it belongs to.
   */
  const chooseHost = async (machineId: string, aiAccountId: string | null = null) => {
    setChangingHost(true);
    setHostError(null);
    try {
      const { conversation, host: next } = await api.setChatHost(machineId, aiAccountId);
      setHost(next);
      setHostAccountId(conversation.ai_account_id ?? null);
      setPicking(false);
      // The server may have started a fresh CLI session; the transcript is ours and survives, so this
      // re-read is what brings the conversation back exactly as it is now stored.
      await load();
    } catch (e) {
      setHostError(e instanceof ApiError ? e.message : 'Não foi possível trocar a máquina ou a conta do chat');
    } finally {
      setChangingHost(false);
    }
  };

  /** Messages, gate cards and tab questions as one chronological thread, so a card reads where it was proposed. */
  const timeline = useMemo(() => chatTimeline(messages, actions, tabQuestions, tabSuggestions, tabLimits), [messages, actions, tabQuestions, tabSuggestions, tabLimits]);
  /** "Ver separadas" holds only for the cards it was clicked on: a new or decided card groups again. */
  const pendingKey = actions
    .filter((a) => a.status === 'pending')
    .map((a) => a.id)
    .join(',');
  useEffect(() => setSeparate(false), [pendingKey]);
  const entries = useMemo(() => (separate ? timeline : groupPendingActions(timeline)), [separate, timeline]);
  /**
   * The row a running answer would be written into: only the newest one can still be the live one.
   * Keyed on the id, not on a position: the loop below walks the merged timeline, where an index
   * counts cards too and so no longer means "the newest message" — turning this back into
   * `index === messages.length - 1` would put "pensando…" on the wrong row.
   */
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;

  /**
   * The active grant each gate card created, by the card's id: built once per `grants` change instead
   * of a `find` over the list inside every card of every render. (Expiry is re-read when `grants` next
   * changes, which is what the old per-render `find` did too whenever nothing re-rendered.) A grant
   * with no source action (`null`) was never a card's, so it is left out.
   */
  const grantByAction = useMemo(() => {
    const map = new Map<string, ChatGrant>();
    for (const g of grants) if (g.source_action_id !== null && isGrantActive(g)) map.set(g.source_action_id, g);
    return map;
  }, [grants]);
  /** Same idea as `grantByAction`, for the project grants a board card created. */
  const projectGrantByAction = useMemo(() => {
    const map = new Map<string, ChatProjectGrant>();
    for (const g of projectGrants) if (g.source_action_id !== null && isGrantActive(g)) map.set(g.source_action_id, g);
    return map;
  }, [projectGrants]);
  /** Same idea again, for the standing grant a card created ("Liberar sem prazo"); these never expire. */
  const standingGrantByAction = useMemo(() => {
    const map = new Map<string, ChatStandingGrant>();
    for (const g of standingGrants) if (g.source_action_id !== null) map.set(g.source_action_id, g);
    return map;
  }, [standingGrants]);

  /** What the thread's pin follows: a new row or card (the timeline) or a streamed delta (the fold). */
  const followKey = useMemo(() => ({ timeline, version }), [timeline, version]);
  /**
   * Whether the thread follows new content. `ChatThread` owns the reading of it (its `onScroll` and its
   * pill write it); it lives here so `send` can set it — sending is the reader's own way of saying
   * "take me to the bottom".
   */
  const stick = useRef(true);
  /** `compact` below, for `send`: typing `/compact` runs it (declared after `send`, which it needs nothing from). */
  const compactRef = useRef<() => Promise<void>>(async () => undefined);

  /**
   * The composer's `onSend`: the text and the ids of its uploaded chips are the composer's own (it
   * empties itself when it calls this and takes them back on `false`). A message may be attachments
   * alone (spec §3); one with neither is refused here as well as by the button. Never refused for
   * another send in flight: several can be (spec 2026-09-26). The POST returns as soon as the message
   * is stored; the answer streams over the socket.
   */
  /** The message (TER-447) or card (TER-849) the next send answers; dropped with the conversation. */
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  /** The row a quote just scrolled to, ringed for a moment. */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => setReplyTo(null), [projectId, conversationId]);
  useEffect(() => {
    if (highlightId === null) return;
    const timer = window.setTimeout(() => setHighlightId(null), 1500);
    return () => window.clearTimeout(timer);
  }, [highlightId]);
  const startReply = useCallback((m: ChatMessage) => setReplyTo(replyTargetOf(m)), []);
  // A confirmation or a tab's question is answered the same way (TER-849).
  const startActionReply = useCallback((a: ChatAction) => setReplyTo(replyTargetOfAction(a)), []);
  const startQuestionReply = useCallback((q: TabQuestion) => setReplyTo(replyTargetOfQuestion(q)), []);
  const cancelReply = useCallback(() => setReplyTo(null), []);
  /** A quote's click: the original, if this thread has it, is brought to the middle and ringed. */
  const openReply = useCallback((id: string): boolean => {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    // A card's quote (TER-849) finds its card the way the pending bar does.
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-message-id="${escaped}"], [data-chat-card="${escaped}"]`);
    if (!row) return false;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightId(id);
    return true;
  }, []);

  const send = useCallback(
    async (value: string, attachmentIds: string[], replyToId?: string): Promise<boolean> => {
      if (!value && attachmentIds.length === 0) return false;
      // `/compact` alone is the command, as in Claude Code: it compacts, and nothing is sent.
      if (attachmentIds.length === 0 && isCompactCommand(value)) {
        void compactRef.current();
        return true;
      }
      setCompactNote(null);
      // The preview goes with the text, at once, and comes back with it if the send fails.
      const quoted = replyToId ? replyTo : null;
      if (quoted) setReplyTo(null);
      // Sending is the reader's own way of saying "take me to the bottom" — the answer will stream
      // in below whatever they typed.
      stick.current = true;
      setInFlight((n) => n + 1);
      setError(null);
      try {
        // No project = the account-wide chat: called with no second argument, for the same reason as
        // `load` above. The three-argument form only when there is something to carry in it.
        if (replyToId) await api.sendChatMessage(value, projectId, attachmentIds, quoted?.card ? { kind: quoted.card, id: replyToId } : replyToId);
        else if (attachmentIds.length > 0) await api.sendChatMessage(value, projectId, attachmentIds);
        else if (projectId) await api.sendChatMessage(value, projectId);
        else await api.sendChatMessage(value);
        await load();
        return true;
      } catch (e) {
        // A typed message is no longer answered CHAT_BUSY — several can be in flight at once — but a
        // 503 CONCIERGE_DISABLED still carries its own pt-BR message, shown as-is, and so does a host
        // problem (offline, no machine); anything else falls back to a generic line.
        setError(e instanceof ApiError ? e.message : 'Não foi possível enviar a mensagem');
        if (quoted) setReplyTo((current) => current ?? quoted);
        // The server may have dropped the empty assistant row it had already announced (a run that
        // never started at all), so re-read instead of keeping a bubble that will never fill.
        await load().catch(() => undefined);
        return false;
      } finally {
        setInFlight((n) => n - 1);
      }
    },
    [projectId, load, replyTo],
  );

  /** "Propor de novo" on an expired or stale card (TER-477): an ordinary message of this conversation,
   *  so the concierge proposes it again through the gate, on a fresh card. */
  const repropose = useCallback((a: ChatAction) => void send(`Proponha de novo: ${a.summary}`, []), [send]);
  /** Scrolling to a card from the pending bar is the reader leaving the bottom: stop following first, so
   *  a streamed line does not pin the thread back down mid-scroll. */
  const unstick = useCallback(() => {
    stick.current = false;
  }, []);

  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** Whether an answer is being written right now — the only time a reset is refused (409): any row the
   *  thread lists, empty and started. With injected and queued messages the open row is not always the
   *  newest. Read on every render, which `version` triggers on a fold change. */
  const answering = sending || messages.some((m) => m.role === 'assistant' && !m.text && !m.error_code && fold.get(m.id)?.started === true);

  /** "Nova conversa": archives the current conversation (its transcript is kept, just off this screen)
   *  and swaps in the fresh one `load()` brings back. */
  const reset = async () => {
    setResetting(true);
    setError(null);
    try {
      await api.resetChat(projectId);
      setConfirmReset(false);
      setActions([]);
      setQueuedNotes({});
      setGrants([]);
      setProjectGrants([]);
      setTabQuestions([]);
      setQuestionErrors({});
      setTabSuggestions([]);
      setSuggestionErrors({});
      setSubagents([]);
      setCancelFailed(new Set());
      setSubagentsOpen(false);
      setCompactNote(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível começar uma nova conversa');
    } finally {
      setResetting(false);
    }
  };

  /** "Compactar" is offered once there is a conversation to compact and nothing else holds its session. */
  const canCompact = !compacting && !answering && !resetting && messages.length > 0 && host?.kind === 'ready';
  /**
   * "Compactar" (TER-315): asks the server and waits for its `compact` event. A refusal (an answer being
   * written, no session yet, the host) comes back with its own pt-BR sentence, in the status line.
   */
  const compact = useCallback(async () => {
    setCompacting(true);
    setError(null);
    setCompactNote(null);
    try {
      await api.compactChat(projectId);
    } catch (e) {
      setCompacting(false);
      setError(e instanceof ApiError ? e.message : 'Não foi possível compactar a conversa');
    }
  }, [projectId]);
  // `send` (declared above, for `/compact` typed in the box) reaches the current `compact` through this.
  compactRef.current = compact;
  /** Alt+Shift+C anywhere in this panel (the box, a card, the thread): only while it has focus, so a
   *  terminal next to the dock keeps every key it gets. */
  const onPanelKeyDown = (e: ReactKeyboardEvent) => {
    if (!isCompactShortcut(e)) return;
    e.preventDefault();
    if (canCompact) void compact();
  };

  const activeGrantCount = grants.filter((g) => isGrantActive(g)).length + projectGrants.filter((g) => isGrantActive(g)).length + standingGrants.length;

  return (
    // Height and overflow belong to ChatLayout; this page owns the reading column: centred, capped
    // at a comfortable measure and padded so a long answer survives a phone. The bottom safe area
    // is the composer's own (`ChatComposer`), since it — not this column — is anchored to the edge.
    // `flex-1`, never `h-full`: this column is a flex item of `ChatLayout`'s `main`, and a
    // percentage height against a flex item with no explicit height is exactly what Safari declines
    // to resolve — the column took its content's height, the thread stopped filling the screen, and
    // the document scrolled instead of the conversation.
    // `min-w-0` on this column and on the thread below is what keeps a phone honest: a flex item's
    // automatic minimum size is its min-content width, and `break-words` does not reduce that (by
    // spec, `overflow-wrap` never shrinks min-content). So one unbreakable token in an answer — a
    // `waiting_permission` in backticks, a long path — widened this column past the viewport and
    // took the composer's send button off screen with it.
    <div ref={rootRef} className="mx-auto flex min-h-0 w-full min-w-0 max-w-3xl flex-1 flex-col px-4" onKeyDown={onPanelKeyDown}>
      {/* "Começar do zero" without losing the transcript: it stays server-side, just off this screen.
       *  Disabled while an answer is being written (the server would 409) or with nothing yet to reset. */}
      {/* The conversation's trusted tabs used to be a strip above the box; now one link, only while any is
       *  in force (a tab grant or a project grant), to the list in Configurações (spec 2026-09-26 §4.1, §6). */}
      <div className="relative flex items-center justify-end gap-1 pt-2">
        {/* How full the session is, and "Compactar" (TER-315): on the left, apart from the links. */}
        <div className="mr-auto min-w-0">
          <ChatContextMeter tokens={context?.tokens ?? null} window={context?.window ?? null} compacting={compacting} canCompact={canCompact} onCompact={() => void compact()} />
        </div>
        {/* The subagents panel (spec 2026-09-26 §4): the toggle appears once something is running or
         *  being cancelled, and — while it is open — stays even after every one of them ended, so the
         *  panel it opened always has a way to close it again. */}
        {(activeSubagents.length > 0 || subagentsOpen) && (
          <button
            type="button"
            ref={subagentsToggleRef}
            className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg"
            aria-expanded={subagentsOpen}
            aria-controls="chat-subagents-panel"
            onClick={() => setSubagentsOpen((open) => !open)}
          >
            {`Subagentes (${activeSubagents.length})`}
          </button>
        )}
        {activeGrantCount > 0 && (
          <Link to="/settings/chat-grants" className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg">
            {activeGrantsLabel(activeGrantCount)}
          </Link>
        )}
        <button type="button" className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg disabled:opacity-50" disabled={answering || resetting || compacting || messages.length === 0} onClick={() => setConfirmReset(true)}>
          Nova conversa
        </button>
        {subagentsOpen && (
          <div
            id="chat-subagents-panel"
            ref={subagentsPanelRef}
            role="dialog"
            aria-label="Subagentes"
            className="absolute right-0 top-full z-10 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-bg-1 p-2 shadow-lg"
          >
            <ChatSubagents subagents={subagents} failed={cancelFailed} onCancel={cancelSubagent} now={subagentsNow} />
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmReset}
        title="Nova conversa"
        message="O contexto atual desta conversa será descartado. As mensagens saem da tela e o concierge começa do zero."
        confirmLabel="Começar de novo"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void reset()}
      />
      {/* Where this conversation runs, above the thread, before anything is typed — and, when it cannot
          run, the one thing to do about it. Presentational: every decision it renders is decided here.
          Only the account-wide chat offers the picker: a project's chat always runs on that same host,
          chosen from `/chat`, and never gets a picker of its own. */}
      {host && projectId === null && (
        <ChatHost
          host={host}
          machines={host.kind === 'not_chosen' ? host.machines : hostMachines}
          // Only the host machine's own logins: an account of another machine names a config dir that
          // does not exist there, which is exactly what the server refuses (404) and what `lost` means.
          accounts={hostMachineId === null || hostAccounts === null || hostAccounts === 'error' ? null : hostAccounts.filter((a) => a.machine_id === hostMachineId)}
          accountsError={hostAccounts === 'error'}
          accountId={hostAccountId}
          // An admin reading someone else's data: the lists would be that person's, while the
          // conversation is this admin's own, so the picker says so instead of offering nothing.
          viewingAs={viewAs !== null && viewAs !== undefined}
          picking={picking}
          changing={changingHost}
          error={hostError}
          onPick={() => void openPicker()}
          onCancelPick={() => setPicking(false)}
          onChoose={(machineId) => void chooseHost(machineId)}
          // The machine does not move: the account is set on the one already hosting the conversation.
          onChooseAccount={(aiAccountId) => hostMachineId !== null && void chooseHost(hostMachineId, aiAccountId)}
        />
      )}
      {/* A project's own notice, in place of the picker: it names why the chat cannot run right now and
       *  points at `/chat`, the only place the host is ever chosen. */}
      {host && projectId !== null && host.kind !== 'ready' && (
        <div className="mt-2 rounded border border-line bg-bg-2 p-3 text-sm text-fg-muted">
          {host.kind === 'no_machine' || host.kind === 'not_chosen' ? (
            <>
              O chat dos projetos roda na mesma máquina do chat geral.{' '}
              <Link to="/chat" className="text-accent hover:underline">
                Escolher a máquina do chat
              </Link>
            </>
          ) : host.kind === 'offline' ? (
            `A máquina ${host.machine.name} está offline.`
          ) : (
            `O agente da máquina ${host.machine.name} precisa ser atualizado para o chat do projeto.`
          )}
        </div>
      )}
      {/* The thread, its scroll and its pill (`ChatThread`); "Reconectando…" is its overlay badge. The
       * empty state is one line saying what this screen is for — deliberately just the one, no example
       * prompts, no tour — and only while the conversation can actually run: with no machine (or one
       * that is asleep) the host card above already says what to do, and inviting a message that cannot
       * be sent would contradict it. A conversation that never opened (the read failed) says why in
       * that same place, and not only in the composer's status line: an empty thread over a small
       * line at the bottom reads as a conversation with nothing in it. */}
      <ChatThread
        reconnecting={!connected}
        followKey={followKey}
        stickRef={stick}
        empty={
          !loaded && error !== null && messages.length === 0 ? (
            <p className="pt-6 text-center text-sm text-danger">{error}</p>
          ) : loaded && messages.length === 0 && (host === null || host.kind === 'ready') ? (
            <p className="pt-6 text-center text-sm text-fg-dim">
              {projectId === null ? 'Peça algo às suas máquinas: o concierge lê os terminais e pede sua autorização antes de qualquer alteração.' : 'Pergunte sobre este projeto: o concierge lê os terminais dele e pede sua autorização antes de qualquer alteração.'}
            </p>
          ) : undefined
        }
      >
        {entries.map((entry) => {
          if (entry.kind === 'action_group') {
            return <ChatActionGroup key={`g:${entry.actions[0]!.id}`} actions={entry.actions} deciding={batchDeciding} onDecide={onDecideBatch} onShowSeparately={onShowSeparately} />;
          }
          if (entry.kind === 'tab_limit') {
            const l = entry.limit;
            return <TabLimitCard key={`l:${l.id}`} limit={l} busy={busyLimitId === l.id} error={limitErrors[l.id]} onAnswer={onAnswerLimit} />;
          }
          if (entry.kind === 'tab_suggestion') {
            const s = entry.suggestion;
            return <TabSuggestionRow key={`s:${s.id}`} suggestion={s} busy={busySuggestionId === s.id} error={suggestionErrors[s.id]} onSend={sendSuggestion} onDismiss={dismissSuggestion} />;
          }
          if (entry.kind === 'tab_question') {
            const q = entry.question;
            return (
              <TabQuestionCard
                key={`q:${q.id}`}
                question={q}
                answering={answeringQuestionId === q.id}
                error={questionErrors[q.id]}
                onAnswer={answerQuestion}
                loadScreen={loadTabQuestionScreen}
                onForget={forgetDecision}
                onCancelAutoAnswer={cancelAutoAnswer}
                onReply={startQuestionReply}
              />
            );
          }
          if (entry.kind === 'action') {
            const g = grantByAction.get(entry.action.id);
            const pg = projectGrantByAction.get(entry.action.id);
            const sg = standingGrantByAction.get(entry.action.id);
            return (
              <ChatActionCard
                key={entry.action.id}
                action={entry.action}
                deciding={decidingId === entry.action.id}
                note={queuedNotes[entry.action.id]}
                grant={g}
                projectGrant={pg}
                standingGrant={sg}
                revoking={(g !== undefined && revokingId === g.id) || (pg !== undefined && revokingId === pg.id) || (sg !== undefined && revokingId === sg.id)}
                onRevoke={revoke}
                onDecide={decide}
                onRepropose={repropose}
                onReply={startActionReply}
              />
            );
          }
          const m = entry.message;
          const row = fold.get(m.id);
          const streaming = row?.text || undefined;
          // An assistant row with no text and no error is either an answer still being written or a
          // leftover from a run that died with the process. It counts as live when this page knows
          // its run has started (`row.started`) or, while a send is in flight, when it is the newest
          // row; any other empty row is a failed one.
          const empty = m.role === 'assistant' && !m.text && !streaming && !m.error_code;
          // Started rows show "pensando…" wherever they are: with queued or injected turns several
          // answers can be pending at once (spec 2026-09-26 concierge always free).
          const waiting = empty && (row?.started === true || (sending && m.id === lastMessageId));
          return (
            <ChatTurn
              key={m.id}
              message={m}
              streaming={streaming}
              tools={row?.tools}
              waiting={waiting}
              failed={Boolean(m.error_code) || (empty && !waiting)}
              onOpenReply={openReply}
              onReply={startReply}
              highlighted={highlightId === m.id}
            />
          );
        })}
      </ChatThread>
      {/* What waits on the person, however far up it sits (TER-477): hidden while nothing does. */}
      <ChatPendingBar entries={timeline} batchDeciding={batchDeciding} onApprove={approveReversible} onLocate={unstick} />
      {/* A host that cannot run the message is why the box refuses, and the box says so. The send and
       *  decision errors go in its status line too: a line that mounts above the thread shifts it.
       *  `projectId` travels with every upload, so a file lands in this project's conversation. */}
      <ChatComposer onSend={send} replyTo={replyTo} onCancelReply={cancelReply} blockedReason={host && host.kind !== 'ready' ? COMPOSER_REASON[host.kind] : null} status={error ?? actionError} notice={compacting ? 'Compactando a conversa…' : compactNote} projectId={projectId} attachmentStatuses={attachmentStatuses} />
    </div>
  );
}
