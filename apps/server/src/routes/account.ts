import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../auth/tokens.js';
import { VIEW_AS_COOKIE } from '../auth/scope.js';
import { AccountDeletionService, deletionStatus } from '../account/deletion.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { config } from '../config.js';
import { msg, requestLocale, tk } from '../i18n/index.js';
import type { Repositories } from '../db/repositories/index.js';
import { audit } from '../auth/audit.js';

/** Re-authentication for the request: the account's password, or a code e-mailed to it. */
const requestBody = z.union([
  z.object({ password: z.string().min(1).max(1024) }),
  z.object({ code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos') }),
]);

const linkBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  /** honeypot: real people never fill it (a filled one fails validation, like the waitlist form's) */
  website: z.string().max(0).optional(),
});
const confirmBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) });

/**
 * Per-IP budget for the two public routes, in memory like the waitlist form's: a bot cannot hammer
 * them, and the per-e-mail limit lives in the service (counted in the database).
 */
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PUBLIC_PER_IP = 10;
const hits = new Map<string, number[]>();
function allow(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PUBLIC_PER_IP) return false;
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10_000) hits.clear();
  return true;
}
const tooMany = () => new HttpError(429, 'Muitos pedidos deste endereço. Tente de novo mais tarde.', 'RATE_LIMITED');

function clearSession(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
  reply.clearCookie(VIEW_AS_COOKIE, { path: '/' });
}

export interface AccountRouteDeps {
  auth: AuthService;
  deletion: AccountDeletionService;
  /** Where the security trail goes (TER-577); without it nothing is recorded (route tests). */
  repos?: Pick<Repositories, 'securityEvents'>;
}

/**
 * The person's own account (TER-720), mounted at /api/account. Any signed-in person may delete
 * their own account: no role grant is needed. While a deletion is pending these are the only
 * routes the account reaches (`allowPendingDeletion`), besides /auth/me and /auth/logout.
 * The `/deletion/link` and `/deletion/confirm` routes are the public page's (TER-728,
 * termhub.dev/excluir-conta), forwarded by the landing host's proxy.
 */
export async function accountRoutes(app: FastifyInstance, deps: AccountRouteDeps) {
  const pending = { allowPendingDeletion: true };

  app.get('/deletion', { config: pending }, async (request) => {
    if (!request.user) throw unauthorized();
    return deletionStatus(request.user);
  });

  /** Sends the code that confirms the request (for accounts without a password, or by choice). */
  app.post('/deletion/code', async (request, reply) => {
    if (!request.user) throw unauthorized();
    const result = await deps.auth.sendLoginCode(request.user.email, request.ip, requestLocale(request));
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
        throw new HttpError(429, 'Muitos envios. Aguarde alguns minutos e tente de novo.', 'RATE_LIMITED');
      }
      throw new HttpError(502, 'Não foi possível enviar o e-mail. Tente novamente.', 'SEND_FAILED');
    }
    return { ok: true, ttl_minutes: Math.round(config.auth.loginCodeTtlMs / 60000) };
  });

  app.post('/deletion', async (request, reply) => {
    const user = request.user;
    if (!user) throw unauthorized();
    const body = requestBody.parse(request.body);
    // Before the code is spent: a refusal must not cost the person their code.
    await deps.deletion.assertCanDelete(user);
    const check = 'password' in body
      ? await deps.auth.loginWithPassword(user.email, body.password, request.ip)
      : await deps.auth.verifyLoginCode(user.email, body.code, request.ip);
    if (!check.ok) {
      if (check.reason === 'locked') {
        reply.header('retry-after', Math.ceil(check.retryAfterMs / 1000));
        throw new HttpError(429, msg('Muitas tentativas. Tente novamente em {{seconds}}s.', { seconds: Math.ceil(check.retryAfterMs / 1000) }), 'LOCKED');
      }
      throw new HttpError(401, 'password' in body ? tk('Senha incorreta') : tk('Código inválido ou expirado'), 'REAUTH_FAILED');
    }
    if (check.user.id !== user.id) throw unauthorized();
    const updated = await deps.deletion.request(user, 'web');
    if (deps.repos) await audit(deps.repos, request, 'user.deletion_requested', { target: { type: 'user', id: user.id, label: user.email }, meta: { via: 'web' } });
    // The request ended every session, this one included.
    clearSession(reply);
    return deletionStatus(updated);
  });

  app.delete('/deletion', { config: pending }, async (request) => {
    const user = request.user;
    if (!user) throw unauthorized();
    await deps.deletion.cancel(user);
    if (deps.repos) await audit(deps.repos, request, 'user.deletion_canceled', { target: { type: 'user', id: user.id, label: user.email } });
    return deletionStatus({ deletion_requested_at: null, deletion_scheduled_at: null });
  });

  // ---------- public page (TER-728) ----------

  /** Always the same answer, for any address: the page never tells who has an account. */
  app.post('/deletion/link', { config: { public: true } }, async (request, reply) => {
    if (!allow(request.ip)) throw tooMany();
    const body = linkBody.parse(request.body);
    await deps.deletion.sendLink(body.email);
    return reply.code(202).send({ ok: true });
  });

  app.post('/deletion/confirm', { config: { public: true } }, async (request) => {
    if (!allow(request.ip)) throw tooMany();
    const { token } = confirmBody.parse(request.body);
    const user = await deps.deletion.confirmLink(token);
    if (!user) throw new HttpError(400, 'Este link é inválido, já foi usado ou expirou. Peça outro na página.', 'LINK_INVALID');
    if (deps.repos) await audit(deps.repos, request, 'user.deletion_requested', { actor: user, target: { type: 'user', id: user.id, label: user.email }, meta: { via: 'link' } });
    return deletionStatus(user);
  });
}
