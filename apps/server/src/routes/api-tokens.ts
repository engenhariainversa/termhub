import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { API_TOKEN_EVENT_RETENTION_DAYS, API_TOKEN_SCOPES, MAX_ACTIVE_TOKENS_PER_USER, newApiToken, toScopes } from '../auth/api-tokens.js';
import { conflict, notFound } from '../lib/errors.js';
import { msg } from '../i18n/index.js';
import { audit } from '../auth/audit.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const idParam = z.object({ id: z.string().min(1).max(64) });
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
  app.get('/', async (request) => ({ tokens: await repos.apiTokens.listByUser(request.user!.id) }));

  app.post('/', async (request, reply) => {
    const body = createBody.parse(request.body ?? {});
    const userId = request.user!.id;
    if ((await repos.apiTokens.countActive(userId)) >= MAX_ACTIVE_TOKENS_PER_USER) {
      throw conflict(msg('Limite de {{max}} tokens ativos: revogue um antes de criar outro', { max: MAX_ACTIVE_TOKENS_PER_USER }));
    }
    const { token, hash } = newApiToken();
    const expiresAt = body.expires_in_days ? new Date(Date.now() + body.expires_in_days * DAY_MS) : null;
    const apiToken = await repos.apiTokens.create(userId, { name: body.name, scopes: toScopes(body.scopes), expiresAt }, hash);
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
