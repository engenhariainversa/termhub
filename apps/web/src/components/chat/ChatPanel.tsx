import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChatActionCard } from './ChatActionCard';
import { ChatActionGroup, type BatchDecision } from './ChatActionGroup';
import { ChatComposer } from './ChatComposer';
import { ChatHost } from './ChatHost';
import { ChatThread } from './ChatThread';
import { ChatTurn } from './ChatTurn';
import { TabQuestionCard } from './TabQuestionCard';
import { TabSuggestionCard } from './TabSuggestionCard';
import { ConfirmDialog } from '../Modal';
import { api, ApiError } from '../../lib/api';
import { patchMessageAttachment } from '../../lib/attachments';
import { useChatStream } from '../../lib/chat';
import { useChatLive } from '../../lib/chat-live';
import { mergeMessage } from '../../lib/chat-merge';
import { chatTimeline, groupPendingActions } from '../../lib/chat-timeline';
import { trustedTabsLabel } from './grant-list-text';
import { isGrantActive } from './grant-time';
import { PROMPT_CHANGED_TEXT, upsertTabQuestion } from './tab-question-text';
import { SUGGESTION_CHANGED_TEXT, upsertTabSuggestion } from './tab-suggestion-text';
import { useAuth } from '../../lib/auth';
import type { AiAccount, ChatAction, ChatAttachment, ChatEvent, ChatGrant, ChatHostMachine, ChatHostState, ChatMessage, TabQuestion, TabQuestionAnswer, TabSuggestion } from '../../lib/types';

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

