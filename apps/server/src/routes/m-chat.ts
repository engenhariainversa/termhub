import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { answerTabLimit, describeTabLimits } from '../chat/tab-limits.js';
import { tabLimitAnswerBody } from '@termhub/mobile-api';
import { z } from 'zod';
import { chatGrantListQuery, chatGrantListResponse, chatProjectsResponse, decisionProofMessage, deviceSelf, hostOptionsResponse, mobileBatchDecisionBody, projectFavoriteBody, mobileDecisionBody, mobileMessageBody, sendAccepted, type PinDecision } from '@termhub/mobile-api';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { Device } from '../db/repositories/devices.js';
import type { Repositories } from '../db/repositories/index.js';
import { ProjectGroupRuleError } from '../db/repositories/project-groups.js';
import { chatMemoryRoutes } from './chat-memory.js';
import { type IndexActionsFn } from './chat.js';
import { describeActions } from '../db/repositories/chat-actions-view.js';
import { describeTabQuestions, splitTabRows } from '../db/repositories/tab-questions-view.js';
import { controlContextFor } from '../control/context.js';
import { answerTabQuestion, requirePinFor, tabQuestionScreen } from '../chat/tab-question-answer.js';
import { cancelAutoAnswer } from '../chat/auto-answer.js';
import { dismissTabSuggestion, sendTabSuggestion } from '../chat/tab-suggestion-send.js';
import { permissionsOf } from '../auth/permissions.js';
import type { HostAgents } from '../chat/host.js';
import { failureLabel, type ChatService } from '../chat/service.js';
import { defaultEmbedder } from '../chat/embeddings.js';
import { chatBus } from '../chat/bus.js';
import { openAnswersIn } from '../chat/open-answers.js';
import { decideMany, pendingBatch } from '../chat/decisions.js';
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
import type { StandingGrantKind } from '../chat/gate.js';
import { indexActions as indexActionsWrite } from '../memory/index-items.js';
import { HttpError, conflict, notFound, unauthorized } from '../lib/errors.js';
import { DeviceLockedError, PinInvalidError, deviceRevoked, type SessionService } from '../mobile/session.js';

const scopeQuery = z.object({ project: z.string().min(1).max(64).optional() });
const resetBody = z.object({ project_id: z.string().min(1).max(64).nullish() });
const actionIdParam = z.object({ id: z.string().min(1).max(64) });
const grantIdParam = z.object({ id: z.string().min(1).max(64) });
const tabQuestionIdParam = z.object({ id: z.string().min(1).max(64) });
const subagentIdParam = z.object({ id: z.string().min(1).max(64) });
const projectIdParam = z.object({ id: z.string().min(1).max(64) });
const hostBody = z.object({ machine_id: z.string().min(1).max(64), ai_account_id: z.string().min(1).max(64).nullish() });

/**
 * The phone never waits for the run a decision resumes: the route answers at once with this note and
 * the run's text, actions and `run_finished` arrive over /ws/m/chat (spec §6, Ruling 18).
 */
const DECISION_NOTE = 'A decisão foi registrada; a resposta chega pelo chat.';

export interface MobileChatDeps {
  chat: ChatService;
  agents: HostAgents;
  session: SessionService;
  /** Indexes decided gate actions (spec 2026-09-26 concierge memory §4), best effort. Defaults to the
   *  real writer, bound to `repos` and this plugin's own logger, so a test needs to override it only
   *  to observe the call. */
  indexActions?: IndexActionsFn;
}

/** The device the mobile auth hook authenticated for this request (every route here is `mobileAuth: 'device'`). */
function deviceOf(request: FastifyRequest): Device {
  const mobile = request.mobile;
  if (!mobile || !('device' in mobile)) throw unauthorized();
  return mobile.device;
}

/** Consumes the decision challenge bound to one action and checks the PIN proof over it. Answers the
 * way `POST /session/token` does on failure (sent here, so the caller just stops) and returns false;
 * true when the proof is good. */
