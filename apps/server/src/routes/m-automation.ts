import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { automationNeedsConfirm, automationSetupActionId, automationSetupBody, cardAutoBody, pauseBody, resumeBody } from '@termhub/mobile-api';
import { automationPauseState, pauseAutomation, resumeAutomation } from '../automation/pause.js';
import { scoped } from '../auth/scope.js';
import { controlContextForRequest } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import { msg } from '../i18n/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import type { SessionService } from '../mobile/session.js';
import { automationSchema } from '../setup/schema.js';
import { deviceOf, proofOk } from './m-chat.js';
import { taskRules } from './tasks.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/**
 * "Trabalho automático" of the project Setup on the phone, mounted at `/projects` of the mobile API:
 * the `automation` block alone, like the AI block has its own endpoint, so the phone and the web form
 * never overwrite each other's edit. Turning it on, or raising the level to deploy or release, needs a
 * fresh PIN proof over a decision challenge for `automationSetupActionId(project)` signed with
 * `automation_setup`; without one the answer is 401 PIN_REQUIRED. Lowering the level or turning off never asks.
 */
export async function mobileAutomationSetupRoutes(app: FastifyInstance, repos: Repositories, deps: { session: SessionService }) {
  app.get('/:id/setup/automation', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    return { automation: (await repos.projectSetup.get(id)).data.automation };
  });

  app.put('/:id/setup/automation', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const body = automationSetupBody.parse(request.body);
    const next = automationSchema.parse(body.automation);
    const current = await repos.projectSetup.get(id);
    if (automationNeedsConfirm(current.data.automation, next)) {
      if (body.challenge === undefined || body.pin_proof === undefined) throw new HttpError(401, msg('Confirme com o PIN para ligar ou ampliar o trabalho automático.'), 'PIN_REQUIRED');
      const ok = await proofOk(deps, request, reply, deviceOf(request), automationSetupActionId(id), 'automation_setup', { challenge: body.challenge, pin_proof: body.pin_proof });
      if (!ok) return reply;
    }
    const saved = await repos.projectSetup.save(id, { ...current.data, automation: next });
    return { automation: saved.data.automation };
  });
}

/** `PUT /tasks/:id/auto` of the mobile API: the long-press on a card of Progresso. No PIN: tagging
 * only queues a card, and nothing runs until the project's automation is on (which asks for the PIN). */
export async function mobileCardAutoRoutes(app: FastifyInstance, repos: Repositories) {
  app.put('/:id/auto', async (request) => {
    const { id } = idParam.parse(request.params);
    const { auto } = cardAutoBody.parse(request.body);
    await scoped(repos, request).task(id);
    await taskRules(() => repos.tasks.setAuto(id, auto));
    const task = await repos.tasks.findById(id);
    if (!task) throw notFound('Task não encontrada');
    return { id: task.id, auto: task.auto };
  });
}

/**
 * The pause switch on the phone, mounted at `/automation` of the mobile API (resource `projects`): the
 * same state and the same two actions as the web's. No PIN: pausing only stops work, and resuming is
 * confirmed in the app, not signed.
 */
export async function mobileAutomationPauseRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/state', async (request) => automationPauseState(controlContextForRequest(repos, request)));
  app.post('/pause', { config: { action: 'update' } }, async (request) => {
    const body = pauseBody.parse(request.body);
    return pauseAutomation(controlContextForRequest(repos, request), body);
  });
  app.post('/resume', { config: { action: 'update' } }, async (request, reply) => {
    await resumeAutomation(controlContextForRequest(repos, request), resumeBody.parse(request.body));
    return reply.code(204).send();
  });
}