/** A Claude account of one of the user's machines, as the host picker needs it. */
type HostAccountRow = Pick<AiAccount, 'id' | 'label' | 'machine_id'>;

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
  const [revokingId, setRevokingId] = useState<string | null>(null);
  /** The tabs' questions of this conversation (spec 2026-09-25 §6.2), from `GET /api/chat` and the three events. */
  const [tabQuestions, setTabQuestions] = useState<TabQuestion[]>([]);
  const [answeringQuestionId, setAnsweringQuestionId] = useState<string | null>(null);
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>({});
  /** The tabs' suggestions of this conversation (spec 2026-09-25 tab suggestions §6.4), from `GET /api/chat` and their two events. */
  const [tabSuggestions, setTabSuggestions] = useState<TabSuggestion[]>([]);
  const [busySuggestionId, setBusySuggestionId] = useState<string | null>(null);
  const [suggestionErrors, setSuggestionErrors] = useState<Record<string, string>>({});
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
   * uncertainty (a drawer opened while another chat is mid-answer must never flash that chat's deltas
   * or cards). `load()` re-reads the trail over REST regardless, so nothing tagged is lost for good —
   * only an untagged event (`conversation_id === undefined`, an older server) is let through unknown,
   * because there is no id it could ever be checked against.
   */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const mine = useCallback((e: ChatEvent) => e.conversation_id === undefined || e.conversation_id === conversationId, [conversationId]);

  const load = useCallback(async () => {
    // No project = the account-wide chat: called with no argument, because the response must be
    // `request<...>('GET', '/chat')` exactly — a server that predates project chats knows nothing else.
    const { conversation, messages, actions, host, grants, tab_questions, tab_suggestions } = projectId ? await api.chat(projectId) : await api.chat();
    setMessages(messages);
    setActions(actions ?? []);
    setGrants(grants ?? []);
    setTabQuestions(tab_questions ?? []);
    setTabSuggestions(tab_suggestions ?? []);
    setHost(host ?? null);
    setHostAccountId(conversation.ai_account_id ?? null);
    setConversationId(conversation.id);
    setLoaded(true);
  }, [projectId]);

  useEffect(() => {
    // A project deleted in another tab, or any other read failure, must not leave an unhandled
    // rejection and a silently empty panel: `loaded` stays false (no "peça algo…" over a conversation
    // that never opened) and the error line the panel already has for sends says why.
    load().catch((e) => setError(e instanceof ApiError ? e.message : 'Não foi possível abrir a conversa'));
  }, [load]);

  /**
   * What has streamed for each answer being written (text, tool chips, whether the run showed a sign
   * of life), folded in one event at a time. `version` moves on every change, which is what re-renders
   * this panel for a delta; the rows themselves are read through `fold.get` while rendering.
   */
  const { fold, version, push } = useChatLive();
  /**
   * Live events tagged with a conversation id that arrived before this panel knew its own. Held, not
   * dropped: `load()` re-reads everything a REST read can give back, but the deltas and tool calls of
   * an answer already under way exist nowhere else. Replayed into the fold (and only the fold) the
   * moment `conversationId` is known — the ones of another conversation are dropped then. A layout
   * effect, not a passive one: `onEvent` below stops holding as soon as the id is in state, so a delta
   * arriving between that commit and a passive effect's flush would be folded in ahead of the held ones.
   */
  const early = useRef<ChatEvent[]>([]);
  useLayoutEffect(() => {
    if (conversationId === null) return;
    const held = early.current;
    early.current = [];
    for (const e of held) if (e.conversation_id === conversationId) push(e);
  }, [conversationId, push]);

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
      if (!mine(e)) return;
      // The fold takes what is its business (deltas, tool calls, resets, announcements) and ignores the rest.
      push(e);
      if (e.type === 'message') setMessages((prev) => mergeMessage(prev, e.message));
      else if (e.type === 'confirmation') {
        // Enriched server-side exactly like GET /api/chat's trail (same summary, same ids): no name
        // is resolved and no sentence is built here.
        setActions((prev) =>
          prev.some((a) => a.id === e.action_id)
            ? prev
            : [...prev, { id: e.action_id, tool: e.tool, args: e.args, class: e.class, status: 'pending', machine_id: e.machine_id, project_id: e.project_id, tab_id: e.tab_id, summary: e.summary, created_at: e.created_at }],
        );
      } else if (e.type === 'decision') {
        // Someone answered — possibly in another open tab. Keyed on the action id alone.
        setActions((prev) => prev.map((a) => (a.id === e.action_id ? { ...a, status: e.status } : a)));
      } else if (e.type === 'grant') setGrants((prev) => [...prev.filter((g) => g.id !== e.grant.id && g.tab_id !== e.grant.tab_id), e.grant]);
      else if (e.type === 'grant_revoked') setGrants((prev) => prev.filter((g) => g.id !== e.grant_id));
      else if (e.type === 'granted_action') setActions((prev) => (prev.some((a) => a.id === e.action.id) ? prev.map((a) => (a.id === e.action.id ? e.action : a)) : [...prev, e.action]));
      else if (e.type === 'tab_question' || e.type === 'tab_question_answered' || e.type === 'tab_question_closed') setTabQuestions((prev) => upsertTabQuestion(prev, e.question));
      else if (e.type === 'tab_suggestion' || e.type === 'tab_suggestion_closed') setTabSuggestions((prev) => upsertTabSuggestion(prev, e.suggestion));
      else if (e.type === 'attachment_status') {
        // Into the message that carries it (no refetch: only that row gets a new object) and into the
        // composer's chips, for a file uploaded but not yet sent.
        setMessages((prev) => patchMessageAttachment(prev, e.attachment));
        setAttachmentStatuses((prev) => ({ ...prev, [e.attachment.id]: e.attachment }));
      }
    },
    [conversationId, mine, push],
  );
  const { connected } = useChatStream(load, onEvent);

  const decide = useCallback(async (id: string, decision: 'approve' | 'deny' | 'approve_tab') => {
    setDecidingId(id);
    setActionError(null);
    try {
      const res = await api.decideChatAction(id, decision);
      // The response's `action` is the raw decided row, not the enriched card (no `summary`): only
      // its status is applied, keeping the card's already-known summary and other fields as they are.
      setActions((prev) => prev.map((a) => (a.id === id ? { ...a, status: res.action.status } : a)));
      if (res.queued && res.note) setQueuedNotes((prev) => ({ ...prev, [id]: res.note! }));
      // A re-grant for the same tab replaces the older one, as on the server.
      if (res.grant) setGrants((prev) => [...prev.filter((g) => g.id !== res.grant!.id && g.tab_id !== res.grant!.tab_id), res.grant!]);
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
  const onShowSeparately = useCallback(() => setSeparate(true), []);

  /** "Revogar", from the card that granted it. Stable: every card gets this same one. */
  const revoke = useCallback(async (grantId: string) => {
    setRevokingId(grantId);
    setActionError(null);
    try {
      await api.revokeChatGrant(grantId);
      setGrants((prev) => prev.filter((g) => g.id !== grantId));
    } catch (e) {
      // 409: it was already revoked (another tab, or it expired and a reset ended it) — the list is
      // stale, not wrong.
      if (e instanceof ApiError && e.status === 409) setGrants((prev) => prev.filter((g) => g.id !== grantId));
      else setActionError(e instanceof ApiError ? e.message : 'Não foi possível revogar a permissão');
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
  /** Stable, so the permission card's effect runs once per question. */
  const loadTabQuestionScreen = useCallback(async (id: string) => (await api.tabQuestionScreen(id)).text, []);

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
  const timeline = useMemo(() => chatTimeline(messages, actions, tabQuestions, tabSuggestions), [messages, actions, tabQuestions, tabSuggestions]);
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

  /** What the thread's pin follows: a new row or card (the timeline) or a streamed delta (the fold). */
  const followKey = useMemo(() => ({ timeline, version }), [timeline, version]);
  /**
   * Whether the thread follows new content. `ChatThread` owns the reading of it (its `onScroll` and its
   * pill write it); it lives here so `send` can set it — sending is the reader's own way of saying
   * "take me to the bottom".
   */
  const stick = useRef(true);

  /**
   * The composer's `onSend`: the text and the ids of its uploaded chips are the composer's own (it
   * empties itself when it calls this and takes them back on `false`). A message may be attachments
   * alone (spec §3); one with neither is refused here as well as by the button. Never refused for
   * another send in flight: several can be (spec 2026-09-26). The POST returns as soon as the message
   * is stored; the answer streams over the socket.
   */
  const send = useCallback(
    async (value: string, attachmentIds: string[]): Promise<boolean> => {
      if (!value && attachmentIds.length === 0) return false;
      // Sending is the reader's own way of saying "take me to the bottom" — the answer will stream
      // in below whatever they typed.
      stick.current = true;
      setInFlight((n) => n + 1);
      setError(null);
      try {
        // No project = the account-wide chat: called with no second argument, for the same reason as
        // `load` above. The three-argument form only when there is something to carry in it.
        if (attachmentIds.length > 0) await api.sendChatMessage(value, projectId, attachmentIds);
        else if (projectId) await api.sendChatMessage(value, projectId);
        else await api.sendChatMessage(value);
        await load();
        return true;
      } catch (e) {
        // A typed message is no longer answered CHAT_BUSY — several can be in flight at once — but a
        // 503 CONCIERGE_DISABLED still carries its own pt-BR message, shown as-is, and so does a host
        // problem (offline, no machine); anything else falls back to a generic line.
        setError(e instanceof ApiError ? e.message : 'Não foi possível enviar a mensagem');
        // The server may have dropped the empty assistant row it had already announced (a run that
        // never started at all), so re-read instead of keeping a bubble that will never fill.
        await load().catch(() => undefined);
        return false;
      } finally {
        setInFlight((n) => n - 1);
      }
    },
    [projectId, load],
  );

  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** Whether an answer is being written right now — the only time a reset is refused (409). */
  const answering = sending || (lastMessageId !== null && fold.get(lastMessageId)?.started === true && !messages[messages.length - 1]?.text && !messages[messages.length - 1]?.error_code);

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
      setTabQuestions([]);
      setQuestionErrors({});
      setTabSuggestions([]);
      setSuggestionErrors({});
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível começar uma nova conversa');
    } finally {
      setResetting(false);
    }
  };

  const activeGrantCount = grants.filter((g) => isGrantActive(g)).length;

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
    <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-3xl flex-1 flex-col px-4">
      {/* "Começar do zero" without losing the transcript: it stays server-side, just off this screen.
       *  Disabled while an answer is being written (the server would 409) or with nothing yet to reset. */}
      {/* The conversation's trusted tabs used to be a strip above the box; now one link, only while any is
       *  in force, to the list in Configurações (spec 2026-09-26 §4.1). */}
      <div className="flex items-center justify-end gap-1 pt-2">
        {activeGrantCount > 0 && (
          <Link to="/settings/chat-grants" className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg">
            {trustedTabsLabel(activeGrantCount)}
          </Link>
        )}
        <button type="button" className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg disabled:opacity-50" disabled={answering || resetting || messages.length === 0} onClick={() => setConfirmReset(true)}>
          Nova conversa
        </button>
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
          if (entry.kind === 'tab_suggestion') {
            const s = entry.suggestion;
            return <TabSuggestionRow key={`s:${s.id}`} suggestion={s} busy={busySuggestionId === s.id} error={suggestionErrors[s.id]} onSend={sendSuggestion} onDismiss={dismissSuggestion} />;
          }
          if (entry.kind === 'tab_question') {
            const q = entry.question;
            return <TabQuestionCard key={`q:${q.id}`} question={q} answering={answeringQuestionId === q.id} error={questionErrors[q.id]} onAnswer={answerQuestion} loadScreen={loadTabQuestionScreen} />;
          }
          if (entry.kind === 'action') {
            const g = grantByAction.get(entry.action.id);
            return <ChatActionCard key={entry.action.id} action={entry.action} deciding={decidingId === entry.action.id} note={queuedNotes[entry.action.id]} grant={g} revoking={g !== undefined && revokingId === g.id} onRevoke={revoke} onDecide={decide} />;
          }
          const m = entry.message;
          const row = fold.get(m.id);
          const streaming = row?.text || undefined;
          // An assistant row with no text and no error is either the answer being written right now
          // or a leftover from a run that died with the process. Only the newest row can still be
          // the live one, and only while this page knows its run is under way.
          const empty = m.role === 'assistant' && !m.text && !streaming && !m.error_code;
          // Started rows show "pensando…" wherever they are: with queued or injected turns several
          // answers can be pending at once (spec 2026-09-26 concierge always free).
          const waiting = empty && (row?.started === true || (sending && m.id === lastMessageId));
          return <ChatTurn key={m.id} message={m} streaming={streaming} tools={row?.tools} waiting={waiting} failed={Boolean(m.error_code) || (empty && !waiting)} />;
        })}
      </ChatThread>
      {/* A host that cannot run the message is why the box refuses, and the box says so. The send and
       *  decision errors go in its status line too: a line that mounts above the thread shifts it.
       *  `projectId` travels with every upload, so a file lands in this project's conversation. */}
      <ChatComposer onSend={send} blockedReason={host && host.kind !== 'ready' ? COMPOSER_REASON[host.kind] : null} status={error ?? actionError} projectId={projectId} attachmentStatuses={attachmentStatuses} />
    </div>
  );
}
