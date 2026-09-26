// Chat routes (P§6, design spec §4.2 "Chat"/"Controls"): projects, the conversation payload,
// sending a message (`202` then a reply streamed over the socket), decisions, trusted tabs
// ("Permitir sempre nesta aba") and reset.
import { z } from 'zod';
import { decisionProof } from '../../../crypto/pin';
import { randomId } from '../../../crypto/random';
import {
  chatGrantListQuery,
  isTabGrantable,
  kindFromNameAndMime,
  mobileBatchDecisionBody,
  mobileDecisionBody,
  mobileMessageBody,
  resetBody,
  setHostBody,
  tabQuestionAnswerBody,
  tabSuggestionSendBody,
  type TChatAttachment,
  type TChatEvent,
  type TChatGrant,
  type TChatGrantListItem,
  type TChatHostState,
  type TTabQuestion,
  type TTabSuggestion,
} from '../../contract';
import type { MockRouter } from '../router';
import { broadcast, countPinFailure, type MockAction, type MockAttachment, type MockConversation, type MockDevice, type MockGrant, type MockMessage, type MockState, type MockTabQuestion, type MockTabSuggestion, verifyAuth, WireError } from '../state';
import { pushConfirmationNotification, pushReplyNotification } from './notifications';

const USER_ID = 'u1';

/** The fixed roster `GET chat/host/options` lists and `POST chat/host` validates against
 * (design spec §4.2 "Chat": "hostOptions lists two machines"). `m-hulk` has no accounts because
 * it is offline — the web/app never let you pick an account on a machine you cannot reach. */
const HOST_MACHINES = [
  { id: 'm-jarvis', name: 'jarvis', online: true, agentVersion: '0.4.4', accounts: [{ id: 'acc-1', label: 'Claude Pedro', configDir: null as string | null }] },
  { id: 'm-hulk', name: 'hulk', online: false, agentVersion: '0.4.3', accounts: [] as Array<{ id: string; label: string; configDir: string | null }> },
];

/** Derives `GET chat`/`POST chat/host`'s `host` from the conversation's own stored
 * `machine_id`/`ai_account_id` — defaulting to `m-jarvis`/no account when neither was ever set
 * (fixtures seed exactly that). An offline machine (`m-hulk`) answers `offline`; a chosen account
 * that no longer exists on the machine quietly falls back to `default`, same as never choosing
 * one — there is no wire error for that case in P§6. */
function hostFor(conversation: MockConversation): TChatHostState {
  const machineId = conversation.machine_id ?? 'm-jarvis';
  const machine = HOST_MACHINES.find((m) => m.id === machineId) ?? HOST_MACHINES[0]!;
  if (!machine.online) return { kind: 'offline', machine: { id: machine.id, name: machine.name } };

  const chosen = conversation.ai_account_id ? machine.accounts.find((a) => a.id === conversation.ai_account_id) : undefined;
  return {
    kind: 'ready',
    machine: { id: machine.id, name: machine.name },
    configDir: chosen?.configDir ?? null,
    account: chosen ? { kind: 'chosen', id: chosen.id, label: chosen.label } : { kind: 'default' },
    sessionAtStake: false,
  };
}

function conversationFor(state: MockState, projectId: string | null): MockConversation {
  const id = state.activeConversation.get(projectId);
  const conversation = id ? state.conversations.get(id) : undefined;
  if (!conversation) throw new WireError(404, 'NOT_FOUND', 'Conversa não encontrada.');
  return conversation;
}

function actionsFor(state: MockState, conversationId: string): MockAction[] {
  return [...state.actions.values()].filter((a) => a.conversation_id === conversationId);
}

/** A grant lasts at most 24 h, like the server's `GRANT_TTL_MS`. */
const GRANT_TTL_MS = 24 * 60 * 60_000;

/** The tabs the fixtures' actions point at, by id -> name (the server joins the tab row for
 * `tab_name`; a tab the mock does not know is one that "no longer exists": `null`). */
const TAB_NAMES: Record<string, string> = { 't-api': 'api' };

// --- attachments (spec 2026-09-26 §5.3) ------------------------------------------------------------

/** How long the mock "extracts" a file before its `attachment_status` (the real queue takes seconds too). */
const ATTACHMENT_EXTRACT_MS = 1500;

const attachmentUploadQuery = z.object({ name: z.string().min(1).max(200), project_id: z.string().min(1).max(64).optional() });

/** The wire shape (the server's `toPublicAttachment`): the row minus what only the mock keeps. */
function attachmentView(a: MockAttachment): TChatAttachment {
  const { conversation_id: _conversation, message_id: _message, ...view } = a;
  return view;
}

