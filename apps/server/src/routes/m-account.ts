import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ACCOUNT_DELETION_ACTION_ID, accountDeletionBody, decisionProofMessage } from '@termhub/mobile-api';
import type { AccountDeletionService } from '../account/deletion.js';
import { deletionStatus } from '../account/deletion.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { DeviceLockedError, PinInvalidError, deviceRevoked, type SessionService } from '../mobile/session.js';
import { requestLocale, t } from '../i18n/index.js';

export interface MobileAccountDeps {
  deletion: AccountDeletionService;
  session: SessionService;
}

/**
 * Ajustes → "Excluir minha conta" on the phone (TER-720), mounted at `/account` of the mobile API.
 * The request needs a fresh PIN proof over a single-use decision challenge for the fixed action
 * `ACCOUNT_DELETION_ACTION_ID`, signed with the word `delete_account`. Status and cancel stay
 * reachable while the deletion is pending; nothing else does.
 */
export async function mobileAccountRoutes(app: FastifyInstance, deps: MobileAccountDeps) {
  const pending = { allowPendingDeletion: true };

  /** The device and user the mobile auth hook authenticated (every route here is `mobileAuth: 'device'`). */
  const userOf = (request: FastifyRequest) => {
    const mobile = request.mobile;
    if (!mobile || !('device' in mobile)) throw unauthorized();
    return mobile;
  };

  app.get('/deletion', { config: pending }, async (request) => deletionStatus(userOf(request).user));

  app.post('/deletion', async (request, reply) => {
    const { device, user } = userOf(request);
    const body = accountDeletionBody.parse(request.body);
    // Before the challenge is spent: a refusal must not cost a PIN attempt.
    await deps.deletion.assertCanDelete(user);
    if (!(await deps.session.consumeDecisionChallenge(device, body.challenge, ACCOUNT_DELETION_ACTION_ID))) {
      throw new HttpError(400, 'Desafio inválido ou expirado', 'CHALLENGE_INVALID');
    }
    const pin = await deps.session.checkPin(device, decisionProofMessage(body.challenge, ACCOUNT_DELETION_ACTION_ID, 'delete_account'), body.pin_proof, { ip: request.ip });
    if (!pin.ok) {
      if (pin.code === 'DEVICE_LOCKED') {
        reply.header('retry-after', Math.ceil(pin.retryAfterMs / 1000));
        throw new DeviceLockedError(pin.retryAfterMs);
      }
      if (pin.code === 'PIN_INVALID') {
        const err = new PinInvalidError(pin.failures);
        return reply.code(401).send({ error: t(requestLocale(request), err.localized), code: err.code, failures: err.failures });
      }
      throw deviceRevoked();
    }
    return deletionStatus(await deps.deletion.request(user, 'mobile'));
  });

  app.delete('/deletion', { config: pending }, async (request) => {
    await deps.deletion.cancel(userOf(request).user);
    return deletionStatus({ deletion_requested_at: null, deletion_scheduled_at: null });
  });
}
