import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { LegalChannel, LegalStatus } from '../db/repositories/legal.js';
import { acceptableIds } from '../db/repositories/legal-status.js';
import { HttpError } from '../lib/errors.js';

/** The ids being accepted: what the acceptance screen (or the banner, early) showed. */
export const acceptIdsSchema = z.array(z.string().min(1).max(64)).min(1).max(10);

const USER_AGENT_MAX = 512;

/** The request's origin, kept with the acceptance as evidence. */
export function acceptanceOrigin(request: FastifyRequest): { ip: string | null; user_agent: string | null } {
  const ua = request.headers['user-agent'];
  return { ip: request.ip || null, user_agent: typeof ua === 'string' && ua ? ua.slice(0, USER_AGENT_MAX) : null };
}

/**
 * Records that `userId` accepted `versionIds` (TER-742) and returns the new status. Every id must be one
 * of this person's pending or upcoming versions: anything else (a minor version, one already accepted,
 * an unknown id) is refused with 400 and nothing is recorded.
 */
export async function acceptLegalVersions(
  repos: Pick<Repositories, 'legal'>,
  userId: string,
  versionIds: readonly string[],
  meta: { ip: string | null; user_agent: string | null; channel: LegalChannel },
): Promise<LegalStatus> {
  const now = new Date();
  const allowed = acceptableIds(await repos.legal.statusFor(userId, now));
  if (versionIds.some((id) => !allowed.has(id))) {
    throw new HttpError(400, 'Esta versão não está aguardando o seu aceite. Recarregue a página e tente de novo.', 'LEGAL_VERSION_NOT_PENDING');
  }
  await repos.legal.recordAcceptances(userId, versionIds, meta);
  return repos.legal.statusFor(userId, now);
}
