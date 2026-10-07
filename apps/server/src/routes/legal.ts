import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { LEGAL_NOTICE_MS } from '../db/repositories/legal.js';
import { LEGAL_DOCUMENTS } from '../db/repositories/legal-status.js';
import { acceptIdsSchema, acceptanceOrigin, acceptLegalVersions } from '../legal/accept.js';
import { HttpError, unauthorized } from '../lib/errors.js';

const acceptBody = z.object({
  version_ids: acceptIdsSchema,
  /** 'checkout' when the acceptance comes with a purchase (TER-681); the app posts to its own route. */
  channel: z.enum(['web', 'checkout']).default('web'),
});

const createVersionBody = z.object({
  document: z.enum(LEGAL_DOCUMENTS),
  version: z.string().trim().min(1).max(20),
  effective_at: z.string().datetime({ offset: true }),
  url: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((u) => u.startsWith('https://'), 'https URL'),
  requires_acceptance: z.boolean().default(true),
  summary: z.string().trim().max(2000).nullish(),
});

/**
 * The signed-in person's acceptance of the Terms of Use and of the Privacy Policy (TER-742), mounted at
 * `/api/legal`. Any signed-in person, no role grant: it is about their own account.
 */
export async function legalRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/status', async (request) => {
    if (!request.user) throw unauthorized();
    return repos.legal.statusFor(request.user.id);
  });

  app.post('/accept', async (request) => {
    if (!request.user) throw unauthorized();
    const body = acceptBody.parse(request.body);
    const status = await acceptLegalVersions(repos, request.user.id, body.version_ids, { ...acceptanceOrigin(request), channel: body.channel });
    request.log.info({ userId: request.user.id, versions: body.version_ids, channel: body.channel }, 'legal: accepted');
    return status;
  });
}

/**
 * The versions themselves, mounted at `/api/legal/versions` under the `legal` resource (admins only by
 * default). A relevant version that replaces an earlier one must take effect 30+ days after it is
 * registered, so the notice e-mail and the banner have time to reach everyone (spec decision 6).
 */
export async function legalVersionRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async () => ({ versions: await repos.legal.listVersions() }));

  app.post('/', async (request, reply) => {
    const body = createVersionBody.parse(request.body);
    const effectiveAt = new Date(body.effective_at);
    if (body.requires_acceptance && (await repos.legal.latestVersion(body.document))) {
      if (effectiveAt.getTime() < Date.now() + LEGAL_NOTICE_MS) {
        throw new HttpError(400, 'Uma nova versão que pede aceite só pode valer daqui a 30 dias ou mais, para dar tempo do aviso.', 'LEGAL_NOTICE_TOO_SHORT');
      }
    }
    const created = await repos.legal.createVersion({
      document: body.document,
      version: body.version,
      effective_at: effectiveAt,
      url: body.url,
      requires_acceptance: body.requires_acceptance,
      summary: body.summary || null,
    });
    if (!created) throw new HttpError(409, 'Esse documento já tem uma versão com esse número.', 'LEGAL_VERSION_EXISTS');
    request.log.info({ versionId: created.id, document: created.document, version: created.version, requiresAcceptance: created.requires_acceptance }, 'legal: version registered');
    return reply.code(201).send({ version: created });
  });
}
