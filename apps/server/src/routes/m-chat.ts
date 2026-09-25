import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { chatProjectsResponse, decisionProofMessage, deviceSelf, hostOptionsResponse, mobileDecisionBody, mobileMessageBody, sendAccepted } from '@termhub/mobile-api';
import type { Device } from '../db/repositories/devices.js';
import type { Repositories } from '../db/repositories/index.js';
import { describeActions } from '../db/repositories/chat-actions-view.js';
import { describeTabQuestions, splitTabRows } from '../db/repositories/tab-questions-view.js';
import { controlContextFor } from '../control/context.js';
import { answerTabQuestion, requirePinFor, tabQuestionScreen } from '../chat/tab-question-answer.js';
import { dismissTabSuggestion, sendTabSuggestion } from '../chat/tab-suggestion-send.js';
import { permissionsOf } from '../auth/permissions.js';
import type { HostAgents } from '../chat/host.js';
import { failureLabel, type ChatService } from '../chat/service.js';
import { chatBus } from '../chat/bus.js';
import { activeGrants, assertGrantableAction, grantTab, revokeGrant } from '../chat/grants.js';
import { HttpError, conflict, notFound, unauthorized } from '../lib/errors.js';
import { DeviceLockedError, PinInvalidError, deviceRevoked, type SessionService } from '../mobile/session.js';

const scopeQuery = z.object({ project: z.string().min(1).max(64).optional() });
const resetBody = z.object({ project_id: z.string().min(1).max(64).nullish() });
const actionIdParam = z.object({ id: z.string().min(1).max(64) });
const grantIdParam = z.object({ id: z.string().min(1).max(64) });
const tabQuestionIdParam = z.object({ id: z.string().min(1).max(64) });
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
}

/** The device the mobile auth hook authenticated for this request (every route here is `mobileAuth: 'device'`). */
function deviceOf(request: FastifyRequest): Device {
  const mobile = request.mobile;
  if (!mobile || !('device' in mobile)) throw unauthorized();
  return mobile.device;
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
  app.get('/', async (request) => {
    const { project } = scopeQuery.parse(request.query);
    const projectId = project ?? null;
    const user = request.scope.user;
    const conversation = await deps.chat.conversationFor(user, projectId);
    const [messages, rows, host, grants, questionRows] = await Promise.all([
      repos.chat.listMessages(conversation.id),
      repos.chatActions.listByConversation(conversation.id),
      deps.chat.hostFor(user, projectId),
      activeGrants(repos, user.id, conversation.id),
      repos.tabQuestions.listByConversation(conversation.id),
    ]);
    const actions = await describeActions(repos, rows, user.id);
    const { tab_questions, tab_suggestions } = splitTabRows(await describeTabQuestions(repos, questionRows, user.id));
    return { conversation, messages, actions, host, grants, tab_questions, tab_suggestions };
  });

  /** The user's projects, with their chat's status; a project with no conversation yet is idle. */
  app.get('/projects', async (request) => {
    const user = request.scope.user;
    const [projects, statuses, conversations] = await Promise.all([
      repos.projects.list({ owner: user.id }),
      deps.chat.projectStatuses(user),
      repos.chat.listActiveProjectConversations(user.id),
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
    return chatProjectsResponse.parse({
      projects: visible.map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        busy: statusOf.get(p.id)?.busy ?? false,
        pending_confirmations: statusOf.get(p.id)?.pending_confirmations ?? 0,
        last_message_at: lastOf.get(p.id) ?? null,
      })),
    });
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
    const { text, project_id } = mobileMessageBody.parse(request.body);
    const started = await deps.chat.start(request.scope.user, text, { projectId: project_id ?? null });
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
   * attempt), then consumes the decision challenge bound to this action, then checks the PIN proof
   * over it. Only a good proof reaches `decide`, which stays conditional in SQL: a race with the web
   * ends in the same 409. Once decided, the resumed run goes to the background: the answer is
   * `{ action, queued: true, note }` for both approve and deny, and the run reaches the phone over
   * the socket. A CHAT_BUSY there is normal — the drain injects the decision when the current run ends.
   */
  app.post('/actions/:id/decision', { config: { action: 'create' } }, async (request, reply) => {
    const { id } = actionIdParam.parse(request.params);
    const body = mobileDecisionBody.parse(request.body);
    const user = request.scope.user;

    if (body.decision === 'approve' || body.decision === 'approve_tab') {
      const device = deviceOf(request);
      // An ineligible grant is refused before the challenge is spent or the PIN checked.
      const existing = body.decision === 'approve_tab' ? await assertGrantableAction(repos, user.id, id) : await repos.chatActions.findByIdForUser(id, user.id);
      if (!existing) throw notFound('Ação não encontrada');
      if (existing.status !== 'pending') throw conflict('Esta ação já foi decidida');

      if (!(await deps.session.consumeDecisionChallenge(device, body.challenge, id))) throw new HttpError(400, 'Desafio inválido ou expirado', 'CHALLENGE_INVALID');

      const pin = await deps.session.checkPin(device, decisionProofMessage(body.challenge, id, body.decision), body.pin_proof, { ip: request.ip });
      // Mapped exactly as `POST /session/token` maps it; the action stays pending on every failure.
      if (!pin.ok) {
        if (pin.code === 'DEVICE_LOCKED') {
          reply.header('retry-after', Math.ceil(pin.retryAfterMs / 1000));
          throw new DeviceLockedError(pin.retryAfterMs);
        }
        if (pin.code === 'PIN_INVALID') {
          const err = new PinInvalidError(pin.failures);
          return reply.code(401).send({ error: err.message, code: err.code, failures: err.failures });
        }
        throw deviceRevoked();
      }
    }

    const status = body.decision === 'deny' ? 'denied' : 'approved';
    const action = await repos.chatActions.decide(id, user.id, status);
    if (!action) {
      const existing = await repos.chatActions.findByIdForUser(id, user.id);
      throw existing ? conflict('Esta ação já foi decidida') : notFound('Ação não encontrada');
    }

    chatBus.publish({ type: 'decision', user_id: user.id, conversation_id: action.conversation_id, action_id: action.id, status });
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
    }
    void Promise.resolve()
      .then(() => deps.chat.resumeAfterDecision(user, action))
      .catch((err) => request.log.warn({ code: failureLabel(err), actionId }, 'mobile decision resume failed'));
    return { action, queued: true, note: DECISION_NOTE, grant };
  });

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

  /** The live excerpt a permission card shows (spec §6.1): read now, never stored nor logged. */
  app.get('/tab-questions/:id/screen', async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return tabQuestionScreen(controlContextFor(repos, request.scope.user), id);
  });

  /** The phone sends a tab's suggestion like the web: no PIN (spec 2026-09-25 tab suggestions §2). */
  app.post('/tab-suggestions/:id/send', { config: { action: 'create' } }, async (request) => {
    const { id } = tabQuestionIdParam.parse(request.params);
    return { tab_suggestion: await sendTabSuggestion(controlContextFor(repos, request.scope.user), id, request.body, { log: request.log }) };
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