async function proofOk(deps: MobileChatDeps, request: FastifyRequest, reply: FastifyReply, device: Device, actionId: string, decision: PinDecision, proof: { challenge: string; pin_proof: string }): Promise<boolean> {
  if (!(await deps.session.consumeDecisionChallenge(device, proof.challenge, actionId))) throw new HttpError(400, 'Desafio inválido ou expirado', 'CHALLENGE_INVALID');
  const pin = await deps.session.checkPin(device, decisionProofMessage(proof.challenge, actionId, decision), proof.pin_proof, { ip: request.ip });
  if (pin.ok) return true;
  if (pin.code === 'DEVICE_LOCKED') {
    reply.header('retry-after', Math.ceil(pin.retryAfterMs / 1000));
    throw new DeviceLockedError(pin.retryAfterMs);
  }
  if (pin.code === 'PIN_INVALID') {
    const err = new PinInvalidError(pin.failures);
    await reply.code(401).send({ error: err.message, code: err.code, failures: err.failures });
    return false;
  }
  throw deviceRevoked();
}

const toDeviceSelf = (d: Device) => deviceSelf.parse({ id: d.id, name: d.name, platform: d.platform, model: d.model, created_at: d.created_at, last_seen_at: d.last_seen_at });

/**
 * The phone's chat, mounted at `/chat` of the mobile API (spec §6). The same chat as the web's
 * `routes/chat.ts`, over the same `ChatService`, with two differences: a message answers `202` as
 * soon as it is stored (the run goes on in the background and reaches the phone over the socket),
 * and approving a pending action needs a fresh PIN proof over a single-use decision challenge.
 * Never logs chat text: a background failure is logged by its code only.
 */
