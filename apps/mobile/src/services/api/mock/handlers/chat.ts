// Chat routes (P§6, design spec §4.2 "Chat"/"Controls"): projects, the conversation payload,
// sending a message (`202` then a reply streamed over the socket), decisions, trusted tabs
// ("Permitir sempre nesta aba") and reset.
import { z } from 'zod';
import { decisionProof } from '../../../crypto/pin';
import { randomId } from '../../../crypto/random';
import {
  chatGrantListQuery,
  chatMemoryPatchBody,
  isBoardGrantable,
  isTabGrantable,
  isTerminalGrantable,
  kindFromNameAndMime,
  mobileBatchDecisionBody,
  mobileDecisionBody,
  mobileMessageBody,
  replyExcerpt,
  resetBody,
  tabQuestionReplyText,
  type ReplyCardRef,
  projectFavoriteBody,
  setHostBody,
  standingKindOf,
  type StandingGrantKind,
  tabQuestionAnswerBody,
  projectAiBody,
  tabLimitAnswerBody,
  tabSuggestionSendBody,
  type PinDecision,
  type TChatAttachment,
  type TChatEvent,
  type TChatGrant,
  type TChatGrantListItem,
  type TChatHostState,
  type TChatMemory,
  type TChatProjectGrant,
  type TChatStandingGrant,
  type TProjectAiOption,
  type TSubagentView,
  type TTabLimit,
  type TTabQuestion,
  type TTabSuggestion,
} from '../../contract';
import type { MockRouter } from '../router';
import { broadcast, countPinFailure, type MockAction, type MockAttachment, type MockConversation, type MockDecision, type MockDevice, type MockGrant, type MockLesson, type MockMessage, type MockNote, type MockProjectGrant, type MockStandingGrant, type MockSubagent, type MockState, type MockTabLimit, type MockTabQuestion, type MockTabSuggestion, verifyAuth, WireError } from '../state';
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

/** The tabs the fixtures' actions point at, by id -> name and project (the server joins the tab row
 * for `tab_name`, and resolves a terminal card's project through its tab; a tab the mock does not
 * know is one that "no longer exists": `null` name, no project). */
const TABS: Record<string, { name: string; project_id: string }> = { 't-api': { name: 'api', project_id: 'p-termhub' } };

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

const replyUnavailable = () => new WireError(409, 'REPLY_UNAVAILABLE', 'A mensagem citada não está mais disponível. Cancele a citação e envie de novo.');

/** The server's rule for `reply_to_card` (TER-849): a gate card or a tab's question of this conversation. */
function replyCardTargetOf(state: MockState, conversationId: string, card: ReplyCardRef): NonNullable<MockMessage['reply_to']> {
  if (card.kind === 'action') {
    const action = state.actions.get(card.id);
    if (!action || action.conversation_id !== conversationId) throw replyUnavailable();
    return { id: null, role: 'assistant', excerpt: replyExcerpt(action.summary), card };
  }
  const question = state.tabQuestions.find((q) => q.id === card.id && q.conversation_id === conversationId);
  if (!question) throw replyUnavailable();
  return { id: null, role: 'assistant', excerpt: replyExcerpt(tabQuestionReplyText(question)), card };
}

/** The server's rule for `reply_to_id` (TER-447): a message of this conversation with words or files. */
function replyTargetOf(state: MockState, conversationId: string, id: string | undefined, card?: ReplyCardRef): NonNullable<MockMessage['reply_to']> | null {
  if (card) return replyCardTargetOf(state, conversationId, card);
  if (id === undefined) return null;
  const row = state.messages.get(conversationId)?.find((m) => m.id === id);
  const names = (row?.attachments ?? []).map((a) => a.name);
  if (!row || (!row.text && names.length === 0)) throw replyUnavailable();
  return { id: row.id, role: row.role, excerpt: replyExcerpt(row.text, names) };
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

/** Trusts the tab of `action` (just approved): any other grant of the same tab and tool in that
 * conversation is revoked first — at most one per (tab, tool), as the server's partial unique index
 * keeps it. A `terminal` grant also revokes the narrow `send_input` one of that tab (the server's
 * `grantTabTerminal`); a narrow grant leaves an active `terminal` one alone. Returns the new grant
 * and the grants it revoked, whose `grant_revoked` the caller publishes. */
function grantTab(state: MockState, action: MockAction, now: number, tool: 'send_input' | 'terminal'): { grant: MockGrant; revoked: MockGrant[] } {
  const replaces = tool === 'terminal' ? ['terminal', 'send_input'] : [tool];
  const revoked: MockGrant[] = [];
  for (const g of state.grants) {
    if (g.conversation_id === action.conversation_id && g.tab_id === action.tab_id && replaces.includes(g.tool) && !g.revoked) {
      revoked.push(g);
      g.revoked = true;
      g.revoked_at = new Date(now).toISOString();
      g.revoked_by_user = true;
    }
  }
  const grant: MockGrant = {
    id: randomId(10),
    conversation_id: action.conversation_id,
    tab_id: action.tab_id!,
    tool,
    source_action_id: action.id,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + GRANT_TTL_MS).toISOString(),
    tab_name: TABS[action.tab_id!]?.name ?? null,
    revoked: false,
    revoked_at: null,
    revoked_by_user: false,
  };
  state.grants.push(grant);
  return { grant, revoked };
}

