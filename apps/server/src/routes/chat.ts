import type { FastifyInstance } from 'fastify';
import { answerTabLimit, describeTabLimits } from '../chat/tab-limits.js';
import { tabLimitAnswerBody } from '@termhub/mobile-api';
import { z } from 'zod';
import { chatGrantListQuery, MAX_ATTACHMENTS_PER_MESSAGE, replyCardKind } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import { chatMemoryRoutes } from './chat-memory.js';
import { describeActions } from '../db/repositories/chat-actions-view.js';
import { describeTabQuestions, splitTabRows } from '../db/repositories/tab-questions-view.js';
import { controlContextFor } from '../control/context.js';
import { answerTabQuestion, tabQuestionScreen } from '../chat/tab-question-answer.js';
import { cancelAutoAnswer } from '../chat/auto-answer.js';
import { dismissTabSuggestion, sendTabSuggestion } from '../chat/tab-suggestion-send.js';
import { failureLabel, type ChatService } from '../chat/service.js';
import { defaultEmbedder } from '../chat/embeddings.js';
import { chatBus } from '../chat/bus.js';
import { openAnswersIn } from '../chat/open-answers.js';
import {
  activeGrants,
  activeProjectGrants,
  activeStandingGrants,
  assertGrantableAction,
  assertProjectAllGrantableAction,
  assertProjectGrantableAction,
  assertStandingGrantableAction,
  assertTabTerminalGrantableAction,
  grantProject,
  grantStanding,
  grantTab,
  grantTabTerminal,
  listGrants,
  revokeGrant,
} from '../chat/grants.js';
import { decideMany } from '../chat/decisions.js';
import { DEFAULT_ALLOW_KINDS, DEFAULT_KIND_LABEL } from '../chat/gate.js';
import { indexActions as indexActionsWrite } from '../memory/index-items.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';

/** Indexes decided gate actions, best effort, fire-and-forget — the writer for `chatRoutes`'/
 * `mobileChatRoutes`'s own `deps.indexActions` (spec 2026-09-26 concierge memory §4): only
 * `approved`/`denied` rows carry anything (see `indexActions` itself). Bound once per route
 * registration to that plugin's own repos and logger, so a test can override it to observe calls. */
export type IndexActionsFn = (userId: string, actions: ChatAction[]) => Promise<void>;

/** The same rule as the mobile contract's `mobileMessageBody` (spec 2026-09-26 §5.5): words, files, or both — never neither.
 *  `wait` is accepted for pages loaded before 2026-09-29 and ignored: the route always answers 202 as
 *  soon as the message is stored, like the phone's, and never holds the request for the whole answer. */
const messageBody = z
  .object({
    text: z.string().trim().max(8000).default(''),
    project_id: z.string().min(1).max(64).nullish(),
    attachment_ids: z.array(z.string().min(1).max(64)).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    wait: z.boolean().optional(),
    /** The message this one answers (TER-447). */
    reply_to_id: z.string().min(1).max(64).optional(),
    /** Or the card it answers (TER-849): never both. */
    reply_to_card: z.object({ kind: replyCardKind, id: z.string().min(1).max(64) }).optional(),
  })
  .refine((b) => b.text.length > 0 || (b.attachment_ids?.length ?? 0) > 0, { message: 'Escreva uma mensagem ou anexe um arquivo', path: ['text'] })
  .refine((b) => b.reply_to_id === undefined || b.reply_to_card === undefined, { message: 'Responda a uma mensagem ou a um card, não aos dois', path: ['reply_to_card'] });
const scopeQuery = z.object({ project: z.string().min(1).max(64).optional() });
const resetBody = z.object({ project_id: z.string().min(1).max(64).nullish() });
const actionIdParam = z.object({ id: z.string().min(1).max(64) });
const decisionBody = z.object({ decision: z.enum(['approve', 'deny', 'approve_tab', 'approve_project', 'approve_tab_terminal', 'approve_project_all', 'approve_project_always']) });
const batchBody = z.object({
  decisions: z
    .array(z.object({ id: z.string().min(1).max(64), decision: z.enum(['approve', 'deny']) }))
    .min(1)
    .max(20)
    .refine((d) => new Set(d.map((x) => x.id)).size === d.length, 'Ações repetidas'),
});
const grantIdParam = z.object({ id: z.string().min(1).max(64) });
const defaultKindParam = z.object({ kind: z.enum(DEFAULT_ALLOW_KINDS) });
const defaultAllowedBody = z.object({ allowed: z.boolean() }).strict();