function attachmentEvent(a: MockAttachment): TChatEvent {
  return { type: 'attachment_status', user_id: USER_ID, conversation_id: a.conversation_id, attachment: attachmentView(a) };
}

/** What the extractors would have found, per kind. */
function metaFor(kind: TChatAttachment['kind']): Record<string, unknown> {
  switch (kind) {
    case 'pdf':
      return { pages: 12 };
    case 'image':
      return { width: 1568, height: 1176 };
    case 'audio':
    case 'video':
      return { duration_s: 42 };
    case 'xlsx':
      return { sheets: [{ name: 'Plan1', rows: 20, cols: 4 }] };
    default:
      return {};
  }
}

/** Ids like the server's `newId()`: lower-case alphanumerics only, since the id is also a file name there. */
function attachmentId(): string {
  return randomId(12).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'a0';
}

/**
 * Binds `ids` to the message being sent, exactly as the server's `attach`: every id must be this
 * conversation's, not yet sent, and not invalid — otherwise 409 before anything is stored.
 */
function bindAttachments(state: MockState, conversationId: string, ids: string[], messageId: string): MockAttachment[] {
  const rows = ids.map((id) => state.attachments.get(id));
  const ok = rows.every((a) => a && a.conversation_id === conversationId && a.message_id === null && !(a.status === 'failed' && a.error_code === 'ATTACHMENT_INVALID'));
  if (!ok) throw new WireError(409, 'ATTACHMENT_UNAVAILABLE', 'Um dos anexos não está mais disponível.');
  for (const a of rows as MockAttachment[]) a.message_id = messageId;
  return rows as MockAttachment[];
}

function findAttachment(state: MockState, id: string): MockAttachment {
  const a = state.attachments.get(id);
  if (!a) throw new WireError(404, 'NOT_FOUND', 'Anexo não encontrado.');
  return a;
}

/** The wire shape of a grant (the server's `ChatGrantView`). */
function grantView(g: MockGrant): TChatGrant {
  return { id: g.id, tab_id: g.tab_id, tool: g.tool, source_action_id: g.source_action_id, created_at: g.created_at, expires_at: g.expires_at, tab_name: g.tab_name };
}

/** `GET chat`'s `grants`: the conversation's grants still in force, oldest first. */
function activeGrantsFor(state: MockState, conversationId: string, now: number): TChatGrant[] {
  return state.grants.filter((g) => g.conversation_id === conversationId && !g.revoked && Date.parse(g.expires_at) > now).map(grantView);
}

/** Trusts the tab of `action` (just approved): any other grant of the same tab in that conversation
 * is revoked first — at most one per tab, as the server's partial unique index keeps it. */
function grantTab(state: MockState, action: MockAction, now: number): MockGrant {
  for (const g of state.grants) {
    if (g.conversation_id === action.conversation_id && g.tab_id === action.tab_id && !g.revoked) {
      g.revoked = true;
      g.revoked_at = new Date(now).toISOString();
      g.revoked_by_user = true;
    }
  }
  const grant: MockGrant = {
    id: randomId(10),
    conversation_id: action.conversation_id,
    tab_id: action.tab_id!,
    tool: 'send_input',
    source_action_id: action.id,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + GRANT_TTL_MS).toISOString(),
    tab_name: TAB_NAMES[action.tab_id!] ?? null,
    revoked: false,
    revoked_at: null,
    revoked_by_user: false,
  };
  state.grants.push(grant);
  return grant;
}

// --- tab questions (spec 2026-09-25 §6.3) ---------------------------------------------------------

/** The wire shape of a question (the server's `TabQuestionView`): the mock's row minus its conversation. */
function tabQuestionView(q: MockTabQuestion): TTabQuestion {
  const { conversation_id: _conversation, ...view } = q;
  return view as TTabQuestion;
}

/** The canned question a `pergunta` / `permiss` message makes the tab `api` ask. */
function createTabQuestion(state: MockState, now: number, conversationId: string, kind: 'choice' | 'permission'): MockTabQuestion {
  const common = { id: randomId(10), conversation_id: conversationId, tab_id: 't-api', tab_name: 'api', status: 'open' as const, error_code: null, created_at: new Date(now).toISOString(), answered_at: null, closed_at: null };
  const question: MockTabQuestion =
    kind === 'choice'
      ? {
          ...common,
          kind: 'choice',
          answer: null,
          payload: {
            questions: [
              {
                question: 'Qual banco usamos nos testes?',
                header: 'Banco',
                multi_select: false,
                options: [
                  { label: 'Postgres', description: 'O mesmo da produção.', recommended: true },
                  { label: 'SQLite', description: 'Mais rápido, menos fiel.', recommended: false },
                ],
              },
            ],
          },
        }
      : { ...common, kind: 'permission', answer: null, payload: { tool_name: 'Bash' } };
  state.tabQuestions.push(question);
  return question;
}

