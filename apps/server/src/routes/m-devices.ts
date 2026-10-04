import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deviceActivateBody, deviceRequestBody, pushTokenBody } from '@termhub/mobile-api';
import type { Device } from '../db/repositories/devices.js';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { clientLocation } from '../mobile/auth.js';
import { REQUEST_SECRET_RE } from '../mobile/codes.js';
import type { EnrolmentService } from '../mobile/enrolment.js';
import type { RevokeInput } from '../mobile/revocation.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

export interface MobileDeviceDeps {
  enrolment: EnrolmentService;
  revoke: (deviceId: string, input: RevokeInput) => Promise<Device | undefined>;
}

const toDeviceSelf = (d: Device) => ({
  id: d.id,
  name: d.name,
  platform: d.platform,
  model: d.model,
  created_at: d.created_at,
  last_seen_at: d.last_seen_at,
});

/** The Authorization header's bearer token, or '' when there is none. */
function bearerOf(request: { headers: { authorization?: string } }): string {
  const auth = request.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

/**
 * Enrolment and self-management routes for a phone, mounted at `/devices` (spec §4, §7). Handlers
 * are thin: parse with the package schemas, call `EnrolmentService` or the injected `revoke`, shape
 * the reply. Never logs a secret, a token or an e-mail.
 */
export async function mobileDeviceRoutes(app: FastifyInstance, _repos: Repositories, deps: MobileDeviceDeps) {
  app.post('/requests', { config: { mobileAuth: 'none' } }, async (request, reply) => {
    const body = deviceRequestBody.parse(request.body ?? {});
    try {
      const result = await deps.enrolment.request(body, clientLocation(request));
      return reply.code(202).send(result);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'RATE_LIMITED') reply.header('retry-after', 600);
      throw err;
    }
  });

  app.get('/requests/:id', { config: { mobileAuth: 'none' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const auth = request.headers.authorization;
    // No bearer at all: the caller sent nothing worth answering to.
    if (!auth?.startsWith('Bearer ')) throw unauthorized();
    const secret = bearerOf(request);
    // A bearer that isn't shaped like a request secret is treated exactly like an unknown/expired
    // one, without ever reaching the service (no DB hit): same shape either way.
    if (!REQUEST_SECRET_RE.test(secret)) return { status: 'closed' as const };
    return deps.enrolment.poll(id, secret);
  });

  app.post('/activate', { config: { mobileAuth: 'proof' } }, async (request, reply) => {
    const body = deviceActivateBody.parse(request.body ?? {});
    const mobile = request.mobile;
    if (!mobile || !('proofJwk' in mobile)) throw unauthorized();
    const result = await deps.enrolment.activate(body, { jwk: mobile.proofJwk, thumbprint: mobile.jwkThumbprint }, clientLocation(request));
    // Only these four fields ever leave the server; the device row (and its pin_secret_enc) stays behind.
    return reply.code(201).send({ device_id: result.device.id, pin_secret: result.pin_secret, access_token: result.access_token, expires_in: result.expires_in });
  });

  app.get('/self', { config: { action: 'read' } }, async (request) => {
    const mobile = request.mobile;
    if (!mobile || !('device' in mobile)) throw unauthorized();
    return toDeviceSelf(mobile.device);
  });

  // Reachable while a deletion is pending (TER-720): the blocking screen's "Sair e remover este aparelho".
  app.post('/self/revoke', { config: { action: 'delete', allowPendingDeletion: true } }, async (request) => {
    const mobile = request.mobile;
    if (!mobile || !('device' in mobile)) throw unauthorized();
    await deps.revoke(mobile.device.id, { reason: 'user', actor: 'user', ip: clientLocation(request).ip });
    return { ok: true };
  });
}

/** `PUT /push-token`, mounted at the mobile API's root (spec §10). */
export async function mobilePushTokenRoutes(app: FastifyInstance, repos: Repositories) {
  app.put('/push-token', { config: { action: 'update' } }, async (request) => {
    const { token } = pushTokenBody.parse(request.body ?? {});
    const mobile = request.mobile;
    if (!mobile || !('device' in mobile)) throw unauthorized();
    const { device, user } = mobile;
    // A push token is unique to one device; if the app reinstalled elsewhere handed it to another
    // device first, take it back before assigning it here.
    const other = await repos.devices.findByPushToken(token);
    if (other && other.id !== device.id) await repos.devices.setPushToken(other.id, null);
    await repos.devices.setPushToken(device.id, token);
    await repos.deviceEvents.record({ user_id: user.id, device_id: device.id, kind: 'push_token_set', actor: 'user', ...clientLocation(request) });
    return { ok: true };
  });
}
