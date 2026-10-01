import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { toPublicUser, type User } from '../db/repositories/types.js';
import { isAdmin, permissionsOf } from './permissions.js';
import { VIEW_AS_ALL, VIEW_AS_COOKIE, type Scope } from './scope.js';
import { HttpError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import type { AuthContext } from './middleware.js';
import { buildAuthorizationUrl, exchangeCode, isGoogleEnabled } from './google.js';
import { normalizeNickname } from '../public/nickname.js';
import { CSRF_COOKIE, OAUTH_COOKIE, SESSION_COOKIE } from './tokens.js';

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

export async function authRoutes(app: FastifyInstance, ctx: AuthContext, opts: { onNicknameClaimed?: (user: User) => void } = {}) {
  /** Public user + role summary + flat permission list: what the client needs to gate its UI. */
  const withRole = async (u: User) => {
    const role = u.role_id ? await ctx.repos.roles.findById(u.role_id) : undefined;
    return {
      ...toPublicUser(u),
      role_info: role ? { id: role.id, name: role.name, label: role.label, is_admin: role.is_admin } : null,
      permissions: await permissionsOf(ctx.repos, u),
    };
  };

  const { service } = ctx;

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
    if (!parsed.ok) return reply.code(400).send({ error: parsed.reason === 'reserved' ? 'Esse apelido é reservado' : 'Use de 3 a 30 letras, números ou hífen', code: 'NICKNAME_INVALID' });
    // Once claimed, the address is this person's for good (spec §8): releasing it would let anyone
    // claim it next and inherit every /city/@nick link already shared. Re-sending the same one is a no-op.
    if (request.user.nickname && request.user.nickname !== parsed.value) {
      return reply.code(409).send({ error: 'Seu apelido já foi escolhido e não pode ser trocado', code: 'NICKNAME_LOCKED' });
    }
    const out = await ctx.repos.users.setNickname(request.user.id, parsed.value);
    if (out === 'taken') return reply.code(409).send({ error: 'Esse apelido já é de outra pessoa', code: 'NICKNAME_TAKEN' });
    if (out === 'locked') return reply.code(409).send({ error: 'Seu apelido já foi escolhido e não pode ser trocado', code: 'NICKNAME_LOCKED' });
    request.log.info({ userId: request.user.id }, 'nickname: claimed');
    const claimed = { ...request.user, nickname: parsed.value };
    // A first claim only (re-sending the nickname you hold is a no-op): the city's short link is
    // started here, after the write, and nothing waits for it — the partner can be slow or down.
    if (!request.user.nickname) opts.onNicknameClaimed?.(claimed);
    return { user: await withRole(claimed) };
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
      reply.clearCookie(VIEW_AS_COOKIE, { path: '/' });
      return { view_as: null };
    }
    if (user_id === VIEW_AS_ALL) {
      reply.setCookie(VIEW_AS_COOKIE, VIEW_AS_ALL, base);
      return { view_as: 'all' as const };
    }
    const target = await ctx.repos.users.findById(user_id);
    if (!target) throw badRequest('Usuário inexistente');
    reply.setCookie(VIEW_AS_COOKIE, target.id, base);
    request.log.info({ adminId: request.user.id, viewAs: target.id }, 'view-as set');
    return { view_as: { id: target.id, name: target.name, email: target.email, avatar_url: target.avatar_url } };
  });

  app.post('/login', { config: { public: true } }, async (request, reply) => {
    if (!config.auth.modes.has('app')) throw badRequest('Login por senha desativado neste modo');
    const body = loginSchema.parse(request.body);
    const result = await service.loginWithPassword(body.email, body.password, request.ip);
    if (!result.ok) {
      if (result.reason === 'locked') {
        reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
        throw new HttpError(429, `Muitas tentativas. Tente novamente em ${Math.ceil(result.retryAfterMs / 1000)}s.`, 'LOCKED');
      }
      throw unauthorized('E-mail ou senha inválidos');
    }
    const { token, csrf, expiresAt } = await service.createSession(result.user.id);
    setSessionCookies(reply, token, csrf, expiresAt);
    return { user: await withRole(result.user) };
  });

  // --- Login por código enviado por e-mail ---
  app.post('/code/send', { config: { public: true } }, async (request, reply) => {
    if (!config.auth.modes.has('app')) throw badRequest('Login por e-mail desativado neste modo');
    const body = sendCodeSchema.parse(request.body);
    const result = await service.sendLoginCode(body.email, request.ip);
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
    if (!result.ok) {
      if (result.reason === 'locked') {
        reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
        throw new HttpError(429, `Muitas tentativas. Tente novamente em ${Math.ceil(result.retryAfterMs / 1000)}s.`, 'LOCKED');
      }
      throw unauthorized('Código inválido ou expirado');
    }
    const { token, csrf, expiresAt } = await service.createSession(result.user.id);
    setSessionCookies(reply, token, csrf, expiresAt);
    return { user: await withRole(result.user) };
  });

  app.post('/logout', { config: { allowPendingDeletion: true } }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await service.destroySession(token);
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
    if (!user) return fail('email_not_allowed');

    const { token, csrf, expiresAt } = await service.createSession(user.id);
    setSessionCookies(reply, token, csrf, expiresAt);
    return reply.redirect('/', 302);
  });
}
