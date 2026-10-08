import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { toPublicUser, type User } from '../db/repositories/types.js';
import { isAdmin, permissionsOf } from './permissions.js';
import { featuresFor } from '../features/flags.js';
import { VIEW_AS_ALL, VIEW_AS_COOKIE, type Scope } from './scope.js';
import { HttpError, badRequest, forbidden, unauthorized, sendError } from '../lib/errors.js';
import type { AuthContext } from './middleware.js';
import { buildAuthorizationUrl, exchangeCode, isGoogleEnabled } from './google.js';
import { normalizeNickname } from '../public/nickname.js';
import { CSRF_COOKIE, OAUTH_COOKIE, SESSION_COOKIE } from './tokens.js';
import { msg, requestLocale, tk } from '../i18n/index.js';
import { audit } from './audit.js';
import type { LoginResult } from './service.js';

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

const sendCodeSchema = z.object({ email: z.string().email().max(254) });
const verifyCodeSchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos'),
});

const callbackSchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(256).optional(),
});

function setSessionCookies(reply: FastifyReply, token: string, csrf: string, expiresAt: Date) {
  const base = { path: '/', sameSite: 'lax' as const, secure: config.auth.cookieSecure, expires: expiresAt };
  reply.setCookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
  // CSRF precisa ser legível pelo JS (double submit).
  reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
}

function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
  reply.clearCookie(VIEW_AS_COOKIE, { path: '/' });
}

/** What the client shows in the "view as" switch: null (self), "all", or the impersonated user. */
function viewAsOf(scope: Scope | undefined) {
  if (!scope || scope.viewAs.kind === 'self') return null;
  if (scope.viewAs.kind === 'all') return 'all' as const;
  const u = scope.viewAs.user;
  return { id: u.id, name: u.name, email: u.email, avatar_url: u.avatar_url };
}

const viewAsSchema = z.object({ user_id: z.string().min(1).max(64).nullable() });
const nicknameBodySchema = z.object({ nickname: z.string() });
/** An IANA zone name the runtime knows (`America/Sao_Paulo`); the daily summary's clock. */
const timeZoneBodySchema = z.object({
  time_zone: z.string().min(1).max(64).refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'invalid time zone'),
});

/** null = automatic (the browser's language; pt-BR for e-mails and push). */
const localeBodySchema = z.object({ locale: z.enum(['pt-BR', 'en']).nullable() });

/**
 * Whether a failed sign-in goes to the security trail: every wrong password or code does, and the one
 * that set a lock; the refusals while locked do not (one row per locked-out request would let anyone
 * fill the table).
 */
function trailsFailure(result: Exclude<LoginResult, { ok: true }>): boolean {
  return result.reason === 'invalid' || !!result.justLocked;
}

