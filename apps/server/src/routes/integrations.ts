import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { encryptionAvailable } from '../lib/crypto.js';
import { getProvider } from '../integrations/index.js';
import { checkPublicUrl } from '../integrations/public-url.js';
import { audit } from '../auth/audit.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const providerEnum = z.enum(['github', 'linear', 'jira']);

const configSchema = z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).default({});

const createBody = z.object({
  provider: providerEnum,
  name: z.string().trim().min(1).max(80),
  config: configSchema,
  secret: z.string().min(1).max(4096),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  config: configSchema.optional(),
  secret: z.string().min(1).max(4096).optional(),
});
const testBody = z.object({
  provider: providerEnum,
  config: configSchema,
  secret: z.string().min(1).max(4096).optional(),
  /** testar uma integração já salva (usa o segredo do banco) */
  integration_id: z.string().min(1).max(64).optional(),
});

/**
 * The server calls Jira at the base URL the user typed, so it must be a public https site (TER-578):
 * refused here with the reason, before anything is saved or requested.
 */
async function assertJiraBaseUrl(provider: string, config: Record<string, unknown> | undefined) {
  if (provider !== 'jira' || !config) return;
  const check = await checkPublicUrl(String(config.baseUrl ?? ''));
  if (!check.ok) throw badRequest(check.reason);
}

export async function integrationRoutes(app: FastifyInstance, repos: Repositories) {
  app.addHook('preHandler', async () => {
    if (!encryptionAvailable()) throw badRequest('ENCRYPTION_KEY não configurada no servidor (openssl rand -base64 32)');
  });

  app.get('/', async (request) => ({ integrations: await repos.integrations.list(request.scope.ownerId) }));

  app.post('/', async (request, reply) => {
    const body = createBody.parse(request.body);
    await assertJiraBaseUrl(body.provider, body.config);
    const integration = await repos.integrations.create({ ...body, owner_id: request.scope.createAs });
    await audit(repos, request, 'integration.create', { target: { type: 'integration', id: integration.id, label: integration.name }, meta: { provider: integration.provider, owner_id: request.scope.createAs } });
    return reply.code(201).send({ integration });
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const current = await scoped(repos, request).integration(id);
    const body = patchBody.parse(request.body);
    await assertJiraBaseUrl(current.provider, body.config);
    return { integration: await repos.integrations.update(id, body) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const integration = await scoped(repos, request).integration(id);
    await repos.integrations.delete(id);
    await audit(repos, request, 'integration.delete', { target: { type: 'integration', id, label: integration.name }, meta: { provider: integration.provider, owner_id: integration.owner_id } });
    return { ok: true };
  });

  /** Valida credenciais e devolve opções (times, projetos, repos) para o setup. */
  app.post('/test', async (request) => {
    const body = testBody.parse(request.body);
    let secret = body.secret;
    let config = body.config;
    if (!secret && body.integration_id) {
      const saved = await scoped(repos, request).integration(body.integration_id);
      secret = await repos.integrations.getSecret(body.integration_id);
      config = { ...saved.config, ...config } as typeof config;
    }
    if (!secret) throw badRequest('Informe o segredo ou integration_id');
    await assertJiraBaseUrl(body.provider, config);
    return await getProvider(body.provider).testConnection(secret, config);
  });
}
