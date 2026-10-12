import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { acceptIdsSchema, acceptanceOrigin, acceptLegalVersions } from '../legal/accept.js';
import { unauthorized } from '../lib/errors.js';

const acceptBody = z.object({ version_ids: acceptIdsSchema });

/**
 * The app's acceptance screen (TER-742), mounted at `/legal` of the mobile API: the same status and
 * rules as the web's `/api/legal`, with the channel always `mobile`. Any enrolled device, no role grant.
 */
export async function mobileLegalRoutes(app: FastifyInstance, repos: Repositories) {
  const userOf = (request: FastifyRequest) => {
    const mobile = request.mobile;
    if (!mobile || !('device' in mobile)) throw unauthorized();
    return mobile.user;
  };

  app.get('/', async (request) => repos.legal.statusFor(userOf(request).id));

  app.post('/accept', async (request) => {
    const user = userOf(request);
    const body = acceptBody.parse(request.body);
    const status = await acceptLegalVersions(repos, user.id, body.version_ids, { ...acceptanceOrigin(request), channel: 'mobile' });
    request.log.info({ userId: user.id, versions: body.version_ids, channel: 'mobile' }, 'legal: accepted');
    return status;
  });
}
