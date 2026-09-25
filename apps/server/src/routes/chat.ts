import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { describeActions } from '../db/repositories/chat-actions-view.js';
import { describeTabQuestions } from '../db/repositories/tab-questions-view.js';
import { controlContextFor } from '../control/context.js';
import { answerTabQuestion, tabQuestionScreen } from '../chat/tab-question-answer.js';
import { failureLabel, type ChatService } from '../chat/service.js';
import { chatBus } from '../chat/bus.js';
import { activeGrants, assertGrantableAction, grantTab, revokeGrant } from '../chat/grants.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';

const messageBody = z.object({ text: z.string().trim().min(1).max(8000), project_id: z.string().min(1).max(64).nullish() });
const scopeQuery = z.object({ project: z.string().min(1).max(64).optional() });
const resetBody = z.object({ project_id: z.string().min(1).max(64).nullish() });
const actionIdParam = z.object({ id: z.string().min(1).max(64) });
const decisionBody = z.object({ decision: z.enum(['approve', 'deny', 'approve_tab']) });
const grantIdParam = z.object({ id: z.string().min(1).max(64) });
const tabQuestionIdParam = z.object({ id: z.string().min(1).max(64) });
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
export async function chatRoutes(app: FastifyInstance, repos: Repositories, deps: { service: ChatService }) {
  app.get('/', async (request) => {
    const { project } = scopeQuery.parse(request.query);
    const projectId = project ?? null;
    const conversation = await deps.service.conversationFor(request.scope.user, projectId);
    // The trail comes from here, not from live events (which only update what is already on
    // screen): a reload must see every pending/decided action exactly as the server has it,
    // including an old denied row sitting beside a newer pending one for the same proposal.
    const [messages, rows, host, grants, questionRows] = await Promise.all([
      repos.chat.listMessages(conversation.id),
      repos.chatActions.listByConversation(conversation.id),
      // The state, not a rendered sentence: which machine will run the next message, or which of the
      // five reasons none can. The screen (Task 6) turns it into the line the person reads, and it is
      // here — on the same read as the history — so the chat can say so before anything is typed
      // instead of only after a message fails.
      deps.service.hostFor(request.scope.user, projectId),
      activeGrants(repos, request.scope.user.id, conversation.id),
      repos.tabQuestions.listByConversation(conversation.id),
    ]);
    // Scoped to this request's own user: a card must never resolve a name this user cannot see.
    const actions = await describeActions(repos, rows, request.scope.user.id);
    const tab_questions = await describeTabQuestions(repos, questionRows, request.scope.user.id);
    return { conversation, messages, actions, host, grants, tab_questions };
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
    const { text, project_id } = messageBody.parse(request.body);
    const message = await deps.service.send(request.scope.user, text, { projectId: project_id ?? null });
    return reply.code(201).send({ message });
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
    if (decision === 'approve_tab') await assertGrantableAction(repos, user.id, id);

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
    // The approval above already happened and is already published: a grant that fails to be written
    // must not turn it into an error, nor keep the model from being resumed. It degrades to a plain
    // "Autorizar" — the card shows no grant and the user can trust the tab again from the next one.
    let grant: Awaited<ReturnType<typeof grantTab>> | undefined;
    if (decision === 'approve_tab') {
      try {
        grant = await grantTab(repos, user.id, action);
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId: action.id }, 'chat grant failed after approval');
      }
    }

    try {
      const message = await deps.service.resumeAfterDecision(user, action);
      return { action, message, grant };
    } catch (err) {
      // The decision above already happened and was already published — a busy run must not turn a
      // successful decision into a 409. The row stays approved/denied with no injection yet; the run
      // holding the lock will pick it up and inject it through `drainNextDecision` once it finishes.
      if (err instanceof HttpError && err.code === 'CHAT_BUSY') return { action, queued: true, note: QUEUED_NOTE, grant };
      throw err;
    }
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

  /** The live excerpt a permission card shows (spec §6.1): read now, never stored nor logged. */
  app.get('/tab-questions/:id/screen', async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return tabQuestionScreen(controlContextFor(repos, request.scope.user), id);
  });
}