export async function mobileChatRoutes(app: FastifyInstance, repos: Repositories, deps: MobileChatDeps) {
  // "Memória do chat" (spec 2026-09-26 §4.6): list/forget decisions, read/set the suggestion switch.
  await chatMemoryRoutes(app, repos);
  const indexActions: IndexActionsFn = deps.indexActions ?? ((userId, actions) => indexActionsWrite(repos, userId, actions, { embedder: defaultEmbedder(), log: app.log }));

  app.get('/', async (request) => {
    const { project } = scopeQuery.parse(request.query);
    const projectId = project ?? null;
    const user = request.scope.user;
    const conversation = await deps.chat.conversationFor(user, projectId);
    const [messages, rows, host, grants, project_grants, standing_grants, questionRows, subagents, open, limitRows] = await Promise.all([
      repos.chat.listMessages(conversation.id),
      repos.chatActions.listByConversation(conversation.id),
      deps.chat.hostFor(user, projectId),
      activeGrants(repos, user.id, conversation.id),
      activeProjectGrants(repos, user.id, conversation.id),
      // Standing grants (spec 2026-09-28 TER-386), same as the web's GET /api/chat: the conversation's
      // own project, or every one of this user's for the general chat (`project_id: null`).
      activeStandingGrants(repos, user.id, conversation.project_id),
      repos.tabQuestions.listByConversation(conversation.id),
      // The subagents panel (spec 2026-09-26 §4), same as the web's GET /api/chat.
      deps.chat.subagentsFor(conversation.id),
      deps.chat.openAnswerIds(conversation.id),
      // Usage-limit cards (TER-589): their own list, like suggestions, for the apps that parse tab_questions strictly.
      repos.tabLimitNotices.listByConversation(conversation.id),
    ]);
    const actions = await describeActions(repos, rows, user.id);
    const { tab_questions, tab_suggestions } = splitTabRows(await describeTabQuestions(repos, questionRows, user.id));
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
      tab_limits: await describeTabLimits(repos, limitRows, user.id),
      subagents,
      // The rows a screen opened in the middle of a run shows as being answered (spec 2026-09-29).
      open_answer_ids: openAnswersIn(messages, open),
    };
  });

  /** The user's projects, with their chat's status; a project with no conversation yet is idle. */
  app.get('/projects', async (request) => {
    const user = request.scope.user;
    const [projects, statuses, conversations, groups] = await Promise.all([
      repos.projects.list({ owner: user.id }),
      deps.chat.projectStatuses(user),
      repos.chat.listActiveProjectConversations(user.id),
      // `read`, never `list`: a GET must not create the Favoritos row.
      repos.projectGroups.read(user.id),
    ]);
    const statusOf = new Map(statuses.map((s) => [s.project_id, s]));
    const lastOf = new Map(conversations.map((c) => [c.project_id, c.last_message_at]));
    // Archived projects are hidden, as on the web's sidebar and dashboard (the phone has no "show
    // archived" toggle) — unless their chat is answering or waiting on a question, which must never
    // be hidden. Paused projects stay.
    const visible = projects.filter((p) => {
      if (p.status !== 'archived') return true;
      const s = statusOf.get(p.id);
      return !!s && (s.busy || s.pending_confirmations > 0);
    });
    // The web sidebar's Favoritos (TER-541): places counted over the projects listed here only, so
    // they stay dense when a member is archived or out of scope.
    const listed = new Set(visible.map((p) => p.id));
    const pinned = (groups.find((g) => g.kind === 'favorites')?.project_ids ?? []).filter((id) => listed.has(id));
    const placeOf = new Map(pinned.map((id, i) => [id, i]));
    return chatProjectsResponse.parse({
      projects: visible.map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        busy: statusOf.get(p.id)?.busy ?? false,
        pending_confirmations: statusOf.get(p.id)?.pending_confirmations ?? 0,
        last_message_at: lastOf.get(p.id) ?? null,
        favorite_position: placeOf.get(p.id) ?? null,
      })),
    });
  });

  /** Pins or unpins a project in the signed-in user's Favoritos, the web sidebar's group (TER-541). */
  app.put('/projects/:id/favorite', async (request, reply) => {
    const user = request.scope.user;
    const { id } = projectIdParam.parse(request.params);
    const { favorite } = projectFavoriteBody.parse(request.body);
    const [project] = await repos.projects.findByIdsForOwner([id], user.id);
    if (!project) throw notFound('Projeto não encontrado');
    try {
      await repos.projectGroups.setFavorite(user.id, project.id, favorite);
    } catch (e) {
      if (e instanceof ProjectGroupRuleError) throw new HttpError(400, e.message, e.code);
      throw e;
    }
    return reply.code(204).send();
  });

  /** The machines the chat can run on (agent ones), live state and Claude accounts, in one call. */
  app.get('/host/options', async (request) => {
    const user = request.scope.user;
    const [machines, accounts] = await Promise.all([repos.machines.list(user.id), repos.aiAccounts.list(user.id)]);
    return hostOptionsResponse.parse({
      machines: machines
        .filter((m) => m.type === 'agent')
        .map((m) => ({
          id: m.id,
          name: m.name,
          online: deps.agents.capabilities(m.id) !== null,
          agent_version: deps.agents.info(m.id)?.agent_version ?? null,
          accounts: accounts
            .filter((a) => a.machine_id === m.id && a.provider === 'claude')
            .map((a) => ({ id: a.id, label: a.label, config_dir: a.config_dir })),
        })),
    });
  });

  /** Chooses the host, exactly as the web's `POST /api/chat/host` (owner-scoped reads first). */
  app.post('/host', { config: { action: 'update' } }, async (request) => {
    const body = hostBody.parse(request.body);
    const user = request.scope.user;
    const [machine] = await repos.machines.findByIdsForOwner([body.machine_id], user.id);
    if (!machine) throw notFound('Máquina não encontrada');
    if (machine.type !== 'agent') throw new HttpError(400, 'O chat só roda em uma máquina com o agente do termhub instalado', 'CHAT_HOST_NOT_AGENT');

    const accountId = body.ai_account_id ?? null;
    if (accountId !== null) {
      const account = await repos.aiAccounts.findById(accountId);
      if (!account || account.machine_id !== machine.id) throw notFound('Conta de IA não encontrada nessa máquina');
      if (account.provider !== 'claude') throw new HttpError(400, 'O chat roda no Claude: escolha uma conta do Claude nessa máquina', 'CHAT_ACCOUNT_NOT_CLAUDE');
    }

    const current = await deps.chat.conversationFor(user);
    const { conversation, moved } = await repos.chat.setHost(current.id, { machine_id: machine.id, ai_account_id: accountId });
    if (moved) await repos.chat.clearProjectSessions(user.id);
    return { conversation, host: await deps.chat.hostFor(user) };
  });

  /**
   * Stores the message and answers `202` at once; the answer streams over the socket. Refusals (no
   * host, `CHAT_BUSY`) still reject `start` and answer synchronously. `done` is caught right here, in
   * the same tick `start` resolved: nothing else awaits it, and an unhandled rejection kills the process.
   */
  app.post('/messages', { config: { action: 'create' } }, async (request, reply) => {
    const { text, project_id, attachment_ids, reply_to_id, reply_to_card } = mobileMessageBody.parse(request.body);
    const started = await deps.chat.start(request.scope.user, text, { projectId: project_id ?? null, ...(attachment_ids ? { attachmentIds: attachment_ids } : {}), ...(reply_to_id ? { replyToId: reply_to_id } : {}), ...(reply_to_card ? { replyToCard: reply_to_card } : {}) });
    started.done.catch((err) => request.log.warn({ code: failureLabel(err), conversationId: started.conversation_id }, 'mobile run failed after start'));
    return reply.code(202).send(sendAccepted.parse({ conversation_id: started.conversation_id, user_message_id: started.user_message_id, assistant_message_id: started.assistant_message_id }));
  });

  app.post('/reset', { config: { action: 'update' } }, async (request) => {
    const { project_id } = resetBody.parse(request.body ?? {});
    return { conversation: await deps.chat.reset(request.scope.user, project_id ?? null) };
  });

  /**
   * Deny is the web's decision as is. Approve first makes sure there is still something to approve
   * (404 / 409 before any challenge or PIN work, so a stale card never burns a challenge or a PIN
   * attempt). A `write` card approves with the session alone, like deny; an irreversible card (or
   * any non-`write` class) and a tab, project or standing grant (`approve_project_always`, spec
   * 2026-09-28 TER-386) still need the PIN proof — a proof sent anyway (an older app) is checked and
   * counted as before. Only a good proof reaches `decide`, which stays conditional in SQL: a race with
   * the web ends in the same 409. Once decided, the resumed run goes to the background: the answer is
   * `{ action, queued: true, note }` for both approve and deny, and the run reaches the phone over the
   * socket. A CHAT_BUSY there is normal — the drain injects the decision when the current run ends.
   */
  app.post('/actions/:id/decision', { config: { action: 'create' } }, async (request, reply) => {
    const { id } = actionIdParam.parse(request.params);
    const body = mobileDecisionBody.parse(request.body);
    const user = request.scope.user;

    let projectId: string | undefined;
    let standing: { kind: StandingGrantKind; projectId: string } | undefined;
    if (body.decision !== 'deny') {
      const device = deviceOf(request);
      // An ineligible grant is refused before the challenge is spent or the PIN checked. The project a
      // grant trusts is resolved here, with the user's own id, exactly as the gate will resolve it.
      let existing: ChatAction | undefined;
      if (body.decision === 'approve_tab') existing = await assertGrantableAction(repos, user.id, id);
      else if (body.decision === 'approve_tab_terminal') existing = await assertTabTerminalGrantableAction(repos, user.id, id);
      else if (body.decision === 'approve_project') ({ action: existing, projectId } = await assertProjectGrantableAction(repos, user.id, id));
      else if (body.decision === 'approve_project_all') ({ action: existing, projectId } = await assertProjectAllGrantableAction(repos, user.id, id));
      else if (body.decision === 'approve_project_always') {
        const r = await assertStandingGrantableAction(repos, user.id, id);
        existing = r.action;
        standing = { kind: r.kind, projectId: r.projectId };
      } else existing = await repos.chatActions.findByIdForUser(id, user.id);
      if (!existing) throw notFound('Ação não encontrada');
      if (existing.status !== 'pending') throw conflict('Esta ação já foi decidida');

      // TER-92: a `write` card approves with the session alone (token + hardware-key proof, like deny);
      // an irreversible card and a tab or project grant still need the PIN, each proven over its own
      // decision word. A proof that comes anyway (an older app) is checked and counted as before; the
      // action stays pending on every failure.
      const hasProof = body.challenge !== undefined && body.pin_proof !== undefined;
      const needsPin = body.decision !== 'approve' || existing.class !== 'write';
      if (needsPin && !hasProof) throw new HttpError(401, 'Confirme com o PIN para autorizar esta ação.', 'PIN_REQUIRED');
      if (hasProof && !(await proofOk(deps, request, reply, device, id, body.decision, { challenge: body.challenge!, pin_proof: body.pin_proof! }))) return reply;
    }

    const status = body.decision === 'deny' ? 'denied' : 'approved';
    const action = await repos.chatActions.decide(id, user.id, status);
    if (!action) {
      const existing = await repos.chatActions.findByIdForUser(id, user.id);
      throw existing ? conflict('Esta ação já foi decidida') : notFound('Ação não encontrada');
    }

    chatBus.publish({ type: 'decision', user_id: user.id, conversation_id: action.conversation_id, action_id: action.id, status });
    void indexActions(user.id, [action]);
    const actionId = action.id;
    // Same rule as the web route: the approval is already decided and published, so a grant that fails
    // to be written degrades to a plain approval — logged by code only — and the resume still runs.
    let grant: Awaited<ReturnType<typeof grantTab>> | undefined;
    if (body.decision === 'approve_tab') {
      try {
        grant = await grantTab(repos, user.id, action);
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId }, 'chat grant failed after approval');
      }
    } else if (body.decision === 'approve_tab_terminal') {
      try {
        grant = await grantTabTerminal(repos, user.id, action);
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId }, 'chat grant failed after approval');
      }
    }
    let project_grant: Awaited<ReturnType<typeof grantProject>> | undefined;
    if (projectId) {
      try {
        project_grant = await grantProject(repos, user.id, action, projectId, body.decision === 'approve_project_all' ? 'all' : 'board');
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId }, 'chat project grant failed after approval');
      }
    }
    let standing_grant: Awaited<ReturnType<typeof grantStanding>> | undefined;
    if (standing) {
      try {
        standing_grant = await grantStanding(repos, user.id, action, standing.kind, standing.projectId);
      } catch (err) {
        request.log.warn({ code: failureLabel(err), actionId }, 'chat standing grant failed after approval');
      }
    }
    void Promise.resolve()
      .then(() => deps.chat.resumeAfterDecision(user, action))
      .catch((err) => request.log.warn({ code: failureLabel(err), actionId }, 'mobile decision resume failed'));
    return { action, queued: true, note: DECISION_NOTE, grant, project_grant, standing_grant };
  });

  /**
   * A grouped confirmation from the phone (spec 2026-09-26 §7). Every approval follows the single
   * route's rule — pending first, then (unless it is a `write` card sent without one) its challenge and
   * PIN proof — and all of them before anything is decided, so a wrong or missing PIN leaves the whole
   * batch pending. Then one `decideMany` and one resumed run,
   * in the background like the single route.
   */
  app.post('/actions/decisions', { config: { action: 'create' } }, async (request, reply) => {
    const { decisions } = mobileBatchDecisionBody.parse(request.body);
    const user = request.scope.user;
    const { pending, skipped: firstSkipped } = await pendingBatch(repos, user.id, decisions.map((d) => d.id));
    const stillPending = new Set(pending.map((p) => p.id));
    const approvals = decisions.filter((d): d is Extract<typeof d, { decision: 'approve' }> => d.decision === 'approve' && stillPending.has(d.id));
    // TER-92, as in the single route: a `write` card approves with the session alone, any other class
    // needs its proof. A missing proof refuses the whole batch before any challenge is spent; a proof
    // that comes anyway (an older app) is checked and counted as before.
    const classOf = new Map(pending.map((p) => [p.id, p.class]));
    if (approvals.some((a) => classOf.get(a.id) !== 'write' && (a.challenge === undefined || a.pin_proof === undefined))) {
      throw new HttpError(401, 'Confirme com o PIN para autorizar esta ação.', 'PIN_REQUIRED');
    }
    const proven = approvals.filter((a) => a.challenge !== undefined && a.pin_proof !== undefined);
    if (proven.length > 0) {
      const device = deviceOf(request);
      for (const a of proven) if (!(await proofOk(deps, request, reply, device, a.id, 'approve', { challenge: a.challenge!, pin_proof: a.pin_proof! }))) return reply;
    }
    // Only what the first read saw pending reaches `decideMany`: every approval there had its proof
    // checked above, so "no approval without a proof" holds here, not by two reads agreeing.
    const toDecide = decisions.filter((d) => stillPending.has(d.id)).map((d) => ({ id: d.id, decision: d.decision }));
    if (toDecide.length === 0) throw conflict('Estas ações já foram decididas');
    const result = await decideMany(repos, user.id, toDecide);
    const decided = result.decided;
    void indexActions(user.id, decided);
    const skippedIds = new Set(firstSkipped.map((s) => s.id));
    const skipped = [...firstSkipped, ...result.skipped.filter((s) => !skippedIds.has(s.id))];
    const first = decided[0]!;
    void Promise.resolve()
      .then(() => deps.chat.resumeAfterDecision(user, first))
      .catch((err) => request.log.warn({ code: failureLabel(err), actionId: first.id }, 'mobile batch resume failed'));
    return { actions: decided, skipped, queued: true, note: DECISION_NOTE };
  });

  /**
   * "Cancelar" on a subagent's row in the panel, exactly as the web's route: `cancelSubagent` throws
   * 404 for a foreign or missing id, 409 `SUBAGENT_NOT_RUNNING` for one already at rest and 409
   * `SUBAGENT_GONE` for one whose process is no longer around to ask. No PIN: like deciding a card,
   * this only ever takes something away, never authorizes a new write.
   */
  app.post('/subagents/:id/cancel', { config: { action: 'create' } }, async (request, reply) => {
    const { id } = subagentIdParam.parse(request.params);
    const subagent = await deps.chat.cancelSubagent(request.scope.user, id);
    return reply.code(202).send({ subagent });
  });

  /** The phone's "Abas confiáveis": the same list as the web, validated against the shared contract. */
  app.get('/grants', async (request) => chatGrantListResponse.parse(await listGrants(repos, request.scope.user.id, chatGrantListQuery.parse(request.query))));

  /** "Revogar" from the phone. No PIN: it only takes power away. `create`, like deciding a card. */
  app.delete('/grants/:id', { config: { action: 'create' } }, async (request) => {
    const { id } = grantIdParam.parse(request.params);
    return { grant: await revokeGrant(repos, request.scope.user.id, id) };
  });

  /**
   * The phone answers a tab's question like the web (spec 2026-09-25 §5.3). No PIN today:
   * `requirePinFor` says no for every answer; the day it says yes, the proof flow goes here.
   */
  app.post('/tab-questions/:id/answer', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    const ctx = controlContextFor(repos, request.scope.user);
    const beforeSend = (row: { kind: 'choice' | 'permission' }, answer: Parameters<typeof requirePinFor>[1]) => {
      if (requirePinFor(row.kind, answer)) throw new HttpError(403, 'Esta resposta precisa do PIN', 'PIN_REQUIRED');
    };
    return { tab_question: await answerTabQuestion(ctx, id, request.body, { log: request.log, beforeSend }) };
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

  /** The phone sends a tab's suggestion like the web: no PIN (spec 2026-09-25 tab suggestions §2). */
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

  /** "Dispensar" from the phone: the card closes, the tab is not touched. */
  app.post('/tab-suggestions/:id/dismiss', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return { tab_suggestion: await dismissTabSuggestion(controlContextFor(repos, request.scope.user), id, { log: request.log }) };
  });
}

/** `GET /me`, mounted at the mobile API's root: who is signed in, what they may do, this device. */
export async function mobileMeRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/me', { config: { action: 'read' } }, async (request) => {
    const device = deviceOf(request);
    const user = request.scope.user;
    const [permissions, unread] = await Promise.all([permissionsOf(repos, user), repos.userNotifications.countUnread(user.id)]);
    return {
      user: { id: user.id, email: user.email, name: user.name, nickname: user.nickname },
      permissions,
      device: toDeviceSelf(device),
      unread_notifications: unread,
    };
  });
}