/** The defaults as "Permissões do chat" shows them: server-worded labels, in `DEFAULT_ALLOW_KINDS` order. */
async function chatDefaultsOf(repos: Repositories, userId: string) {
  return (await repos.chatDefaultRestrictions.stateForUser(userId)).map((d) => ({ ...d, label: DEFAULT_KIND_LABEL[d.kind] }));
}
const tabQuestionIdParam = z.object({ id: z.string().min(1).max(64) });
const subagentIdParam = z.object({ id: z.string().min(1).max(64) });
/** The host pair the user picks: the machine, and optionally which of its Claude accounts. No account
 *  (absent or null) means the machine's own default config dir. */
const hostBody = z.object({ machine_id: z.string().min(1).max(64), ai_account_id: z.string().min(1).max(64).nullish() });

/** What a busy-run decision answers with: the decision is already durably recorded (`decide` ran
 * and the bus already published it) before this is ever reached, so a 409 here would tell the
 * client its own successful decision was a conflict. `ChatService.drainNextDecision` injects it as
 * soon as the run that is currently using the conversation's lock finishes — no client action needed. */
const QUEUED_NOTE = 'A decisão foi registrada e será aplicada assim que a resposta atual do concierge terminar.';

/** REST surface for the concierge chat: the conversation, its history and sending a message.
 * Live updates (deltas, actions) travel over `/ws/chat`, not here. */
