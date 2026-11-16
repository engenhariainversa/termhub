import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import {
  API_TOKEN_EVENT_RETENTION_DAYS,
  API_TOKEN_ORIGINS,
  API_TOKEN_SCOPES,
  MAX_ACTIVE_TOKENS_PER_USER,
  newApiToken,
  PERSON_REVOKED_TOKEN_RETENTION_DAYS,
  SYSTEM_TOKEN_IDLE_DAYS,
  SYSTEM_TOKEN_ORIGINS,
  SYSTEM_TOKEN_RETENTION_DAYS,
  toScopes,
  type ApiTokenOrigin,
} from '../auth/api-tokens.js';
import type { ApiToken, ApiTokenFilter } from '../db/repositories/api-tokens.js';
import { badRequest } from '../lib/errors.js';
import { conflict, notFound } from '../lib/errors.js';
import { msg } from '../i18n/index.js';
import { audit } from '../auth/audit.js';
import { isEnabled } from '../features/flags.js';
import { HttpError } from '../lib/errors.js';
import { tk } from '../i18n/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One screen of tokens (TER-1191): the list is paged on the server, never loaded whole. */
export const API_TOKENS_PAGE_MAX = 100;

const idParam = z.object({ id: z.string().min(1).max(64) });
const idText = z.string().min(1).max(64).regex(/^[a-z0-9]+$/);
/** `origin` is one origin, `system` (every origin termhub mints by itself) or a comma list of origins. */
const originParam = z
  .string()
  .max(80)
  .transform((v, ctx): ApiTokenOrigin[] => {
    if (v === 'system') return [...SYSTEM_TOKEN_ORIGINS];
    const list = v.split(',').map((x) => x.trim());
    if (!list.every((x): x is ApiTokenOrigin => (API_TOKEN_ORIGINS as readonly string[]).includes(x))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unknown origin' });
      return z.NEVER;
    }
    return [...new Set(list)];
  });
const listQuery = z.object({
  origin: originParam.optional(),
  status: z.enum(['active', 'expired', 'revoked']).optional(),
  project_id: idText.optional(),
  machine_id: idText.optional(),
  scope: z.enum(API_TOKEN_SCOPES).optional(),
  created_from: z.coerce.date().optional(),
  created_to: z.coerce.date().optional(),
  used_from: z.coerce.date().optional(),
  used_to: z.coerce.date().optional(),
  q: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(API_TOKENS_PAGE_MAX).default(50),
  /** the `next` an earlier page returned */
  before: z.string().max(128).optional(),
});

/** `<iso date>_<id>`: the keyset cursor of the last row a page showed. */
const cursorOf = (t: ApiToken) => `${t.created_at}_${t.id}`;

function parseCursor(raw: string): NonNullable<ApiTokenFilter['before']> {
  const at = raw.indexOf('_');
  const created_at = new Date(raw.slice(0, at));
  const id = raw.slice(at + 1);
  if (at <= 0 || Number.isNaN(created_at.getTime()) || !/^[a-z0-9]{1,64}$/.test(id)) throw badRequest('Cursor inválido');
  return { created_at, id };
}
const eventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1),
  expires_in_days: z.number().int().min(1).max(365).optional().nullable(),
});

/**
 * Personal API tokens (Settings → Tokens de API). Always the signed-in user's own tokens:
 * `request.user`, never `request.scope` — an admin "viewing as" someone does not get their tokens.
 */
export async function apiTokenRoutes(app: FastifyInstance, repos: Repositories, opts: { mcpUrl: string | null }) {
  /** One page of the person's tokens, newest first, with the screen's filters (TER-1191). */
  app.get('/', async (request) => {
    const { limit, before, origin, ...q } = listQuery.parse(request.query);
    const userId = request.user!.id;
    const filter: ApiTokenFilter = { ...q, origins: origin, before: before ? parseCursor(before) : undefined };
    const [rows, system] = await Promise.all([repos.apiTokens.list(userId, filter, limit + 1), repos.apiTokens.systemSummary(userId)]);
    const tokens = rows.slice(0, limit);
    return {
      tokens,
      next: rows.length > limit ? cursorOf(tokens[tokens.length - 1]!) : null,
      system,
      retention: { system_days: SYSTEM_TOKEN_RETENTION_DAYS, person_revoked_days: PERSON_REVOKED_TOKEN_RETENTION_DAYS, idle_days: SYSTEM_TOKEN_IDLE_DAYS },
    };
  });

  /** The projects and machines the person's tokens name, for the filter selects. */
  app.get('/facets', async (request) => repos.apiTokens.facets(request.user!.id));

  /** "Revogar inativos": the person's system tokens unused for SYSTEM_TOKEN_IDLE_DAYS; never their own. */
  app.delete('/idle', async (request) => {
    const revoked = await repos.apiTokens.revokeIdleSystem(request.user!.id);
    if (revoked > 0) await audit(repos, request, 'api_token.revoke', { meta: { idle_system_tokens: revoked } });
    return { revoked };
  });

  app.post('/', async (request, reply) => {
    const body = createBody.parse(request.body ?? {});
    const userId = request.user!.id;
    // `runs` (TER-1176) exists only for whoever has the runs API on: while it is off the scope is unknown.
    if (body.scopes.includes('runs') && !(await isEnabled('runs_api', { repos, userId }))) {
      throw new HttpError(422, tk('Escopo indisponível: runs'), 'VALIDATION');
    }
    if ((await repos.apiTokens.countActive(userId)) >= MAX_ACTIVE_TOKENS_PER_USER) {
      throw conflict(msg('Limite de {{max}} tokens ativos: revogue um antes de criar outro', { max: MAX_ACTIVE_TOKENS_PER_USER }));
    }
    const { token, hash } = newApiToken();
    const expiresAt = body.expires_in_days ? new Date(Date.now() + body.expires_in_days * DAY_MS) : null;
    const apiToken = await repos.apiTokens.create(userId, { name: body.name, scopes: toScopes(body.scopes), expiresAt, origin: 'person' }, hash);
    await audit(repos, request, 'api_token.create', { target: { type: 'api_token', id: apiToken.id, label: apiToken.name }, meta: { scopes: apiToken.scopes, expires_at: apiToken.expires_at } });
    // The only response that ever carries the plain token.
    return reply.code(201).send({ api_token: apiToken, token, mcp_url: opts.mcpUrl });
  });

  /** The token's MCP calls of the last API_TOKEN_EVENT_RETENTION_DAYS (TER-577): metadata only, newest first. */
  app.get('/:id/events', async (request) => {
    const { id } = idParam.parse(request.params);
    const { limit } = eventsQuery.parse(request.query);
    const events = await repos.apiTokens.listEvents(id, request.user!.id, limit);
    if (!events) throw notFound('Token não encontrado');
    return { events, retention_days: API_TOKEN_EVENT_RETENTION_DAYS };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const apiToken = await repos.apiTokens.revoke(id, request.user!.id);
    if (!apiToken) throw notFound('Token não encontrado');
    await audit(repos, request, 'api_token.revoke', { target: { type: 'api_token', id: apiToken.id, label: apiToken.name } });
    return { api_token: apiToken };
  });
}
