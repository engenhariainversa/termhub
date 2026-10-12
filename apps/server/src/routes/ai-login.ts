import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiLoginResumeBody, aiLoginStatusQuery, aiLoginSubmitBody } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError } from '../lib/errors.js';
import { aiLoginStatus, cancelAiLogin, resumeAiLoginTabs, startAiLogin, submitAiLogin } from '../control/ai-login.js';
import { ControlError, controlContextForRequest, type ControlContext } from '../control/context.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const loginParams = idParam.extend({ loginId: z.string().min(1).max(64) });

/** Changing what the account is logged in as is an update of the account, whatever the HTTP method. */
const UPDATE = { config: { action: 'update' } } as const;

/**
 * "Refazer login" of an AI account (TER-1047). The same plugin serves the web (`/api/ai-accounts`) and the
 * app (`/api/m/v1/ai-accounts`), both under the `ai_accounts` resource. The code the person pastes is never
 * logged; the control layer logs ids only.
 */
export async function aiLoginRoutes(app: FastifyInstance, repos: Repositories): Promise<void> {
  const ctxOf = (request: FastifyRequest): ControlContext => ({ ...controlContextForRequest(repos, request), log: request.log });
  const run = async <T>(p: Promise<T>): Promise<T> =>
    p.catch((e: unknown) => {
      if (!(e instanceof ControlError)) throw e;
      throw new HttpError(e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 409, e.localized, e.code);
    });

  app.get('/login-status', async (request) => {
    const { refresh } = aiLoginStatusQuery.parse(request.query);
    return aiLoginStatus(ctxOf(request), !!refresh);
  });

  app.post('/:id/login', UPDATE, async (request) => {
    const { id } = idParam.parse(request.params);
    return run(startAiLogin(ctxOf(request), { account_id: id }));
  });

  app.post('/:id/login/resume', UPDATE, async (request) => {
    const { id } = idParam.parse(request.params);
    const { tab_ids } = aiLoginResumeBody.parse(request.body);
    return run(resumeAiLoginTabs(ctxOf(request), { account_id: id, tab_ids }));
  });

  app.post('/:id/login/:loginId/submit', UPDATE, async (request) => {
    const { id, loginId } = loginParams.parse(request.params);
    const { code } = aiLoginSubmitBody.parse(request.body ?? {});
    return run(submitAiLogin(ctxOf(request), { login_id: loginId, code: code ?? null, account_id: id }));
  });

  app.delete('/:id/login/:loginId', UPDATE, async (request) => {
    const { id, loginId } = loginParams.parse(request.params);
    return run(cancelAiLogin(ctxOf(request), { login_id: loginId, account_id: id }));
  });
}