/** The wire shape of a project grant (the server's `ChatProjectGrantView`): `project_name` resolved
 * from the mock's own project fixtures, null once the project is gone. */
function projectGrantView(state: MockState, g: MockProjectGrant): TChatProjectGrant {
  return { id: g.id, project_id: g.project_id, project_name: state.projects.get(g.project_id)?.name ?? null, source_action_id: g.source_action_id, created_at: g.created_at, expires_at: g.expires_at, scope: g.scope };
}

/** `GET chat`'s `project_grants`: the conversation's project grants still in force, oldest first. */
function activeProjectGrantsFor(state: MockState, conversationId: string, now: number): TChatProjectGrant[] {
  return state.projectGrants.filter((g) => g.conversation_id === conversationId && !g.revoked && Date.parse(g.expires_at) > now).map((g) => projectGrantView(state, g));
}

/** Trusts `projectId` for `action` (just approved): any other grant of the same project in that
 * conversation is revoked first — at most one per project, mirroring `grantTab`. The caller resolves
 * the project (`grantableProjectOf`) the way the server does. */
function grantProject(state: MockState, action: MockAction, projectId: string, now: number, scope: 'board' | 'all'): MockProjectGrant {
  for (const g of state.projectGrants) {
    if (g.conversation_id === action.conversation_id && g.project_id === projectId && !g.revoked) {
      g.revoked = true;
      g.revoked_at = new Date(now).toISOString();
      g.revoked_by_user = true;
    }
  }
  const grant: MockProjectGrant = {
    id: randomId(10),
    conversation_id: action.conversation_id,
    project_id: projectId,
    scope,
    source_action_id: action.id,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + GRANT_TTL_MS).toISOString(),
    revoked: false,
    revoked_at: null,
    revoked_by_user: false,
  };
  state.projectGrants.push(grant);
  return grant;
}

/** The wire shape of a standing grant (the server's `ChatStandingGrantView`), `project_name` resolved
 * like `projectGrantView`'s. */
function standingGrantView(state: MockState, g: MockStandingGrant): TChatStandingGrant {
  return { id: g.id, project_id: g.project_id, project_name: state.projects.get(g.project_id)?.name ?? null, kind: g.kind, source_action_id: g.source_action_id, created_at: g.created_at };
}

/** `GET chat`'s `standing_grants` (TER-386): not the conversation's but the user's — the project's
 * own, or every one of them in the account-wide chat (`projectId` null); oldest first. */
function activeStandingGrantsFor(state: MockState, projectId: string | null): TChatStandingGrant[] {
  return state.standingGrants.filter((g) => !g.revoked && (projectId === null || g.project_id === projectId)).map((g) => standingGrantView(state, g));
}

/** The project a standing grant of `kind` trusts, as the server's `standingProjectOf` resolves it: a
 * tab's own project for `close_tab` and `terminal`, the card's project for the rest — or null. */
function standingProjectOf(action: MockAction, kind: StandingGrantKind): string | null {
  if (kind === 'close_tab' || kind === 'terminal') return (action.tab_id && TABS[action.tab_id]?.project_id) || null;
  return action.project_id;
}

/** Trusts `kind` on `projectId` with no expiry: an active grant of the same (project, kind) is revoked
 * first — at most one, as the server's partial unique index keeps it. */
