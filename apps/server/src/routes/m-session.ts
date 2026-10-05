import type { FastifyInstance } from 'fastify';
import { canonicalHtu, challengeBody, challengeResponse, tokenBody, tokenResponse } from '@termhub/mobile-api';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { verifyProof, type JtiCache } from '../mobile/dpop.js';
import { DeviceLockedError, PinInvalidError, deviceNotFound, deviceRevoked, type SessionService } from '../mobile/session.js';
import { requestLocale, t } from '../i18n/index.js';

export interface MobileSessionDeps {
  session: SessionService;
  /** the same replay cache the mobile auth hook uses */
  jtis: JtiCache;
  /** the public base the app signs `htu` against */
  publicUrl: string;
}

const proofInvalid = (code: string) => new HttpError(401, 'Prova inválida', code);

/**
 * Challenge and token renewal, mounted at `/session` (spec §5). Both are `mobileAuth: 'none'`: there
 * is no valid access token yet, so `/token` verifies the device's DPoP signature itself, against the
 * STORED key, BEFORE the service ever counts a PIN proof — someone without the device key can never
 * burn the owner's attempts. Never logs a proof, a challenge or a token.
 */
export async function mobileSessionRoutes(app: FastifyInstance, repos: Repositories, deps: MobileSessionDeps) {
  app.post('/challenge', { config: { mobileAuth: 'none' } }, async (request) => {
    const body = challengeBody.parse(request.body ?? {});
    if (body.purpose === 'decision' && !body.action_id) throw badRequest('Desafio de decisão sem action_id');
    const actionId = body.purpose === 'decision' ? (body.action_id ?? null) : null;
    return challengeResponse.parse(await deps.session.challenge(body.device_id, body.purpose, actionId));
  });

  app.post('/token', { config: { mobileAuth: 'none' } }, async (request, reply) => {
    const body = tokenBody.parse(request.body ?? {});
    const device = await repos.devices.findActiveById(body.device_id);
    if (!device) {
      const any = await repos.devices.findById(body.device_id);
      if (any?.status === 'revoked') throw deviceRevoked();
      throw deviceNotFound();
    }

    // 1. The device's signature over this challenge, against its stored key.
    const dpop = request.headers.dpop;
    const proof = (Array.isArray(dpop) ? dpop[0] : dpop) ?? '';
    let publicKeyJwk: JsonWebKey;
    try {
      publicKeyJwk = JSON.parse(device.public_key) as JsonWebKey;
    } catch {
      throw proofInvalid('PROOF_INVALID');
    }
    const r = await verifyProof({ proof, htm: 'POST', htu: canonicalHtu(deps.publicUrl, request.url), publicKeyJwk, extra: { chal: body.challenge } });
    if (!r.ok) throw proofInvalid(r.code);
    // Claimed only after the signature verified, so a forged proof cannot burn a real jti.
    if (!deps.jtis.claim(device.id, r.jti)) throw new HttpError(401, 'Prova repetida', 'PROOF_REPLAYED');

    // 2. Only now the PIN proof, which the service counts.
    try {
      const result = await deps.session.refresh({ device, challenge: body.challenge, pin_proof: body.pin_proof }, { ip: request.ip });
      return tokenResponse.parse(result);
    } catch (err) {
      if (err instanceof DeviceLockedError) reply.header('retry-after', Math.ceil(err.retryAfterMs / 1000));
      if (err instanceof PinInvalidError) return reply.code(401).send({ error: t(requestLocale(request), err.localized), code: err.code, failures: err.failures });
      throw err;
    }
  });
}
