import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import type { User } from '../db/repositories/types.js';
import { authenticateToken } from '../mcp/auth.js';
import { legalRefusal } from '../mcp/legal-gate.js';
import { canAccess, actionForMethod } from '../auth/permissions.js';
import { isEnabled } from '../features/flags.js';
import { HttpError, type Message } from '../lib/errors.js';
import { requestLocale, t, tk } from '../i18n/index.js';

/**
 * Bearer-only auth of the personal runs API (`/api/v1`, TER-1176, spec "Contract" and "Security").
 * Registered outside `/api`, so the session cookie, CSRF and "view as" never run here: a personal
 * token with the `runs` scope is the only way in, and its owner is the only data scope — an admin's
 * token sees the admin's own runs, nobody else's.
 *
 * Order: no valid token → 401; the `runs_api` flag off for the owner → 404 (as if the prefix did not
 * exist); a token without `runs`, or a gated/tab token → 403 SCOPE_REQUIRED; the role without the
 * `runs:<action>` grant → 403 FORBIDDEN; Terms pending → 403 LEGAL_ACCEPTANCE_REQUIRED.
 * Errors answer `{ error: { code, message } }`. Each call leaves one `ApiTokenEvent` (metadata only).
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** set by the /api/v1 token check */
    runsAuth?: { token: ApiToken; user: User };
    /** the error code a /api/v1 call answered, for its ApiTokenEvent */
    runsErrorCode?: string;
    /** the project a /api/v1 call touched, for its ApiTokenEvent */
    runsProjectId?: string;
  }
}

export class V1Error extends HttpError {
  /** Sent as `Retry-After` (seconds), for a 429. */
  retryAfterS?: number;
  /** Extra fields inside `error` (e.g. the reason per account of a 409 NO_ACCOUNT_AVAILABLE). */
  details?: Record<string, unknown>;
}

const err = (status: number, code: string, message: Message) => new V1Error(status, message, code);

/** Sends the v1 error shape, translated with the caller's language; never anything of the run. */
function sendV1(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: Message, details: Record<string, unknown> = {}) {
  request.runsErrorCode = code;
  return reply.code(status).send({ error: { code, message: t(requestLocale(request), message), ...details } });
}

/**
 * Sets up a `/api/v1` plugin instance: the token hook, the error and not-found handlers and the audit
 * row of each call. Call it first thing inside the plugin.
 */
export function installV1Auth(app: FastifyInstance, repos: Repositories): void {
  app.setErrorHandler((e, request, reply) => {
    if (e instanceof ZodError) return sendV1(request, reply, 422, 'VALIDATION', tk('Dados inválidos'));
    if (e instanceof V1Error && e.retryAfterS !== undefined) void reply.header('retry-after', String(e.retryAfterS));
    if (e instanceof HttpError) {
      const code = e.code === 'UNAUTHORIZED' ? 'UNAUTHENTICATED' : (e.code ?? 'ERROR');
      return sendV1(request, reply, e.statusCode, code, e.localized, e instanceof V1Error ? e.details : undefined);
    }
    const status = (e as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: e, route: request.routeOptions.url }, 'runs v1: unhandled error');
      return sendV1(request, reply, 500, 'INTERNAL', tk('Erro interno'));
    }
    // Fastify's own 4xx (a body that is not JSON, too large…): nothing of it is echoed back.
    return sendV1(request, reply, status, 'BAD_REQUEST', tk('Requisição inválida'));
  });
  app.setNotFoundHandler((request, reply) => sendV1(request, reply, 404, 'NOT_FOUND', tk('Rota não encontrada')));

  app.addHook('onRequest', async (request) => {
    const auth = await authenticateToken(repos, request.headers.authorization);
    if (!auth) throw err(401, 'UNAUTHENTICATED', tk('Não autenticado'));
    request.runsAuth = { token: auth.token, user: auth.user };
    // The scope every scoped(...) lookup of this request uses: always the token's owner, never "view as".
    request.user = auth.user;
    request.scope = { user: auth.user, viewAs: { kind: 'self' }, ownerId: auth.user.id, createAs: auth.user.id };
    void repos.apiTokens.touchLastUsed(auth.token.id).catch((e: unknown) => request.log.warn({ err: e }, 'runs v1: touchLastUsed failed'));

    if (!(await isEnabled('runs_api', { repos, userId: auth.user.id }))) throw err(404, 'NOT_FOUND', tk('Rota não encontrada'));
    // A gated (concierge) or tab token never carries `runs` (assertScopesFor); a row that says otherwise is refused anyway.
    if (!auth.token.scopes.includes('runs') || auth.token.gated || auth.token.tab_id) {
      throw err(403, 'SCOPE_REQUIRED', tk('Este token não tem o escopo runs'));
    }
    const action = (request.routeOptions.config as { action?: string } | undefined)?.action ?? actionForMethod(request.method);
    if (!(await canAccess(repos, auth.user, 'runs', action))) throw err(403, 'FORBIDDEN', tk('Sem permissão'));
    // The Terms (TER-742): the same refusal the MCP gives, already in the caller's language.
    const legal = await legalRefusal(repos, auth.user.id, requestLocale(request));
    if (legal) throw err(403, 'LEGAL_ACCEPTANCE_REQUIRED', legal);
  });

  // One ApiTokenEvent per call made with a valid token: method and route pattern, status, duration.
  app.addHook('onResponse', async (request, reply) => recordV1Call(repos, request, reply.statusCode, reply.elapsedTime));
}

/** The call's ApiTokenEvent (metadata only). A hijacked reply (the SSE stream) records its own, as it opens. */
export function recordV1Call(repos: Repositories, request: FastifyRequest, status: number, elapsedMs: number): void {
  const token = request.runsAuth?.token;
  if (!token) return;
  const pattern = request.routeOptions.url ?? '*';
  const route = pattern.startsWith('/api/v1') ? pattern.slice('/api/v1'.length) || '/' : pattern;
  const ok = status < 400;
  void repos.apiTokens
    .recordEvent({
      token_id: token.id,
      tool: `REST ${request.method} ${route}`.slice(0, 64),
      project_id: request.runsProjectId ?? null,
      ok,
      error_code: ok ? null : (request.runsErrorCode ?? 'ERROR'),
      duration_ms: Math.round(elapsedMs),
    })
    .catch((e: unknown) => request.log.warn({ err: e }, 'runs v1: recordEvent failed'));
}