/** What `GET …/screen` shows: the card as the tab would draw it. */
function tabQuestionScreenText(q: MockTabQuestion): string {
  return q.kind === 'choice' ? `${q.payload.questions[0]!.question}\n❯ 1. Postgres\n  2. SQLite\n  3. Type something.` : 'Bash command\n  npm test\n Do you want to proceed?\n ❯ 1. Yes\n   2. No';
}

// --- tab suggestions (spec 2026-09-25 tab suggestions §6) -------------------------------------------

function tabSuggestionView(s: MockTabSuggestion): TTabSuggestion {
  const { conversation_id: _conversation, ...view } = s;
  return view as TTabSuggestion;
}

/** The canned suggestion a `sugest…` message makes the tab `api` show. */
function createTabSuggestion(state: MockState, now: number, conversationId: string): MockTabSuggestion {
  const suggestion: MockTabSuggestion = { id: randomId(10), conversation_id: conversationId, tab_id: 't-api', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it', context: 'Criei o arquivo notes.txt com a linha hello.\n\nQuer que eu faça o commit?' }, status: 'open', answer: null, error_code: null, created_at: new Date(now).toISOString(), answered_at: null, closed_at: null };
  state.tabSuggestions.push(suggestion);
  return suggestion;
}

// --- the canned reply and its streaming (ruling 3) ----------------------------------------------

interface AnswerOutcome {
  kind: 'normal' | 'confirmation' | 'error' | 'tab_question' | 'tab_permission' | 'tab_suggestion';
  text: string;
}

/** Canned answers keyed by keyword (brief's exact pt-BR texts). `erro` and `confirma` change the
 * shape of the run instead of just picking its text. */
function pickAnswer(text: string): AnswerOutcome {
  if (/erro/.test(text)) return { kind: 'error', text: '' };
  if (/confirma/.test(text)) {
    return { kind: 'confirmation', text: 'Preciso que você confirme essa ação — fico esperando sua aprovação antes de continuar.' };
  }
  if (/pergunta/.test(text)) return { kind: 'tab_question', text: 'A aba api tem uma pergunta para você — responda no card.' };
  if (/permiss/.test(text)) return { kind: 'tab_permission', text: 'A aba api pede permissão — responda no card.' };
  if (/sugest/.test(text)) return { kind: 'tab_suggestion', text: 'A aba api sugere um próximo passo — veja o card.' };
  if (/test|teste/.test(text)) return { kind: 'normal', text: 'Rodei `npm test` no jarvis: 1066 testes passaram, 137 pulados. Nada quebrou.' };
  if (/deploy/.test(text)) return { kind: 'normal', text: 'O último deploy foi há 2 h, verde. Quer que eu dispare outro?' };
  if (/status/.test(text)) return { kind: 'normal', text: 'Duas abas trabalhando, uma esperando você: a aba api pediu para rodar os testes.' };
  return { kind: 'normal', text: 'Entendi. Posso olhar as abas do projeto e te dizer o que está esperando você — quer que eu faça isso?' };
}

/** Splits `text` into 12-30 char pieces (ruling 3) — at least one, since every outcome above is
 * non-empty text (the `error` outcome never reaches this: it skips streaming entirely). */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = Math.min(text.length - i, 12 + Math.floor(Math.random() * 19));
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

function createConfirmationAction(state: MockState, now: number, conversationId: string, projectId: string | null, projectName: string | null): MockAction {
  const tabId = projectId ? 't-api' : null;
  const action: MockAction = {
    id: randomId(10),
    conversation_id: conversationId,
    tool: 'send_input',
    // Like a real row, the proposal's own args name the tab the row targets.
    args: tabId ? { tab_id: tabId } : {},
    class: 'write',
    status: 'pending',
    machine_id: projectId ? 'm-jarvis' : null,
    project_id: projectId,
    tab_id: tabId,
    grant_id: null,
    summary: projectId ? `digitar comando na aba api do projeto ${projectName}, no jarvis` : 'digitar comando no chat geral',
    created_at: new Date(now).toISOString(),
  };
  state.actions.set(action.id, action);
  return action;
}

function confirmationEvent(action: MockAction): TChatEvent {
  return {
    type: 'confirmation',
    user_id: USER_ID,
    conversation_id: action.conversation_id,
    action_id: action.id,
    tool: action.tool,
    args: action.args,
    class: action.class,
    machine_id: action.machine_id,
    project_id: action.project_id,
    tab_id: action.tab_id,
    summary: action.summary,
    created_at: action.created_at,
  };
}

interface StreamOptions {
  state: MockState;
  now: () => number;
  stepMs: number;
  conversationId: string;
  projectId: string | null;
  projectName: string | null;
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
  attachments: MockAttachment[];
}

/** The `202` reply's follow-up: a `setTimeout` chain so every event is its own macrotask — user
 * message, empty assistant message, the confirmation (if any), the deltas, the final message
 * (ruling 3). `busy` is set synchronously so a `chatProjects` call right after the `202` already
 * sees it. */
function scheduleStream(o: StreamOptions): void {
  const step = (fn: () => void) => setTimeout(fn, o.stepMs);

  o.state.busyProjects.add(o.projectId);

  step(() => {
    const userMessage: MockMessage = {
      id: o.userMessageId,
      conversation_id: o.conversationId,
      role: 'user',
      text: o.userText,
      usage: null,
      error_code: null,
      created_at: new Date(o.now()).toISOString(),
      attachments: o.attachments.map(attachmentView),
    };
    o.state.messages.get(o.conversationId)?.push(userMessage);
    broadcast(o.state, { type: 'message', user_id: USER_ID, conversation_id: o.conversationId, message: userMessage });

    step(() => {
      const assistantMessage: MockMessage = {
        id: o.assistantMessageId,
        conversation_id: o.conversationId,
        role: 'assistant',
        text: '',
        usage: null,
        error_code: null,
        created_at: new Date(o.now()).toISOString(),
      };
      o.state.messages.get(o.conversationId)?.push(assistantMessage);
      broadcast(o.state, { type: 'message', user_id: USER_ID, conversation_id: o.conversationId, message: assistantMessage });

      const outcome = pickAnswer(o.userText);

      const finish = (finalText: string, errorCode: string | null) => {
        assistantMessage.text = finalText;
        assistantMessage.error_code = errorCode;
        broadcast(o.state, { type: 'message', user_id: USER_ID, conversation_id: o.conversationId, message: assistantMessage });
        const conversation = o.state.conversations.get(o.conversationId);
        if (conversation) conversation.last_message_at = assistantMessage.created_at;
        o.state.busyProjects.delete(o.projectId);
        pushReplyNotification(o.state, o.now(), o.conversationId, o.projectId, o.projectName);
      };

      if (outcome.kind === 'error') {
        step(() => finish('', 'HOST_GONE'));
        return;
      }

      if (outcome.kind === 'confirmation') {
        const action = createConfirmationAction(o.state, o.now(), o.conversationId, o.projectId, o.projectName);
        broadcast(o.state, confirmationEvent(action));
        pushConfirmationNotification(o.state, o.now(), action, o.projectName);
      }

      if (outcome.kind === 'tab_question' || outcome.kind === 'tab_permission') {
        const question = createTabQuestion(o.state, o.now(), o.conversationId, outcome.kind === 'tab_question' ? 'choice' : 'permission');
        broadcast(o.state, { type: 'tab_question', user_id: USER_ID, conversation_id: o.conversationId, question: tabQuestionView(question) });
      }

      if (outcome.kind === 'tab_suggestion') {
        const suggestion = createTabSuggestion(o.state, o.now(), o.conversationId);
        broadcast(o.state, { type: 'tab_suggestion', user_id: USER_ID, conversation_id: o.conversationId, suggestion: tabSuggestionView(suggestion) });
      }

      const chunks = chunkText(outcome.text);
      const emitChunk = (i: number) => {
        if (i >= chunks.length) {
          finish(outcome.text, null);
          return;
        }
        step(() => {
          broadcast(o.state, { type: 'delta', user_id: USER_ID, conversation_id: o.conversationId, message_id: o.assistantMessageId, delta: chunks[i]! });
          emitChunk(i + 1);
        });
      };
      emitChunk(0);
    });
  });
}

/** The mock's `ChatGrantListItem`: same state rule as the server's `grantState`. */
function grantListItem(state: MockState, g: MockGrant, now: number): TChatGrantListItem {
  const expiresAt = Date.parse(g.expires_at);
  const revokedFirst = g.revoked && g.revoked_at !== null && Date.parse(g.revoked_at) < expiresAt;
  const s = revokedFirst ? (g.revoked_by_user ? 'revoked' : 'ended') : !g.revoked && expiresAt > now ? 'active' : 'expired';
  const conversation = state.conversations.get(g.conversation_id);
  const project = conversation?.project_id ? state.projects.get(conversation.project_id) : undefined;
  return {
    ...grantView(g),
    project_id: project?.id ?? null,
    project_name: project?.name ?? null,
    conversation_id: g.conversation_id,
    conversation_project_name: project?.name ?? null,
    conversation_archived: conversation?.archived_at != null,
    state: s,
    ended_at: s === 'active' ? null : s === 'expired' ? g.expires_at : g.revoked_at,
  };
}

// --- routes ---------------------------------------------------------------------------------

/** An approval's PIN check, shared by the single and the batch decision routes. It submits a PIN
 * guess exactly like `session/token` does, so a device already locked out is blocked the same way,
 * without this attempt counting again. The challenge must be a `decision` one bound to this action,
 * and is spent either way; the proof signs the decision word, so one made for `approve` is refused
 * for `approve_tab`. A bad proof counts a PIN failure and throws `PIN_INVALID`. */
function checkDecisionProof(
  state: MockState,
  device: MockDevice,
  actionId: string,
  decision: 'approve' | 'approve_tab',
  body: { challenge: string; pin_proof: string },
  now: number,
): void {
  if (device.lockedUntil !== undefined && device.lockedUntil > now) {
    const retryAfter = Math.ceil((device.lockedUntil - now) / 1000);
    throw new WireError(423, 'DEVICE_LOCKED', 'Aparelho bloqueado por tentativas de PIN.', { retry_after: retryAfter });
  }

  const chal = state.challenges.get(body.challenge);
  const bound = !!chal && !chal.used && now <= chal.expiresAt && chal.deviceId === device.id && chal.purpose === 'decision' && chal.actionId === actionId;
  if (bound) chal!.used = true;

  const expectedProof = bound ? decisionProof(device.pinSecret, body.challenge, actionId, decision) : null;
  if (!bound || body.pin_proof !== expectedProof) {
    const attemptsLeft = countPinFailure(state, device, now);
    throw new WireError(401, 'PIN_INVALID', 'PIN incorreto.', { attempts_left: attemptsLeft });
  }
}

export function registerChatRoutes(router: MockRouter, state: MockState, opts: { maxLatency: number }): void {
  const stepMs = Math.max(0, opts.maxLatency) / 2;

  router.route('GET', '/api/m/v1/chat/projects', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const projects = [...state.projects.values()].map((project) => {
      const conversationId = state.activeConversation.get(project.id);
      const conversation = conversationId ? state.conversations.get(conversationId) : undefined;
      // Open tab questions wait on the person too, as on the server (spec 2026-09-26 §4.9); suggestions do not.
      const pending = conversation
        ? actionsFor(state, conversation.id).filter((a) => a.status === 'pending').length + state.tabQuestions.filter((q) => q.conversation_id === conversation.id && q.status === 'open').length
        : 0;
      return {
        id: project.id,
        name: project.name,
        key: project.key,
        busy: state.busyProjects.has(project.id),
        pending_confirmations: pending,
        last_message_at: conversation?.last_message_at ?? null,
      };
    });
    return { status: 200, body: { projects } };
  });

  router.route('GET', '/api/m/v1/chat', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const projectId = ctx.query.project ?? null;
    const conversation = conversationFor(state, projectId);
    return {
      status: 200,
      body: {
        conversation,
        messages: state.messages.get(conversation.id) ?? [],
        actions: actionsFor(state, conversation.id),
        grants: activeGrantsFor(state, conversation.id, ctx.now()),
        tab_questions: state.tabQuestions.filter((q) => q.conversation_id === conversation.id).map(tabQuestionView),
        tab_suggestions: state.tabSuggestions.filter((s) => s.conversation_id === conversation.id).map(tabSuggestionView),
        host: hostFor(conversation),
      },
    };
  });

  router.route('GET', '/api/m/v1/chat/host/options', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return {
      status: 200,
      body: {
        machines: HOST_MACHINES.map((m) => ({
          id: m.id,
          name: m.name,
          online: m.online,
          agent_version: m.agentVersion,
          accounts: m.accounts.map((a) => ({ id: a.id, label: a.label, config_dir: a.configDir })),
        })),
      },
    };
  });

  router.route('POST', '/api/m/v1/chat/host', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = setHostBody.parse(ctx.body);
    const machine = HOST_MACHINES.find((m) => m.id === body.machine_id);
    if (!machine) throw new WireError(404, 'MACHINE_NOT_FOUND', 'Máquina não encontrada.');

    // `client.ts`'s `setHost` carries no project targeting (no query, no `project_id` in the
    // body) — it always applies to the account-wide chat, the only conversation the app lets you
    // pick a host for (design spec §6: `HostSheet` is "for the account-wide chat"); every
    // project's conversation keeps the fixed `m-jarvis` fixtures give it.
    const conversation = conversationFor(state, null);
    conversation.machine_id = machine.id;
    conversation.ai_account_id = body.ai_account_id ?? null;

    return { status: 200, body: { conversation, host: hostFor(conversation) } };
  });

  router.route('POST', '/api/m/v1/chat/messages', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = mobileMessageBody.parse(ctx.body);
    const projectId = body.project_id ?? null;
    const conversation = conversationFor(state, projectId);
    const project = projectId ? state.projects.get(projectId) : undefined;
    const userMessageId = randomId(10);
    const assistantMessageId = randomId(10);
    const attachments = bindAttachments(state, conversation.id, body.attachment_ids ?? [], userMessageId);

    scheduleStream({
      state,
      now: ctx.now,
      stepMs,
      conversationId: conversation.id,
      projectId,
      projectName: project?.name ?? null,
      userMessageId,
      assistantMessageId,
      userText: body.text,
      attachments,
    });

    return { status: 202, body: { conversation_id: conversation.id, user_message_id: userMessageId, assistant_message_id: assistantMessageId } };
  });

  // --- attachments (spec 2026-09-26 §5.3): the file itself is never kept by the mock, only its row ---

  router.route('POST', '/api/m/v1/chat/attachments', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const query = attachmentUploadQuery.parse(ctx.query);
    const conversation = conversationFor(state, query.project_id ?? null);
    const mime = ctx.headers['content-type'] ?? 'application/octet-stream';
    const kind = kindFromNameAndMime(query.name, mime);
    if (!kind) throw new WireError(415, 'ATTACHMENT_TYPE', 'Tipo de arquivo não suportado');
    const attachment: MockAttachment = {
      id: attachmentId(),
      conversation_id: conversation.id,
      message_id: null,
      name: query.name,
      mime,
      kind,
      bytes: 1024,
      status: 'pending',
      error_code: null,
      meta: null,
      created_at: new Date(ctx.now()).toISOString(),
    };
    state.attachments.set(attachment.id, attachment);
    setTimeout(() => {
      if (state.attachments.get(attachment.id) !== attachment) return; // deleted meanwhile
      attachment.status = 'ready';
      attachment.meta = metaFor(kind);
      broadcast(state, attachmentEvent(attachment));
    }, ATTACHMENT_EXTRACT_MS);
    return { status: 201, body: { attachment: attachmentView(attachment) } };
  });

  router.route('GET', '/api/m/v1/chat/attachments/:id/status', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: { attachment: attachmentView(findAttachment(state, ctx.params.id!)) } };
  });

  // The download itself is not mocked: the phone shows images through `<Image>` against the real host and
  // never fetches a file through `fetch`.

  /** Only while unsent: 404 unknown, 409 once a message carried it (the server's `conflict`). */
  router.route('DELETE', '/api/m/v1/chat/attachments/:id', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'DELETE', htu: ctx.htu, now: ctx.now() });
    const a = findAttachment(state, ctx.params.id!);
    if (a.message_id !== null) throw new WireError(409, 'CONFLICT', 'Este anexo já foi enviado');
    state.attachments.delete(a.id);
    return { status: 200, body: { ok: true } };
  });

  router.route('POST', '/api/m/v1/chat/reset', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = resetBody.parse(ctx.body);
    const projectId = body.project_id ?? null;
    const previous = conversationFor(state, projectId);
    previous.archived_at = new Date(ctx.now()).toISOString();
    // A reset ends the old conversation's trusted tabs too (the server's `revokeForConversation`).
    for (const g of state.grants) {
      if (g.conversation_id === previous.id && !g.revoked) {
        g.revoked = true;
        g.revoked_at = new Date(ctx.now()).toISOString();
        g.revoked_by_user = false;
      }
    }

    const conversation: MockConversation = {
      id: randomId(10),
      title: null,
      project_id: projectId,
      machine_id: 'm-jarvis',
      ai_account_id: null,
      archived_at: null,
      last_message_at: null,
    };
    state.conversations.set(conversation.id, conversation);
    state.messages.set(conversation.id, []);
    state.activeConversation.set(projectId, conversation.id);

    return { status: 200, body: { conversation } };
  });

  router.route('POST', '/api/m/v1/chat/actions/:id/decision', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = mobileDecisionBody.parse(ctx.body);
    const action = state.actions.get(ctx.params.id!);
    if (!action) throw new WireError(404, 'NOT_FOUND', 'Ação não encontrada.');
    // Checked before any PIN handling — even for `deny` (ruling 7) — so redeciding a settled
    // action never burns a PIN attempt.
    if (action.status !== 'pending') throw new WireError(409, 'ALREADY_DECIDED', 'Esta ação já foi decidida.');

    const now = ctx.now();

    if (body.decision === 'deny') {
      action.status = 'denied';
      broadcast(state, { type: 'decision', user_id: USER_ID, conversation_id: action.conversation_id, action_id: action.id, status: 'denied' });
      return { status: 200, body: {} };
    }

    const hasProof = 'challenge' in body && body.challenge !== undefined && body.pin_proof !== undefined;
    if (!hasProof) {
      // Mirrors the server (TER-92): only a `write` card approves with the session alone.
      if (body.decision === 'approve_tab' || action.class !== 'write') throw new WireError(401, 'PIN_REQUIRED', 'Confirme com o PIN para autorizar esta ação.');
      action.status = 'approved';
      broadcast(state, { type: 'decision', user_id: USER_ID, conversation_id: action.conversation_id, action_id: action.id, status: 'approved' });
      return { status: 200, body: {} };
    }

    // An ineligible grant is refused before the challenge is spent or the PIN checked.
    if (body.decision === 'approve_tab' && !isTabGrantable({ tool: action.tool, args: action.args, tab_id: action.tab_id })) {
      throw new WireError(400, 'GRANT_NOT_ALLOWED', 'Só dá para permitir sempre o envio de texto para uma aba');
    }

    checkDecisionProof(state, device, action.id, body.decision, { challenge: body.challenge!, pin_proof: body.pin_proof! }, now);
    device.pinFailures = 0;
    action.status = 'approved';
    broadcast(state, { type: 'decision', user_id: USER_ID, conversation_id: action.conversation_id, action_id: action.id, status: 'approved' });
    if (body.decision === 'approve') return { status: 200, body: {} };

    const grant = grantView(grantTab(state, action, now));
    broadcast(state, { type: 'grant', user_id: USER_ID, conversation_id: action.conversation_id, grant });
    return { status: 200, body: { grant } };
  });

  /** A grouped confirmation, like the server: ids of two conversations are a 400; every approval
   * still pending is proven before anything is decided (a wrong PIN leaves the whole batch pending);
   * then each row is decided with its own `decision` event. Nothing decided at all is a 409. */
  router.route('POST', '/api/m/v1/chat/actions/decisions', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const { decisions } = mobileBatchDecisionBody.parse(ctx.body);
    const rows = decisions.map((d) => state.actions.get(d.id));
    const found = rows.filter((r): r is MockAction => r !== undefined);
    if (new Set(found.map((r) => r.conversation_id)).size > 1) throw new WireError(400, 'MIXED_CONVERSATIONS', 'As ações precisam ser da mesma conversa');

    const now = ctx.now();
    const skipped: Array<{ id: string; reason: 'not_found' | 'already_decided' }> = [];
    const pending: Array<{ action: MockAction; decision: 'approve' | 'deny' }> = [];
    decisions.forEach((d, i) => {
      const action = rows[i];
      if (!action) skipped.push({ id: d.id, reason: 'not_found' });
      else if (action.status !== 'pending') skipped.push({ id: d.id, reason: 'already_decided' });
      else pending.push({ action, decision: d.decision });
    });

    // Mirrors the server (TER-92): a `write` approval goes with the session alone, any other class
    // needs its proof, and a missing one refuses the whole batch before any challenge is spent.
    const approvals = decisions.filter((d) => d.decision === 'approve' && pending.some((p) => p.action.id === d.id));
    if (approvals.some((d) => d.decision === 'approve' && d.challenge === undefined && state.actions.get(d.id)!.class !== 'write')) {
      throw new WireError(401, 'PIN_REQUIRED', 'Confirme com o PIN para autorizar esta ação.');
    }
    let proven = false;
    for (const d of approvals) {
      if (d.decision !== 'approve' || d.challenge === undefined || d.pin_proof === undefined) continue;
      checkDecisionProof(state, device, d.id, 'approve', { challenge: d.challenge, pin_proof: d.pin_proof }, now);
      proven = true;
    }
    if (proven) device.pinFailures = 0;

    if (pending.length === 0) throw new WireError(409, 'ALREADY_DECIDED', 'Estas ações já foram decididas');
    const actions = pending.map(({ action, decision }) => {
      action.status = decision === 'deny' ? 'denied' : 'approved';
      broadcast(state, { type: 'decision', user_id: USER_ID, conversation_id: action.conversation_id, action_id: action.id, status: action.status });
      return { ...action };
    });
    return { status: 200, body: { actions, skipped, queued: true, note: 'A decisão foi registrada; a resposta chega pelo chat.' } };
  });

  /** "Abas confiáveis": the server's paging (newest first, cursor = the last id of the page). */
  router.route('GET', '/api/m/v1/chat/grants', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const q = chatGrantListQuery.parse(ctx.query);
    const now = ctx.now();
    const rows = [...state.grants].reverse().map((g) => grantListItem(state, g, now)).filter((g) => (q.state === 'active' ? g.state === 'active' : g.state !== 'active'));
    const start = q.state === 'ended' && q.cursor ? rows.findIndex((g) => g.id === q.cursor) + 1 : 0;
    const page = rows.slice(start, start + q.limit);
    const more = q.state === 'ended' && start + q.limit < rows.length;
    return { status: 200, body: { grants: page, next_cursor: more ? page[page.length - 1]!.id : null } };
  });

  /** "Revogar" (no PIN: it only takes power away): 404 unknown, 409 already revoked. */
  router.route('DELETE', '/api/m/v1/chat/grants/:id', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'DELETE', htu: ctx.htu, now: ctx.now() });
    const grant = state.grants.find((g) => g.id === ctx.params.id);
    if (!grant) throw new WireError(404, 'NOT_FOUND', 'Permissão não encontrada');
    if (grant.revoked) throw new WireError(409, 'CONFLICT', 'Esta permissão já foi revogada');
    grant.revoked = true;
    grant.revoked_at = new Date(ctx.now()).toISOString();
    grant.revoked_by_user = true;
    broadcast(state, { type: 'grant_revoked', user_id: USER_ID, conversation_id: grant.conversation_id, grant_id: grant.id });
    return { status: 200, body: { grant: grantView(grant) } };
  });

  /** Answers a tab's question (no PIN): 404 unknown, 409 once it is closed, 400 a body of the other kind. */
  router.route('POST', '/api/m/v1/chat/tab-questions/:id/answer', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const question = state.tabQuestions.find((q) => q.id === ctx.params.id);
    if (!question) throw new WireError(404, 'NOT_FOUND', 'Pergunta não encontrada');
    if (question.status !== 'open') throw new WireError(409, 'TAB_PROMPT_CHANGED', 'A pergunta mudou na aba');
    const body = tabQuestionAnswerBody.parse(ctx.body);
    if ((question.kind === 'choice') !== 'answers' in body) throw new WireError(400, 'VALIDATION', 'Dados inválidos');
    Object.assign(question, { status: 'answered', answer: body, answered_at: new Date(ctx.now()).toISOString() });
    const view = tabQuestionView(question);
    broadcast(state, { type: 'tab_question_answered', user_id: USER_ID, conversation_id: question.conversation_id, question: view });
    return { status: 200, body: { tab_question: view } };
  });

  router.route('GET', '/api/m/v1/chat/tab-questions/:id/screen', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const question = state.tabQuestions.find((q) => q.id === ctx.params.id);
    if (!question) throw new WireError(404, 'NOT_FOUND', 'Pergunta não encontrada');
    if (question.status !== 'open') throw new WireError(409, 'TAB_PROMPT_CHANGED', 'A pergunta mudou na aba');
    return { status: 200, body: { text: tabQuestionScreenText(question) } };
  });

  /** Sends a tab's suggestion (no PIN): 404 unknown, 409 once it is not open. */
  router.route('POST', '/api/m/v1/chat/tab-suggestions/:id/send', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const suggestion = state.tabSuggestions.find((s) => s.id === ctx.params.id);
    if (!suggestion) throw new WireError(404, 'NOT_FOUND', 'Sugestão não encontrada');
    if (suggestion.status !== 'open') throw new WireError(409, 'TAB_PROMPT_CHANGED', 'A sugestão mudou na aba');
    const body = tabSuggestionSendBody.parse(ctx.body);
    Object.assign(suggestion, { status: 'answered', answer: { text: body.text }, answered_at: new Date(ctx.now()).toISOString() });
    const view = tabSuggestionView(suggestion);
    broadcast(state, { type: 'tab_suggestion_closed', user_id: USER_ID, conversation_id: suggestion.conversation_id, suggestion: view });
    return { status: 200, body: { tab_suggestion: view } };
  });

  /** "Dispensar": idempotent — a suggestion that is not open any more comes back as it is. */
  router.route('POST', '/api/m/v1/chat/tab-suggestions/:id/dismiss', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const suggestion = state.tabSuggestions.find((s) => s.id === ctx.params.id);
    if (!suggestion) throw new WireError(404, 'NOT_FOUND', 'Sugestão não encontrada');
    if (suggestion.status === 'open') {
      Object.assign(suggestion, { status: 'dismissed', closed_at: new Date(ctx.now()).toISOString() });
      broadcast(state, { type: 'tab_suggestion_closed', user_id: USER_ID, conversation_id: suggestion.conversation_id, suggestion: tabSuggestionView(suggestion) });
    }
    return { status: 200, body: { tab_suggestion: tabSuggestionView(suggestion) } };
  });
}