export async function authRoutes(app: FastifyInstance, ctx: AuthContext, opts: { onNicknameClaimed?: (user: User) => void } = {}) {
  /** Public user + role summary + flat permission list: what the client needs to gate its UI. */
  const withRole = async (u: User) => {
    const role = u.role_id ? await ctx.repos.roles.findById(u.role_id) : undefined;
    return {
      ...toPublicUser(u),
      role_info: role ? { id: role.id, name: role.name, label: role.label, is_admin: role.is_admin } : null,
      permissions: await permissionsOf(ctx.repos, u),
      // Feature flags resolved for this person (TER-1040): the web hides what is still off.
      features: await featuresFor({ repos: ctx.repos, userId: u.id }),
    };
  };

  const { service } = ctx;

  /** Closes the admin's open "view as" period; best effort, since the cookie is cleared either way. */
  async function endViewAsAudit(adminId: string, log: FastifyBaseLogger) {
    await ctx.repos.viewAsAudit.end(adminId).catch((err: unknown) => log.warn({ err, adminId }, 'view-as: could not close the audit period'));
  }

  app.get('/config', { config: { public: true } }, async () => ({
    modes: [...config.auth.modes],
    google: isGoogleEnabled(),
    password: true,
    email_code: true,
    // Where this instance's public cities live (share links, the nickname preview). Public by nature:
    // it is the address handed to strangers. Served here, beside the rest of the instance's config,
    // because every sign-in path reads this once at boot and none of them returns it otherwise.
    public_city_url: config.publicCityUrl,
  }));

  app.get('/me', { config: { public: true } }, async (request) => {
    if (!request.user) throw unauthorized();
    return { user: await withRole(request.user), view_as: viewAsOf(request.scope) };
  });

  app.patch('/me/nickname', async (request, reply) => {
    if (!request.user) throw unauthorized();
    const body = nicknameBodySchema.parse(request.body);
    const parsed = normalizeNickname(body.nickname);
    if (!parsed.ok) return sendError(request, reply, 400, parsed.reason === 'reserved' ? tk('Esse apelido é reservado') : tk('Use de 3 a 30 letras, números ou hífen'), 'NICKNAME_INVALID');
    // Once claimed, the address is this person's for good (spec §8): releasing it would let anyone
    // claim it next and inherit every /city/@nick link already shared. Re-sending the same one is a no-op.
    if (request.user.nickname && request.user.nickname !== parsed.value) {
      return sendError(request, reply, 409, 'Seu apelido já foi escolhido e não pode ser trocado', 'NICKNAME_LOCKED');
    }
    const out = await ctx.repos.users.setNickname(request.user.id, parsed.value);
    if (out === 'taken') return sendError(request, reply, 409, 'Esse apelido já é de outra pessoa', 'NICKNAME_TAKEN');
    if (out === 'locked') return sendError(request, reply, 409, 'Seu apelido já foi escolhido e não pode ser trocado', 'NICKNAME_LOCKED');
    request.log.info({ userId: request.user.id }, 'nickname: claimed');
    const claimed = { ...request.user, nickname: parsed.value };
    // A first claim only (re-sending the nickname you hold is a no-op): the city's short link is
    // started here, after the write, and nothing waits for it — the partner can be slow or down.
    if (!request.user.nickname) opts.onNicknameClaimed?.(claimed);
    return { user: await withRole(claimed) };
  });

  /** The language this person chose (TER-405): used for API errors, e-mails and push texts. */
  app.patch('/me/locale', async (request, reply) => {
    if (!request.user) throw unauthorized();
    const { locale } = localeBodySchema.parse(request.body);
    await ctx.repos.users.setLocale(request.user.id, locale);
    request.log.info({ userId: request.user.id, locale }, 'locale: set');
    return reply.code(204).send();
  });

  /** The client's IANA zone, saved with the automation's summary hour (spec D26). */
  app.patch('/me/time-zone', async (request, reply) => {
    if (!request.user) throw unauthorized();
    const { time_zone } = timeZoneBodySchema.parse(request.body);
    await ctx.repos.users.setTimeZone(request.user.id, time_zone);
    return reply.code(204).send();
  });

  /**
   * Admin-only data scope switch: see the app as another user (their machines, projects, tabs…),
   * as "all" (user_id "*") or back as yourself (null). Stored in a cookie so WebSockets follow too.
   */
  app.post('/view-as', async (request, reply) => {
    if (!request.user) throw unauthorized();
    if (!(await isAdmin(ctx.repos, request.user))) throw forbidden('Só administradores podem ver como outro usuário');
    const { user_id } = viewAsSchema.parse(request.body);
    const base = { path: '/', sameSite: 'lax' as const, secure: config.auth.cookieSecure, httpOnly: true };
    if (!user_id || user_id === request.user.id) {
      // Leaving another scope only narrows access: a failed audit write must not keep the admin in it.
      await endViewAsAudit(request.user.id, request.log);
      reply.clearCookie(VIEW_AS_COOKIE, { path: '/' });
      if (request.scope?.viewAs.kind !== 'self') await audit(ctx.repos, request, 'auth.view_as_end');
      return { view_as: null };
    }
    // Entering one is recorded first (TER-746): no audit row, no switch.
    if (user_id === VIEW_AS_ALL) {
      await ctx.repos.viewAsAudit.start({ admin_id: request.user.id, scope: 'all', ip: request.ip });
      reply.setCookie(VIEW_AS_COOKIE, VIEW_AS_ALL, base);
      request.log.info({ adminId: request.user.id, viewAs: VIEW_AS_ALL }, 'view-as set');
      await audit(ctx.repos, request, 'auth.view_as', { target: { type: 'user', id: VIEW_AS_ALL, label: 'all' } });
      return { view_as: 'all' as const };
    }
    const target = await ctx.repos.users.findById(user_id);
    if (!target) throw badRequest('Usuário inexistente');
    await ctx.repos.viewAsAudit.start({ admin_id: request.user.id, scope: 'user', target_user_id: target.id, ip: request.ip });
    reply.setCookie(VIEW_AS_COOKIE, target.id, base);
    request.log.info({ adminId: request.user.id, viewAs: target.id }, 'view-as set');
    await audit(ctx.repos, request, 'auth.view_as', { target: { type: 'user', id: target.id, label: target.email } });
    return { view_as: { id: target.id, name: target.name, email: target.email, avatar_url: target.avatar_url } };
  });

  app.post('/login', { config: { public: true } }, async (request, reply) => {
    if (!config.auth.modes.has('app')) throw badRequest('Login por senha desativado neste modo');
    const body = loginSchema.parse(request.body);
    const result = await service.loginWithPassword(body.email, body.password, request.ip);
    if (!result.ok && trailsFailure(result)) {
      await audit(ctx.repos, request, 'auth.login_failed', { actor: null, target: { type: 'email', label: body.email.trim().toLowerCase() }, meta: { method: 'password', reason: result.reason } });
    }
    if (!result.ok) {
      if (result.reason === 'locked') {
        reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
        throw new HttpError(429, msg('Muitas tentativas. Tente novamente em {{seconds}}s.', { seconds: Math.ceil(result.retryAfterMs / 1000) }), 'LOCKED');
      }
      throw unauthorized('E-mail ou senha inválidos');
    }
    const { token, csrf, expiresAt } = await service.createSession(result.user.id);
    setSessionCookies(reply, token, csrf, expiresAt);
    await audit(ctx.repos, request, 'auth.login', { actor: result.user, meta: { method: 'password' } });
    return { user: await withRole(result.user) };
  });

  // --- Login por código enviado por e-mail ---
  app.post('/code/send', { config: { public: true } }, async (request, reply) => {
    if (!config.auth.modes.has('app')) throw badRequest('Login por e-mail desativado neste modo');
    const body = sendCodeSchema.parse(request.body);
    const result = await service.sendLoginCode(body.email, request.ip, requestLocale(request));
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
        throw new HttpError(429, 'Muitos envios. Aguarde alguns minutos e tente de novo.', 'RATE_LIMITED');
      }
      throw new HttpError(502, 'Não foi possível enviar o e-mail. Tente novamente.', 'SEND_FAILED');
    }
    return { ok: true, ttl_minutes: Math.round(config.auth.loginCodeTtlMs / 60000) };
  });

  app.post('/code/verify', { config: { public: true } }, async (request, reply) => {
    if (!config.auth.modes.has('app')) throw badRequest('Login por e-mail desativado neste modo');
    const body = verifyCodeSchema.parse(request.body);
    const result = await service.verifyLoginCode(body.email, body.code, request.ip);
    if (!result.ok && trailsFailure(result)) {
      await audit(ctx.repos, request, 'auth.login_failed', { actor: null, target: { type: 'email', label: body.email.trim().toLowerCase() }, meta: { method: 'email_code', reason: result.reason } });
    }
    if (!result.ok) {
      if (result.reason === 'locked') {
        reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
        throw new HttpError(429, msg('Muitas tentativas. Tente novamente em {{seconds}}s.', { seconds: Math.ceil(result.retryAfterMs / 1000) }), 'LOCKED');
      }
      throw unauthorized('Código inválido ou expirado');
    }
    const { token, csrf, expiresAt } = await service.createSession(result.user.id);
    setSessionCookies(reply, token, csrf, expiresAt);
    await audit(ctx.repos, request, 'auth.login', { actor: result.user, meta: { method: 'email_code' } });
    return { user: await withRole(result.user) };
  });

  app.post('/logout', { config: { allowPendingDeletion: true } }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (request.user) await audit(ctx.repos, request, 'auth.logout');
    if (token) await service.destroySession(token);
    if (request.user && request.cookies[VIEW_AS_COOKIE]) await endViewAsAudit(request.user.id, request.log);
    clearSessionCookies(reply);
    return { ok: true };
  });

  // --- Google OAuth (Authorization Code + PKCE) ---
  app.get('/google', { config: { public: true } }, async (_request, reply) => {
    if (!isGoogleEnabled() || !config.auth.modes.has('app')) throw badRequest('Google OAuth não configurado');
    const { url, oauth } = buildAuthorizationUrl();
    reply.setCookie(OAUTH_COOKIE, JSON.stringify(oauth), {
      path: '/api/auth/google',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.auth.cookieSecure,
      maxAge: 600,
    });
    return reply.redirect(url, 302);
  });

  app.get('/google/callback', { config: { public: true } }, async (request, reply) => {
    if (!isGoogleEnabled() || !config.auth.modes.has('app')) throw badRequest('Google OAuth não configurado');
    const query = callbackSchema.parse(request.query);
    reply.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' });

    const fail = (reason: string) => reply.redirect(`/login?error=${encodeURIComponent(reason)}`, 302);
    if (query.error || !query.code || !query.state) return fail('google_denied');

    let saved: { state: string; verifier: string } | null = null;
    try {
      saved = JSON.parse(request.cookies[OAUTH_COOKIE] ?? '');
    } catch {
      saved = null;
    }
    if (!saved || saved.state !== query.state) return fail('state_mismatch');

    let profile;
    try {
      profile = await exchangeCode(query.code, saved.verifier);
    } catch (err) {
      request.log.warn({ err }, 'falha na troca do code do Google');
      return fail('google_exchange');
    }

    const user = await service.loginWithGoogle(profile);
    if (!user) {
      await audit(ctx.repos, request, 'auth.login_failed', { actor: null, target: { type: 'email', label: profile.email.toLowerCase() }, meta: { method: 'google', reason: 'not_allowed' } });
      return fail('email_not_allowed');
    }

    const { token, csrf, expiresAt } = await service.createSession(user.id);
    setSessionCookies(reply, token, csrf, expiresAt);
    await audit(ctx.repos, request, 'auth.login', { actor: user, meta: { method: 'google' } });
    return reply.redirect('/', 302);
  });
}
