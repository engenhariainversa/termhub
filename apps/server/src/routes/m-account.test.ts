import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_DELETION_ACTION_ID, decisionProofMessage } from '@termhub/mobile-api';
import type { Device } from '../db/repositories/devices.js';
import type { User } from '../db/repositories/types.js';
import type { AccountDeletionService } from '../account/deletion.js';
import type { SessionService } from '../mobile/session.js';
import { HttpError, applyErrorHandler } from '../lib/errors.js';
import { mobileAccountRoutes } from './m-account.js';

const PENDING = { deletion_requested_at: '2026-10-01T12:00:00.000Z', deletion_scheduled_at: '2026-10-31T12:00:00.000Z' };
const me = { id: 'u1', email: 'ana@gmail.com', deletion_requested_at: null, deletion_scheduled_at: null } as unknown as User;
const device = { id: 'd1', user_id: 'u1' } as unknown as Device;

/** The routes behind a stand-in for the mobile auth hook: the device and its user are already known. */
async function build() {
  const session = {
    consumeDecisionChallenge: vi.fn(async (_d: Device, challenge: string, actionId: string) => challenge === 'c1' && actionId === ACCOUNT_DELETION_ACTION_ID),
    checkPin: vi.fn(async (_d: Device, message: string, proof: string) =>
      message === decisionProofMessage('c1', ACCOUNT_DELETION_ACTION_ID, 'delete_account') && proof === 'good' ? { ok: true as const } : { ok: false as const, code: 'PIN_INVALID' as const, failures: 1 },
    ),
  };
  const deletion = {
    assertCanDelete: vi.fn(async () => {}),
    request: vi.fn(async (u: User) => ({ ...u, ...PENDING })),
    cancel: vi.fn(async () => true),
  };
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    request.user = me;
    request.mobile = { device, user: me };
  });
  await app.register((a) => mobileAccountRoutes(a, { deletion: deletion as unknown as AccountDeletionService, session: session as unknown as SessionService }), { prefix: '/account' });
  await app.ready();
  return { app, session, deletion };
}

describe('mobile account deletion routes', () => {
  let t: Awaited<ReturnType<typeof build>>;
  let app: FastifyInstance;
  beforeEach(async () => {
    t = await build();
    app = t.app;
  });
  afterEach(async () => {
    await app.close();
  });

  it('a PIN proof over the deletion challenge requests the deletion', async () => {
    const r = await app.inject({ method: 'POST', url: '/account/deletion', payload: { challenge: 'c1', pin_proof: 'good' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ pending: true, requested_at: PENDING.deletion_requested_at, scheduled_at: PENDING.deletion_scheduled_at });
    expect(t.session.consumeDecisionChallenge).toHaveBeenCalledWith(device, 'c1', ACCOUNT_DELETION_ACTION_ID);
    expect(t.deletion.request).toHaveBeenCalledWith(me, 'mobile');
  });

  it('a wrong PIN answers PIN_INVALID with the count and requests nothing', async () => {
    const r = await app.inject({ method: 'POST', url: '/account/deletion', payload: { challenge: 'c1', pin_proof: 'bad' } });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'PIN_INVALID', failures: 1 });
    expect(t.deletion.request).not.toHaveBeenCalled();
  });

  it('a challenge issued for anything else is refused before the PIN is counted', async () => {
    const r = await app.inject({ method: 'POST', url: '/account/deletion', payload: { challenge: 'other', pin_proof: 'good' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('CHALLENGE_INVALID');
    expect(t.session.checkPin).not.toHaveBeenCalled();
  });

  it('the last administrator is refused before the challenge is spent', async () => {
    t.deletion.assertCanDelete.mockRejectedValueOnce(new HttpError(409, 'único administrador', 'LAST_ADMIN'));
    const r = await app.inject({ method: 'POST', url: '/account/deletion', payload: { challenge: 'c1', pin_proof: 'good' } });
    expect(r.statusCode).toBe(409);
    expect(t.session.consumeDecisionChallenge).not.toHaveBeenCalled();
  });

  it('status and cancel', async () => {
    expect((await app.inject({ method: 'GET', url: '/account/deletion' })).json()).toEqual({ pending: false, requested_at: null, scheduled_at: null });
    const r = await app.inject({ method: 'DELETE', url: '/account/deletion' });
    expect(r.json().pending).toBe(false);
    expect(t.deletion.cancel).toHaveBeenCalledWith(me);
  });
});