export async function chatRoutes(app: FastifyInstance, repos: Repositories, deps: { service: ChatService; indexActions?: IndexActionsFn }) {
  // "Memória do chat" (spec 2026-09-26 §4.6): list/forget decisions, read/set the suggestion switch.
  await chatMemoryRoutes(app, repos);
  const indexActions: IndexActionsFn = deps.indexActions ?? ((userId, actions) => indexActionsWrite(repos, userId, actions, { embedder: defaultEmbedder(), log: app.log }));

  app.get('/', async (request) => {
    const { project } = scopeQuery.parse(request.query);
    const projectId = project ?? null;
    const conversation = await deps.service.conversationFor(request.scope.user, projectId);
    // The trail comes from here, not from live events (which only update what is already on
    // screen): a reload must see every pending/decided action exactly as the server has it,
    // including an old denied row sitting beside a newer pending one for the same proposal.
    const [messages, rows, host, grants, project_grants, standing_grants, questionRows, subagents, open, limitRows] = await Promise.all([
      repos.chat.listMessages(conversation.id),
      repos.chatActions.listByConversation(conversation.id),
      // The state, not a rendered sentence: which machine will run the next message, or which of the
      // five reasons none can. The screen (Task 6) turns it into the line the person reads, and it is
      // here — on the same read as the history — so the chat can say so before anything is typed
      // instead of only after a message fails.
      deps.service.hostFor(request.scope.user, projectId),
      activeGrants(repos, request.scope.user.id, conversation.id),
      activeProjectGrants(repos, request.scope.user.id, conversation.id),
      // Standing grants (spec 2026-09-28 TER-386): the conversation's own project, or — for the
      // general chat (`project_id: null`) — every standing grant this user has.
      activeStandingGrants(repos, request.scope.user.id, conversation.project_id),
      repos.tabQuestions.listByConversation(conversation.id),
      // The subagents panel (spec 2026-09-26 §4): every one still open, plus any that ended recently.
      deps.service.subagentsFor(conversation.id),
      deps.service.openAnswerIds(conversation.id),
      // Usage-limit cards (TER-589): their own list, like suggestions, for the apps that parse tab_questions strictly.
      repos.tabLimitNotices.listByConversation(conversation.id),
    ]);
    // Scoped to this request's own user: a card must never resolve a name this user cannot see.
    const actions = await describeActions(repos, rows, request.scope.user.id);
    const { tab_questions, tab_suggestions } = splitTabRows(await describeTabQuestions(repos, questionRows, request.scope.user.id));
    // `compacting`: a screen opened in the middle of "Compactar" (TER-315) shows it as under way.
    return {
      conversation,
      messages,
      actions,
      host,
      grants,
      project_grants,
      standing_grants,
      tab_questions,
      tab_suggestions,
      tab_limits: await describeTabLimits(repos, limitRows, request.scope.user.id),
      subagents,
      compacting: deps.service.isCompacting(conversation.id),
      // The rows a screen opened in the middle of a run shows as being answered (spec 2026-09-29).
      open_answer_ids: openAnswersIn(messages, open),
    };
  });

  /**
   * Chooses the host: the machine, and which of its Claude accounts. Both ids are resolved through
   * owner-scoped reads first — `findByIdsForOwner` answers nothing at all for a machine of someone
   * else's, so a guessed id is a 404 and never a conversation running on a stranger's computer.
   *
   * Answers with the resolved host state, so the screen shows what it now is (including "that machine
   * is offline") without a second request. Whether the CLI session survives is the repository's call
   * (`setHost` drops it only when the pair really moved, so re-picking the machine a conversation was
   * already running on costs nothing) — the warning before a real move is the screen's (spec §3).
   */
  app.post('/host', { config: { action: 'update' } }, async (request) => {
    const body = hostBody.parse(request.body);
    const user = request.scope.user;
    const [machine] = await repos.machines.findByIdsForOwner([body.machine_id], user.id);
    if (!machine) throw notFound('Máquina não encontrada');
    if (machine.type !== 'agent') throw new HttpError(400, 'O chat só roda em uma máquina com o agente do termhub instalado', 'CHAT_HOST_NOT_AGENT');

    const accountId = body.ai_account_id ?? null;
    if (accountId !== null) {
      const account = await repos.aiAccounts.findById(accountId);
      // Owned by the same machine, which this user owns: that is the whole ownership check, and it
      // also rejects an account of another machine of their own, whose config dir does not exist here.
      if (!account || account.machine_id !== machine.id) throw notFound('Conta de IA não encontrada nessa máquina');
      if (account.provider !== 'claude') throw new HttpError(400, 'O chat roda no Claude: escolha uma conta do Claude nessa máquina', 'CHAT_ACCOUNT_NOT_CLAUDE');
    }

    const current = await deps.service.conversationFor(user);
    const { conversation, moved } = await repos.chat.setHost(current.id, { machine_id: machine.id, ai_account_id: accountId });
    // The project chats run on this same host (spec §3): a move strands their sessions exactly as it
    // strands this one's. `moved` is `setHost`'s own verdict — inferring it from `cli_session_id`
    // instead misses a real move whenever the account-wide row had no session to begin with (a user
    // who only uses project chats, or right after "Nova conversa").
    if (moved) await repos.chat.clearProjectSessions(user.id);
    return { conversation, host: await deps.service.hostFor(user) };
  });

  app.post('/messages', { config: { action: 'create' } }, async (request, reply) => {
    // `wait` is read and ignored: a page loaded before this release still sends it.
    const { text, project_id, attachment_ids, reply_to_id, reply_to_card } = messageBody.parse(request.body);
    // Each only when the body carried it, so a plain message calls the service exactly as before.
    const opts = { projectId: project_id ?? null, ...(attachment_ids ? { attachmentIds: attachment_ids } : {}), ...(reply_to_id ? { replyToId: reply_to_id } : {}), ...(reply_to_card ? { replyToCard: reply_to_card } : {}) };
    // A refusal (host problem, archived conversation, an attachment that is not this user's) rejects
    // `start` itself and keeps its status. The answer streams over `/ws/chat`; a failure after this
    // point is logged by label, and a run that could not be attempted says so on the stream.
    const started = await deps.service.start(request.scope.user, text, opts);
    started.done.catch((err) => request.log.warn({ code: failureLabel(err), conversationId: started.conversation_id }, 'chat run failed after start'));
    return reply.code(202).send({ conversation_id: started.conversation_id, user_message_id: started.user_message_id, assistant_message_id: started.assistant_message_id });
  });

  /**
   * "Compactar" (TER-315): runs `/compact` on the scope's CLI session. 202 once it has started; its end
   * travels over `/ws/chat` (`compact`, and the new fill as `context`). A host that cannot run it, an
   * answer being written or a conversation with no session yet is refused with its own 409.
   */
  app.post('/compact', { config: { action: 'update' } }, async (request, reply) => {
    const { project_id } = resetBody.parse(request.body ?? {});
    const started = await deps.service.compact(request.scope.user, project_id ?? null);
    return reply.code(202).send({ conversation_id: started.conversation_id });
  });

  /** "Nova conversa": archives the scope's active conversation and answers the fresh, empty one. */
  app.post('/reset', { config: { action: 'update' } }, async (request) => {
    const { project_id } = resetBody.parse(request.body ?? {});
    return { conversation: await deps.service.reset(request.scope.user, project_id ?? null) };
  });

  /** Per-project chat status for the sidebar's 💬: answering now, and questions waiting on the user. */
  app.get('/projects', async (request) => ({ projects: await deps.service.projectStatuses(request.scope.user) }));

  app.post('/actions/:id/decision', async (request) => {
    const { id } = actionIdParam.parse(request.params);
    const { decision } = decisionBody.parse(request.body);
    const status = decision === 'deny' ? 'denied' : 'approved';
    const user = request.scope.user;

    // "Permitir sempre nesta aba" is only for what the gate will honour — checked before anything is
    // decided, so a refused request changes nothing (404 not found, 400 GRANT_NOT_ALLOWED otherwise).
    // "Liberar teclas e shell nesta aba" (TER-325) likewise.
    if (decision === 'approve_tab') await assertGrantableAction(repos, user.id, id);
    if (decision === 'approve_tab_terminal') await assertTabTerminalGrantableAction(repos, user.id, id);
    // "Permitir sempre neste projeto" and "Liberar tudo neste projeto" likewise, and the project they
    // trust is resolved here, with the user's own id (never a "view as" owner), exactly as the gate will
    // resolve the next board or terminal call.
    const projectCheck =
      decision === 'approve_project' ? await assertProjectGrantableAction(repos, user.id, id)
      : decision === 'approve_project_all' ? await assertProjectAllGrantableAction(repos, user.id, id)
      : undefined;
    // "Liberar sem prazo" (spec 2026-09-28 TER-386) likewise, resolved the same way with the gate's own
    // resolver — kind and project.
    const standingCheck = decision === 'approve_project_always' ? await assertStandingGrantableAction(repos, user.id, id) : undefined;

    // The decision itself, and only it, decides who may answer this row — `decide` filters by the
    // owning conversation's user_id in SQL, so wrong id, another user's row and an already-decided
    // row of this user's all come back as `undefined` here, indistinguishably.
    const action = await repos.chatActions.decide(id, user.id, status);
    if (!action) {
      // Telling "not found" apart from "already decided": `findByIdForUser` is scoped by the same
      // owning-conversation `user_id` join `decide` uses, so this is not a second authorisation path
      // — it never says who owns a row it will not show, only whether one exists for this user.
      const existing = await repos.chatActions.findByIdForUser(id, user.id);
      throw existing ? conflict('Esta ação já foi decidida') : notFound('Ação não encontrada');
    }

    // Every open tab must see the decision, not only the one that clicked it.
    chatBus.publish({ type: 'decision', user_id: user.id, conversation_id: action.conversation_id, action_id: action.id, status });
    // Memory (spec 2026-09-26 concierge memory §4): best effort, fire-and-forget, never on the request's
    // critical path — a slow or failing embed service must not delay the decision's own response.
    void indexActions(user.id, [action]);
    // The approval above already happened and is already published: a grant that fails to be written
    // must not turn it into an error, nor keep the model from being resumed. It degrades to a plain
    // "Autorizar" — the card shows no grant and the user can trust the tab (or project) from the next one.
    let grant: Awaited<ReturnType<typeof grantTab>> | undefined;
    if (decision === 'approve_tab') {
      try {
        grant = await grantTab(repos, user.id, action);
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId: action.id }, 'chat grant failed after approval');
      }
    } else if (decision === 'approve_tab_terminal') {
      try {
        grant = await grantTabTerminal(repos, user.id, action);
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId: action.id }, 'chat grant failed after approval');
      }
    }
    let project_grant: Awaited<ReturnType<typeof grantProject>> | undefined;
    if (projectCheck) {
      try {
        project_grant = await grantProject(repos, user.id, action, projectCheck.projectId, decision === 'approve_project_all' ? 'all' : 'board');
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId: action.id }, 'chat project grant failed after approval');
      }
    }
    let standing_grant: Awaited<ReturnType<typeof grantStanding>> | undefined;
    if (standingCheck) {
      try {
        standing_grant = await grantStanding(repos, user.id, action, standingCheck.kind, standingCheck.projectId);
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId: action.id }, 'chat standing grant failed after approval');
      }
    }

    try {
      // Awaits the start of the injected run, never its end: an answer longer than the edge allows
      // used to cut this request and show an error for a decision that was recorded.
      await deps.service.startAfterDecision(user, action);
      return { action, grant, project_grant, standing_grant };
    } catch (err) {
      // The decision above already happened and was already published — a busy run must not turn a
      // successful decision into a 409. The row stays approved/denied with no injection yet; the run
      // holding the lock will pick it up and inject it through `drainNextDecision` once it finishes.
      if (err instanceof HttpError && err.code === 'CHAT_BUSY') return { action, queued: true, note: QUEUED_NOTE, grant, project_grant, standing_grant };
      throw err;
    }
  });

  /** A grouped confirmation (spec 2026-09-26 §7): the batch decided at once and injected as one sentence. */
  app.post('/actions/decisions', { config: { action: 'create' } }, async (request) => {
    const { decisions } = batchBody.parse(request.body);
    const user = request.scope.user;
    const { decided, skipped } = await decideMany(repos, user.id, decisions);
    void indexActions(user.id, decided);
    try {
      // The start of the run, never its end, as in the single decision above.
      await deps.service.startAfterDecision(user, decided[0]!);
      return { actions: decided, skipped };
    } catch (err) {
      if (err instanceof HttpError && err.code === 'CHAT_BUSY') return { actions: decided, skipped, queued: true, note: QUEUED_NOTE };
      throw err;
    }
  });

  /**
   * "Cancelar" on a subagent's row in the panel (spec 2026-09-26 §4): asks the live process to stop it.
   * `cancelSubagent` throws 404 for a foreign or missing id, 409 `SUBAGENT_NOT_RUNNING` for one already
   * at rest and 409 `SUBAGENT_GONE` for one whose process is no longer around to ask.
   */
  app.post('/subagents/:id/cancel', { config: { action: 'create' } }, async (request, reply) => {
    const { id } = subagentIdParam.parse(request.params);
    const subagent = await deps.service.cancelSubagent(request.scope.user, id);
    return reply.code(202).send({ subagent });
  });

  /** "Abas confiáveis" (Configurações): every grant of this user, active or a page of the history. */
  app.get('/grants', async (request) => listGrants(repos, request.scope.user.id, chatGrantListQuery.parse(request.query)));

  /** "Liberadas por padrão" (TER-627): every default allowance of the chat, on or restricted for this user. */
  app.get('/defaults', async (request) => ({ defaults: await chatDefaultsOf(repos, request.scope.user.id) }));

  /** Turns one default allowance on or off for this user. `create`, like granting and revoking. */
  app.put('/defaults/:kind', { config: { action: 'create' } }, async (request) => {
    const { kind } = defaultKindParam.parse(request.params);
    const { allowed } = defaultAllowedBody.parse(request.body);
    await repos.chatDefaultRestrictions.setAllowed(request.scope.user.id, kind, allowed);
    return { defaults: await chatDefaultsOf(repos, request.scope.user.id) };
  });

  /** "Revogar". Declared as `create`, the permission deciding a card needs: whoever can grant can revoke. */
  app.delete('/grants/:id', { config: { action: 'create' } }, async (request) => {
    const { id } = grantIdParam.parse(request.params);
    return { grant: await revokeGrant(repos, request.scope.user.id, id) };
  });

  /**
   * Answers a tab's question from its card (spec 2026-09-25 §5.3). The click is the confirmation: no
   * gate card, no model turn. `create`, the permission deciding a card needs. The body is validated by
   * the service against the question's own kind.
   */
  app.post('/tab-questions/:id/answer', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    const ctx = controlContextFor(repos, request.scope.user);
    return { tab_question: await answerTabQuestion(ctx, id, request.body, { log: request.log }) };
  });

  /**
   * "Cancelar" on a countdown (spec 2026-09-26 concierge memory §6): nothing is sent, the proposed answer
   * stays as the pre-selection. `create`, like answering; 404 for another user's card, 409 `NOT_SCHEDULED`.
   */
  app.post('/tab-questions/:id/auto-answer/cancel', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return { tab_question: await cancelAutoAnswer(controlContextFor(repos, request.scope.user), id) };
  });

  /** The live excerpt a permission card shows (spec §6.1): read now, never stored nor logged. */
  app.get('/tab-questions/:id/screen', async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return tabQuestionScreen(controlContextFor(repos, request.scope.user), id, { log: request.log });
  });

  /**
   * "Enviar" on a tab's suggestion card (spec 2026-09-25 tab suggestions §6.2): one click, no gate card,
   * no PIN. `create`, like answering a tab's question; the service also requires `terminals:write`.
   */
  app.post('/tab-suggestions/:id/send', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return { tab_suggestion: await sendTabSuggestion(controlContextFor(repos, request.scope.user), id, request.body, { log: request.log }) };
  });

  /**
   * A usage-limit card (TER-589): an account swaps the tab to it, `null` ("Esperar") closes the card.
   * `create`, like answering a tab's question; swapping also needs `terminals:update`.
   */
  app.post('/tab-limits/:id/answer', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    const { account_id } = tabLimitAnswerBody.parse(request.body);
    return { tab_limit: await answerTabLimit(controlContextFor(repos, request.scope.user), request.log, id, account_id) };
  });

  /** "Dispensar": the card closes, the tab is not touched. */
  app.post('/tab-suggestions/:id/dismiss', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return { tab_suggestion: await dismissTabSuggestion(controlContextFor(repos, request.scope.user), id, { log: request.log }) };
  });
}
