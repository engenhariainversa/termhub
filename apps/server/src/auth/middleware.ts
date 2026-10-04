import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { config } from '../config.js';
import type { User } from '../db/repositories/types.js';
import type { Repositories } from '../db/repositories/index.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import type { AuthService } from './service.js';
import { CF_HEADER, verifyCloudflareJwt } from './cloudflare.js';
import { actionForMethod, canAccess } from './permissions.js';
import { resolveScope } from './scope.js';
import { isPendingDeletion, pendingDeletion } from '../account/deletion.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, safeEqual } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface AuthContext {
  service: AuthService;
  repos: Repositories;
}

/** Parse mínimo de cookies (para o upgrade do WebSocket, que não passa pelo Fastify). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Resolve o usuário a partir de headers/cookies crus.
 * Retorna null se não autenticado. Lança se um modo obrigatório falhar de forma explícita.
 */
export async function resolveUser(
  ctx: AuthContext,
  input: { headers: IncomingMessage['headers']; cookies: Record<string, string> },
): Promise<User | null> {
  const modes = config.auth.modes;

  if (modes.has('disabled')) {
    // Dev: qualquer requisição vira o primeiro owner (ou primeiro usuário).
    return (await ctx.repos.users.findFirstOwner()) ?? null;
  }

  let cfUser: User | null = null;
  if (modes.has('cloudflare')) {
    const raw = input.headers[CF_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token) return null;
    let identity;
    try {
      identity = await verifyCloudflareJwt(token);
    } catch {
      return null;
    }
    cfUser = (await ctx.repos.users.findByEmail(identity.email)) ?? null;
    if (!cfUser) return null;
  }

  let appUser: User | null = null;
  if (modes.has('app')) {
    const token = input.cookies[SESSION_COOKIE];
    if (!token) return null;
    appUser = await ctx.service.resolveSession(token);
    if (!appUser) return null;
  }

  // Ambos os modos ativos: o usuário do Cloudflare precisa bater com o da sessão.
  if (cfUser && appUser && cfUser.id !== appUser.id) return null;
  return appUser ?? cfUser;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Hook global: autentica todas as rotas, exceto as marcadas como públicas. */
export function buildAuthHook(ctx: AuthContext) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply) {
    const routeConfig = (request.routeOptions?.config ?? {}) as { public?: boolean; resource?: string; action?: string; allowPendingDeletion?: boolean };
    request.user = await resolveUser(ctx, { headers: request.headers, cookies: request.cookies as Record<string, string> });

    if (request.user) request.scope = await resolveScope(ctx.repos, request.user, request.cookies as Record<string, string>);
    if (routeConfig.public) return;
    if (!request.user) throw unauthorized();
    // A deactivated account (deletion pending, TER-720) reaches only the routes that show and cancel it.
    if (isPendingDeletion(request.user) && !routeConfig.allowPendingDeletion) throw pendingDeletion();

    // Resource guard: routes registered under a guarded plugin carry { resource, action } (see guarded() in app.ts).
    if (routeConfig.resource) {
      const action = routeConfig.action ?? actionForMethod(request.method);
      if (!(await canAccess(ctx.repos, request.user, routeConfig.resource, action))) {
        throw forbidden(`Sem permissão: ${routeConfig.resource}:${action}`);
      }
    }

    // CSRF (double submit): mutações precisam do header igual ao cookie.
    if (config.auth.modes.has('app') && !SAFE_METHODS.has(request.method)) {
      const cookie = request.cookies[CSRF_COOKIE];
      const header = request.headers[CSRF_HEADER];
      const headerValue = Array.isArray(header) ? header[0] : header;
      if (!cookie || !headerValue || !safeEqual(cookie, headerValue)) {
        throw forbidden('Token CSRF inválido');
      }
    }
    void reply;
  };
}