function grantStanding(state: MockState, action: MockAction, projectId: string, kind: StandingGrantKind, now: number): MockStandingGrant {
  for (const g of state.standingGrants) {
    if (g.project_id === projectId && g.kind === kind && !g.revoked) {
      g.revoked = true;
      g.revoked_at = new Date(now).toISOString();
    }
  }
  const grant: MockStandingGrant = {
    id: randomId(10),
    conversation_id: action.conversation_id,
    project_id: projectId,
    kind,
    source_action_id: action.id,
    created_at: new Date(now).toISOString(),
    revoked: false,
    revoked_at: null,
  };
  state.standingGrants.push(grant);
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

// --- usage-limit cards and the project's AI accounts (spec 2026-09-30 project AI accounts §7.2, §8) --

function tabLimitView(l: MockTabLimit): TTabLimit {
  const { conversation_id: _conversation, ...view } = l;
  return view;
}

/** The canned card a `limite…` message makes the tab `api` raise: its account hit the limit on `jarvis`,
 * which does not swap by itself, and the project has one more account there. */
function createTabLimit(state: MockState, now: number, conversationId: string): MockTabLimit {
  const limit: MockTabLimit = {
    id: randomId(10),
    conversation_id: conversationId,
    tab_id: 't-api',
    tab_name: 'api',
    payload: { account: { id: 'acc-1', label: 'Claude Pedro' }, machine: { id: 'm-jarvis', name: 'jarvis' }, resets_at: new Date(now + 2 * 60 * 60_000).toISOString(), candidates: [{ id: 'acc-2', label: 'Claude Trabalho' }] },
    status: 'open',
    result: null,
    created_at: new Date(now).toISOString(),
    closed_at: null,
  };
  state.tabLimits.push(limit);
  return limit;
}

/** What every project may list (`GET projects/:id/setup/ai`'s `available`): the accounts of the machines
 * the fixtures link to every project. `acc-3` is a Codex login, so the phone shows both providers. */
const PROJECT_AI_OPTIONS: TProjectAiOption[] = [
  { id: 'acc-1', label: 'Claude Pedro', provider: 'claude', machine_id: 'm-jarvis', machine_name: 'jarvis', default: true },
  { id: 'acc-2', label: 'Claude Trabalho', provider: 'claude', machine_id: 'm-jarvis', machine_name: 'jarvis', default: false },
  { id: 'acc-3', label: 'Codex Pedro', provider: 'chatgpt', machine_id: 'm-jarvis', machine_name: 'jarvis', default: true },
];

// --- subagents panel (spec 2026-09-26 panel §4) -------------------------------------------------

/** The wire shape of a subagent row (the server's `SubagentView`). */
function subagentView(s: MockSubagent): TSubagentView {
  const { conversation_id: _conversation, ...view } = s;
  return view;
}

function subagentEvent(s: MockSubagent): TChatEvent {
  return { type: 'subagent', user_id: USER_ID, conversation_id: s.conversation_id, subagent: subagentView(s) };
}

/** The canned subagent a `subagente` message starts running — the mock's stand-in for the concierge
 * spawning one, `stepMs` before the reply that names it (`scheduleStream`'s own timing). */
function createSubagent(state: MockState, now: number, conversationId: string): MockSubagent {
  const subagent: MockSubagent = { id: randomId(10), conversation_id: conversationId, description: 'Buscar CI', subagent_type: 'general-purpose', status: 'running', started_at: new Date(now).toISOString(), ended_at: null };
  state.subagents.push(subagent);
  return subagent;
}

// --- the canned reply and its streaming (ruling 3) ----------------------------------------------

interface AnswerOutcome {
  kind: 'normal' | 'confirmation' | 'error' | 'tab_question' | 'tab_permission' | 'tab_suggestion' | 'tab_limit' | 'subagent';
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
  if (/limite/.test(text)) return { kind: 'tab_limit', text: 'A aba api atingiu o limite de uso da conta — veja o card.' };
  if (/subagente/.test(text)) return { kind: 'subagent', text: 'Chamei uma subagente para isso — acompanhe no painel.' };
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
  /** What the message answers (TER-447), already cut like the server's snapshot. */
  replyTo: NonNullable<MockMessage['reply_to']> | null;
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
      ...(o.replyTo ? { reply_to: o.replyTo } : {}),
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

      if (outcome.kind === 'tab_limit') {
        const limit = createTabLimit(o.state, o.now(), o.conversationId);
        broadcast(o.state, { type: 'tab_limit', user_id: USER_ID, conversation_id: o.conversationId, notice: tabLimitView(limit) });
      }

      if (outcome.kind === 'subagent') {
        const subagent = createSubagent(o.state, o.now(), o.conversationId);
        broadcast(o.state, subagentEvent(subagent));
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
    kind: 'tab',
    ...grantView(g),
    scope: null,
    standing_kind: null,
    project_id: project?.id ?? null,
    project_name: project?.name ?? null,
    conversation_id: g.conversation_id,
    conversation_project_name: project?.name ?? null,
    conversation_archived: conversation?.archived_at != null,
    state: s,
    ended_at: s === 'active' ? null : s === 'expired' ? g.expires_at : g.revoked_at,
  };
}

/** The mock's `ChatGrantListItem` for a project grant ("Permitir sempre neste projeto", design spec
 * 2026-09-26 §7): `project_id`/`project_name` name the *trusted* project, which need not be the
 * conversation's own (`conversation_project_name`) — a project grant can be created from a board
 * card in the account-wide chat. */
function projectGrantListItem(state: MockState, g: MockProjectGrant, now: number): TChatGrantListItem {
  const expiresAt = Date.parse(g.expires_at);
  const revokedFirst = g.revoked && g.revoked_at !== null && Date.parse(g.revoked_at) < expiresAt;
  const s = revokedFirst ? (g.revoked_by_user ? 'revoked' : 'ended') : !g.revoked && expiresAt > now ? 'active' : 'expired';
  const conversation = state.conversations.get(g.conversation_id);
  const conversationProject = conversation?.project_id ? state.projects.get(conversation.project_id) : undefined;
  const grantedProject = state.projects.get(g.project_id);
  return {
    kind: 'project',
    id: g.id,
    tab_id: null,
    tool: null,
    source_action_id: g.source_action_id,
    created_at: g.created_at,
    expires_at: g.expires_at,
    tab_name: null,
    scope: g.scope,
    standing_kind: null,
    project_id: grantedProject?.id ?? null,
    project_name: grantedProject?.name ?? null,
    conversation_id: g.conversation_id,
    conversation_project_name: conversationProject?.name ?? null,
    conversation_archived: conversation?.archived_at != null,
    state: s,
    ended_at: s === 'active' ? null : s === 'expired' ? g.expires_at : g.revoked_at,
  };
}

/** The mock's `ChatGrantListItem` for a standing grant (TER-386): no expiry, so only `active` or
 * `revoked`; the granting conversation may be gone (`conversation_id` null). */
function standingGrantListItem(state: MockState, g: MockStandingGrant): TChatGrantListItem {
  const conversation = state.conversations.get(g.conversation_id);
  const conversationProject = conversation?.project_id ? state.projects.get(conversation.project_id) : undefined;
  const grantedProject = state.projects.get(g.project_id);
  return {
    kind: 'standing',
    id: g.id,
    tab_id: null,
    tool: null,
    source_action_id: g.source_action_id,
    created_at: g.created_at,
    expires_at: null,
    tab_name: null,
    scope: null,
    standing_kind: g.kind,
    project_id: grantedProject?.id ?? null,
    project_name: grantedProject?.name ?? null,
    conversation_id: conversation ? g.conversation_id : null,
    conversation_project_name: conversationProject?.name ?? null,
    conversation_archived: conversation?.archived_at != null,
    state: g.revoked ? 'revoked' : 'active',
    ended_at: g.revoked ? g.revoked_at : null,
  };
}

// --- chat memory (spec 2026-09-26 §4.6, concierge memory D8/D12) ----------------------------

/** 50 per page, same as the server's `DECISIONS_PAGE`/`NOTES_PAGE`/`LESSONS_PAGE` (`apps/server/src/routes/chat-memory.ts`). */
const DECISIONS_PAGE = 50;
const NOTES_PAGE = 50;
const LESSONS_PAGE = 50;

/** `q` matches the question, the header, the answer (labels or free text) or the project name —
 * mirrors `repos.chatDecisions.listForUser`'s `ILIKE` over the same columns. */
function matchesDecisionQuery(d: MockDecision, q: string): boolean {
  const needle = q.toLowerCase();
  const answer = d.answer.text ?? d.answer.labels.join(' ');
  return [d.question, d.header, answer, d.project_name ?? ''].some((s) => s.toLowerCase().includes(needle));
}

/** `q` matches the title or the excerpt (the server's `ILIKE` over `title`/`text`) — spec 2026-09-27
 * failure lessons §6. */
function matchesLessonQuery(l: MockLesson, q: string): boolean {
  const needle = q.toLowerCase();
  return [l.title, l.excerpt, l.project?.name ?? '', l.path ?? ''].some((s) => s.toLowerCase().includes(needle));
}

function chatMemoryView(state: MockState): TChatMemory {
  // `available` has no fixture for "false" (no server config to mirror in the mock) — every mock
  // run behaves as if embeddings were configured, like a dev server normally would be.
  return { enabled: state.chatMemoryEnabled, autodecide: state.chatAutodecideEnabled, codex_replies: state.chatCodexRepliesEnabled, available: true, count: state.decisions.length, notes: state.notes.length };
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
  decision: PinDecision,
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
        favorite_position: state.favorites.includes(project.id) ? state.favorites.indexOf(project.id) : null,
      };
    });
    return { status: 200, body: { projects } };
  });

  router.route('PUT', '/api/m/v1/chat/projects/:id/favorite', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'PUT', htu: ctx.htu, now: ctx.now() });
    const { favorite } = projectFavoriteBody.parse(ctx.body);
    const id = ctx.params.id!;
    if (!state.projects.has(id)) throw new WireError(404, 'NOT_FOUND', 'Projeto não encontrado');
    const without = state.favorites.filter((p) => p !== id);
    // Pinned again: keeps its place, as the server does; a new pin goes last.
    if (favorite) state.favorites = state.favorites.includes(id) ? state.favorites : [...without, id];
    else state.favorites = without;
    return { status: 204, body: {} };
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
        project_grants: activeProjectGrantsFor(state, conversation.id, ctx.now()),
        standing_grants: activeStandingGrantsFor(state, projectId),
        tab_questions: state.tabQuestions.filter((q) => q.conversation_id === conversation.id).map(tabQuestionView),
        tab_suggestions: state.tabSuggestions.filter((s) => s.conversation_id === conversation.id).map(tabSuggestionView),
        tab_limits: state.tabLimits.filter((l) => l.conversation_id === conversation.id).map(tabLimitView),
        subagents: state.subagents.filter((s) => s.conversation_id === conversation.id).map(subagentView),
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
    const replyTo = replyTargetOf(state, conversation.id, body.reply_to_id, body.reply_to_card);
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
      replyTo,
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
    // A reset ends the old conversation's trusted tabs and project boards too (the server's
    // `revokeForConversation`, called for both repositories).
    for (const g of state.grants) {
      if (g.conversation_id === previous.id && !g.revoked) {
        g.revoked = true;
        g.revoked_at = new Date(ctx.now()).toISOString();
        g.revoked_by_user = false;
      }
    }
    for (const g of state.projectGrants) {
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
      if (body.decision !== 'approve' || action.class !== 'write') throw new WireError(401, 'PIN_REQUIRED', 'Confirme com o PIN para autorizar esta ação.');
      action.status = 'approved';
      broadcast(state, { type: 'decision', user_id: USER_ID, conversation_id: action.conversation_id, action_id: action.id, status: 'approved' });
      return { status: 200, body: {} };
    }

    // An ineligible grant is refused before the challenge is spent or the PIN checked (design spec
    // 2026-09-26 §2, §5): the four board tools, and the card's project must resolve.
    if (body.decision === 'approve_tab' && !isTabGrantable({ tool: action.tool, args: action.args, tab_id: action.tab_id })) {
      throw new WireError(400, 'GRANT_NOT_ALLOWED', 'Só dá para permitir sempre o envio de texto para uma aba');
    }
    if (body.decision === 'approve_project' && (!isBoardGrantable({ tool: action.tool }) || action.project_id === null)) {
      throw new WireError(400, 'GRANT_NOT_ALLOWED', 'Não dá para permitir sempre neste projeto aqui');
    }
    // TER-325: keys and shell for a tab (send_input not answering a dialog, or send_key, to a tab);
    // everything in the project for such a card or a board card, whose project must resolve.
    const terminal = isTerminalGrantable({ tool: action.tool, args: action.args, tab_id: action.tab_id });
    if (body.decision === 'approve_tab_terminal' && !terminal) {
      throw new WireError(400, 'GRANT_NOT_ALLOWED', 'Só dá para liberar teclas e shell numa ação de terminal de uma aba');
    }
    // The project a board card names (`action.project_id`, set by the fixtures the way the server
    // resolves it from the card's own arguments), or, for a terminal card, its tab's project — real
    // send_key/send_input rows carry `project_id: null`, like the server's `terminalTabOf`.
    const grantedProjectId =
      body.decision === 'approve_project_all' ? (terminal ? (TABS[action.tab_id!]?.project_id ?? null) : isBoardGrantable({ tool: action.tool }) ? action.project_id : null) : action.project_id;
    if (body.decision === 'approve_project_all' && grantedProjectId === null) {
      throw new WireError(400, 'GRANT_NOT_ALLOWED', 'Não dá para liberar tudo neste projeto aqui');
    }
    // TER-386: a standing kind for the card, and the project it trusts, resolved like the server does.
    const standingKind = body.decision === 'approve_project_always' ? standingKindOf({ tool: action.tool, args: action.args, tab_id: action.tab_id, project_id: action.project_id }) : null;
    const standingProjectId = standingKind ? standingProjectOf(action, standingKind) : null;
    if (body.decision === 'approve_project_always' && standingProjectId === null) {
      throw new WireError(400, 'GRANT_NOT_ALLOWED', 'Não dá para liberar sem prazo neste projeto aqui');
    }

    checkDecisionProof(state, device, action.id, body.decision, { challenge: body.challenge!, pin_proof: body.pin_proof! }, now);
    device.pinFailures = 0;
    action.status = 'approved';
    broadcast(state, { type: 'decision', user_id: USER_ID, conversation_id: action.conversation_id, action_id: action.id, status: 'approved' });
    if (body.decision === 'approve') return { status: 200, body: {} };

    if (body.decision === 'approve_tab' || body.decision === 'approve_tab_terminal') {
      const made = grantTab(state, action, now, body.decision === 'approve_tab' ? 'send_input' : 'terminal');
      // Widening revokes the narrow grant of that tab; screens hear it, as from the server (a same-tool
      // re-grant is not announced: screens replace it by tab and tool on the `grant` event).
      for (const g of made.revoked.filter((r) => r.tool !== made.grant.tool)) broadcast(state, { type: 'grant_revoked', user_id: USER_ID, conversation_id: action.conversation_id, grant_id: g.id });
      const grant = grantView(made.grant);
      broadcast(state, { type: 'grant', user_id: USER_ID, conversation_id: action.conversation_id, grant });
      return { status: 200, body: { grant } };
    }

    if (body.decision === 'approve_project_always') {
      // Answered under its own key, `standing_grant` (routes/m-chat.ts).
      const standingGrant = standingGrantView(state, grantStanding(state, action, standingProjectId!, standingKind!, now));
      broadcast(state, { type: 'standing_grant', user_id: USER_ID, conversation_id: action.conversation_id, grant: standingGrant });
      return { status: 200, body: { standing_grant: standingGrant } };
    }

    // The server answers a project grant under its own key, `project_grant` (routes/m-chat.ts).
    const projectGrant = projectGrantView(state, grantProject(state, action, grantedProjectId!, now, body.decision === 'approve_project_all' ? 'all' : 'board'));
    broadcast(state, { type: 'project_grant', user_id: USER_ID, conversation_id: action.conversation_id, grant: projectGrant });
    return { status: 200, body: { project_grant: projectGrant } };
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

  /** "Permissões do chat": the server's paging (newest first, cursor = the last row's id). With
   * `kinds=all` (the default is `tab`, for an app or a server predating project grants), tab and
   * project rows — and standing rows too with `kinds=all_standing` (TER-386) — are merged by
   * `created_at` before paging — mirrors the server's cursor, valid for every table since it is just
   * `(created_at, id)`. */
  router.route('GET', '/api/m/v1/chat/grants', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const q = chatGrantListQuery.parse(ctx.query);
    const now = ctx.now();
    const tabRows = state.grants.map((g) => grantListItem(state, g, now));
    const projectRows = q.kinds === 'tab' ? [] : state.projectGrants.map((g) => projectGrantListItem(state, g, now));
    // Standing rows only for an app that asks for them (TER-386): an older one cannot show a row with no expiry.
    const standingRows = q.kinds === 'all_standing' ? state.standingGrants.map((g) => standingGrantListItem(state, g)) : [];
    const rows = [...tabRows, ...projectRows, ...standingRows]
      .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1))
      .filter((g) => (q.state === 'active' ? g.state === 'active' : g.state !== 'active'));
    const start = q.state === 'ended' && q.cursor ? rows.findIndex((g) => g.id === q.cursor) + 1 : 0;
    const page = rows.slice(start, start + q.limit);
    const more = q.state === 'ended' && start + q.limit < rows.length;
    return { status: 200, body: { grants: page, next_cursor: more ? page[page.length - 1]!.id : null } };
  });

  /** "Revogar" (no PIN: it only takes power away): looks in the three repositories, like the server's
   * `revokeGrant` — ids never collide (`randomId`). 404 unknown, 409 already revoked. */
  router.route('DELETE', '/api/m/v1/chat/grants/:id', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'DELETE', htu: ctx.htu, now: ctx.now() });
    const grant = state.grants.find((g) => g.id === ctx.params.id);
    if (grant) {
      if (grant.revoked) throw new WireError(409, 'CONFLICT', 'Esta permissão já foi revogada');
      grant.revoked = true;
      grant.revoked_at = new Date(ctx.now()).toISOString();
      grant.revoked_by_user = true;
      broadcast(state, { type: 'grant_revoked', user_id: USER_ID, conversation_id: grant.conversation_id, grant_id: grant.id });
      return { status: 200, body: { grant: grantView(grant) } };
    }

    const standingGrant = state.standingGrants.find((g) => g.id === ctx.params.id);
    if (standingGrant) {
      if (standingGrant.revoked) throw new WireError(409, 'CONFLICT', 'Esta permissão já foi revogada');
      standingGrant.revoked = true;
      standingGrant.revoked_at = new Date(ctx.now()).toISOString();
      broadcast(state, { type: 'standing_grant_revoked', user_id: USER_ID, conversation_id: standingGrant.conversation_id, grant_id: standingGrant.id });
      return { status: 200, body: { grant: standingGrantView(state, standingGrant) } };
    }

    const projectGrant = state.projectGrants.find((g) => g.id === ctx.params.id);
    if (!projectGrant) throw new WireError(404, 'NOT_FOUND', 'Permissão não encontrada');
    if (projectGrant.revoked) throw new WireError(409, 'CONFLICT', 'Esta permissão já foi revogada');
    projectGrant.revoked = true;
    projectGrant.revoked_at = new Date(ctx.now()).toISOString();
    projectGrant.revoked_by_user = true;
    broadcast(state, { type: 'project_grant_revoked', user_id: USER_ID, conversation_id: projectGrant.conversation_id, grant_id: projectGrant.id });
    return { status: 200, body: { grant: projectGrantView(state, projectGrant) } };
  });

  /** Answers a tab's question (no PIN): 404 unknown, 409 once it is closed, 400 a body of the other kind. */
  router.route('POST', '/api/m/v1/chat/tab-questions/:id/answer', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const question = state.tabQuestions.find((q) => q.id === ctx.params.id);
    if (!question) throw new WireError(404, 'NOT_FOUND', 'Pergunta não encontrada');
    if (question.status !== 'open') throw new WireError(409, 'TAB_PROMPT_CHANGED', 'A aba já não mostra esta pergunta: nada foi enviado.');
    const body = tabQuestionAnswerBody.parse(ctx.body);
    if ((question.kind === 'choice') !== 'answers' in body) throw new WireError(400, 'VALIDATION', 'Dados inválidos');
    Object.assign(question, { status: 'answered', answer: body, answered_at: new Date(ctx.now()).toISOString() });
    const view = tabQuestionView(question);
    broadcast(state, { type: 'tab_question_answered', user_id: USER_ID, conversation_id: question.conversation_id, question: view });
    return { status: 200, body: { tab_question: view } };
  });

  /** "Cancelar" on a countdown (concierge memory spec 2026-09-26 §6): keeps the card open, the
   * proposed answer stays as its own pre-selection; 404 unknown, 409 `NOT_SCHEDULED` when no
   * countdown is running (already sent, failed, cancelled, or never scheduled) — mirrors the
   * server's `cancelAutoAnswer` (apps/server/src/chat/auto-answer.ts). */
  router.route('POST', '/api/m/v1/chat/tab-questions/:id/auto-answer/cancel', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const question = state.tabQuestions.find((q) => q.id === ctx.params.id);
    if (!question) throw new WireError(404, 'NOT_FOUND', 'Pergunta não encontrada');
    if (question.auto_answer?.status !== 'scheduled') throw new WireError(409, 'NOT_SCHEDULED', 'Não há resposta automática em contagem nesta pergunta');
    question.auto_answer = { ...question.auto_answer, status: 'cancelled', decided_by: USER_ID };
    const view = tabQuestionView(question);
    broadcast(state, { type: 'tab_question', user_id: USER_ID, conversation_id: question.conversation_id, question: view });
    return { status: 200, body: { tab_question: view } };
  });

  router.route('GET', '/api/m/v1/chat/tab-questions/:id/screen', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const question = state.tabQuestions.find((q) => q.id === ctx.params.id);
    if (!question) throw new WireError(404, 'NOT_FOUND', 'Pergunta não encontrada');
    if (question.status !== 'open') throw new WireError(409, 'TAB_PROMPT_CHANGED', 'A aba já não mostra esta pergunta: nada foi enviado.');
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

  /** A usage-limit card's answer (no PIN): 404 unknown, 409 once it is not open, 400 for an account that is
   * not one of its candidates. The mock's swap always works: the card closes as `swapped`. */
  router.route('POST', '/api/m/v1/chat/tab-limits/:id/answer', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const limit = state.tabLimits.find((l) => l.id === ctx.params.id);
    if (!limit) throw new WireError(404, 'NOT_FOUND', 'Aviso não encontrado');
    if (limit.status !== 'open') throw new WireError(409, 'CONFLICT', 'Este aviso já foi respondido ou expirou');
    const { account_id } = tabLimitAnswerBody.parse(ctx.body);
    if (account_id !== null && !limit.payload.candidates.some((c) => c.id === account_id)) throw new WireError(400, 'BAD_REQUEST', 'Essa conta não está entre as opções do aviso');
    Object.assign(limit, account_id === null ? { status: 'dismissed', result: null } : { status: 'swapped', result: account_id }, { closed_at: new Date(ctx.now()).toISOString() });
    const view = tabLimitView(limit);
    broadcast(state, { type: 'tab_limit_closed', user_id: USER_ID, conversation_id: limit.conversation_id, notice: view });
    return { status: 200, body: { tab_limit: view } };
  });

  router.route('GET', '/api/m/v1/projects/:id/setup/ai', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const id = ctx.params.id!;
    if (!state.projects.has(id)) throw new WireError(404, 'NOT_FOUND', 'Projeto não encontrado');
    return { status: 200, body: { ai: state.projectAi.get(id) ?? { accounts: [], models: { claude: null, chatgpt: null } }, available: PROJECT_AI_OPTIONS } };
  });

  /** Saves the project's accounts and models: 400 naming the first account it cannot list, nothing saved then. */
  router.route('PUT', '/api/m/v1/projects/:id/setup/ai', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'PUT', htu: ctx.htu, now: ctx.now() });
    const id = ctx.params.id!;
    if (!state.projects.has(id)) throw new WireError(404, 'NOT_FOUND', 'Projeto não encontrado');
    const { ai } = projectAiBody.parse(ctx.body);
    const unknown = ai.accounts.find((a) => !PROJECT_AI_OPTIONS.some((o) => o.id === a));
    if (unknown !== undefined) throw new WireError(400, 'BAD_REQUEST', `Conta de IA inexistente: ${unknown}`);
    state.projectAi.set(id, ai);
    return { status: 200, body: { ai, available: PROJECT_AI_OPTIONS } };
  });

  /**
   * "Cancelar" on a subagent's row (spec 2026-09-26 panel §5.4): 404 unknown, 409 `SUBAGENT_NOT_RUNNING`
   * for a row already at rest. The mock has no live CLI process to ask, so it never answers
   * `SUBAGENT_GONE`: the row always settles to `stopped` after the same `stepMs` every other canned
   * step takes, broadcasting `subagent` twice (`stopping`, then `stopped`) like the real cancel does
   * (`stopping` then the CLI's own confirmation).
   */
  router.route('POST', '/api/m/v1/chat/subagents/:id/cancel', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const subagent = state.subagents.find((s) => s.id === ctx.params.id);
    if (!subagent) throw new WireError(404, 'NOT_FOUND', 'Subagente não encontrado.');
    if (subagent.status !== 'running') throw new WireError(409, 'SUBAGENT_NOT_RUNNING', 'Este subagente não está rodando.');
    subagent.status = 'stopping';
    broadcast(state, subagentEvent(subagent));
    setTimeout(() => {
      if (subagent.status !== 'stopping') return; // already resolved otherwise
      subagent.status = 'stopped';
      subagent.ended_at = new Date(ctx.now()).toISOString();
      broadcast(state, subagentEvent(subagent));
    }, stepMs);
    return { status: 202, body: { subagent: subagentView(subagent) } };
  });

  // --- "Memória do chat" (spec 2026-09-26 §4.6/§5.2) --------------------------------------------

  router.route('GET', '/api/m/v1/chat/decisions', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const q = ctx.query.q?.trim();
    let list = [...state.decisions].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first
    if (q) list = list.filter((d) => matchesDecisionQuery(d, q));
    const cursor = ctx.query.cursor;
    const start = cursor ? Math.max(0, list.findIndex((d) => d.id === cursor) + 1) : 0;
    const decisions = list.slice(start, start + DECISIONS_PAGE);
    const next_cursor = start + DECISIONS_PAGE < list.length ? (decisions[decisions.length - 1]?.id ?? null) : null;
    return { status: 200, body: { decisions, next_cursor } };
  });

  /** Idempotent and silent about whether `id` ever existed (the server scopes the delete to the
   * requester in SQL, so there is nothing left to distinguish there either): always 204. */
  router.route('DELETE', '/api/m/v1/chat/decisions/:id', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'DELETE', htu: ctx.htu, now: ctx.now() });
    const idx = state.decisions.findIndex((d) => d.id === ctx.params.id);
    if (idx !== -1) state.decisions.splice(idx, 1);
    return { status: 204, body: {} };
  });

  router.route('GET', '/api/m/v1/chat/memory', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: chatMemoryView(state) };
  });

  router.route('PATCH', '/api/m/v1/chat/memory', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'PATCH', htu: ctx.htu, now: ctx.now() });
    const body = chatMemoryPatchBody.parse(ctx.body);
    if (body.enabled !== undefined) state.chatMemoryEnabled = body.enabled;
    if (body.autodecide !== undefined) state.chatAutodecideEnabled = body.autodecide;
    if (body.codex_replies !== undefined) state.chatCodexRepliesEnabled = body.codex_replies;
    return { status: 200, body: chatMemoryView(state) };
  });

  // --- "Anotações do concierge" (spec D12/§8) -----------------------------------------------

  router.route('GET', '/api/m/v1/chat/notes', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const list: MockNote[] = [...state.notes].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first
    const cursor = ctx.query.cursor;
    const start = cursor ? Math.max(0, list.findIndex((n) => n.id === cursor) + 1) : 0;
    const notes = list.slice(start, start + NOTES_PAGE);
    const next_cursor = start + NOTES_PAGE < list.length ? (notes[notes.length - 1]?.id ?? null) : null;
    return { status: 200, body: { notes, next_cursor } };
  });

  /** "Esquecer": idempotent and silent about whether `id` ever existed (the server scopes the
   * delete to `(id, ownerId, kind: 'note')` in SQL, so there is nothing left to distinguish here
   * either): always 204. */
  router.route('DELETE', '/api/m/v1/chat/notes/:id', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'DELETE', htu: ctx.htu, now: ctx.now() });
    const idx = state.notes.findIndex((n) => n.id === ctx.params.id);
    if (idx !== -1) state.notes.splice(idx, 1);
    return { status: 204, body: {} };
  });

  // --- "Lições" (spec 2026-09-27 failure lessons §6/§8) -------------------------------------

  router.route('GET', '/api/m/v1/chat/lessons', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const q = ctx.query.q?.trim();
    let list = [...state.lessons].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first
    if (q) list = list.filter((l) => matchesLessonQuery(l, q));
    const cursor = ctx.query.cursor;
    const start = cursor ? Math.max(0, list.findIndex((l) => l.id === cursor) + 1) : 0;
    const lessons = list.slice(start, start + LESSONS_PAGE);
    const next_cursor = start + LESSONS_PAGE < list.length ? (lessons[lessons.length - 1]?.id ?? null) : null;
    return { status: 200, body: { lessons, next_cursor } };
  });

  /** "Verificar": 404 for an id that is not one of the mock's own lessons — mirrors the server's
   * `findLessonForOwner` scoping. */
  router.route('POST', '/api/m/v1/chat/lessons/:id/verify', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const lesson = state.lessons.find((l) => l.id === ctx.params.id);
    if (!lesson) throw new WireError(404, 'NOT_FOUND', 'Lição não encontrada.');
    lesson.verified = true;
    lesson.verified_at = new Date(ctx.now()).toISOString();
    return { status: 200, body: lesson };
  });

  /** "Desfazer verificação": the inverse, same scope. */
  router.route('DELETE', '/api/m/v1/chat/lessons/:id/verify', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'DELETE', htu: ctx.htu, now: ctx.now() });
    const lesson = state.lessons.find((l) => l.id === ctx.params.id);
    if (!lesson) throw new WireError(404, 'NOT_FOUND', 'Lição não encontrada.');
    lesson.verified = false;
    lesson.verified_at = null;
    return { status: 200, body: lesson };
  });

  /** "Esquecer": a file-origin lesson only ever hides (the response says the file stays in the
   * repository until a PR removes it, same wording as the server); a note-origin one is simply
   * removed here — the mock keeps no project note to trim a block off of. 404 for an unknown id. */
  router.route('DELETE', '/api/m/v1/chat/lessons/:id', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'DELETE', htu: ctx.htu, now: ctx.now() });
    const idx = state.lessons.findIndex((l) => l.id === ctx.params.id);
    if (idx === -1) throw new WireError(404, 'NOT_FOUND', 'Lição não encontrada.');
    const lesson = state.lessons[idx]!;
    state.lessons.splice(idx, 1);
    if (lesson.origin === 'file') return { status: 200, body: { ok: true, note: 'O arquivo continua no repositório; apague-o por um PR para sumir de vez' } };
    return { status: 200, body: { ok: true } };
  });
}
