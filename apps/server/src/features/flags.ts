import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError } from '../lib/errors.js';
import { tk } from '../i18n/index.js';

/**
 * Feature flags (TER-1040, docs/feature-flags.md): a feature that ships dark, turned on for the whole
 * instance by an admin (Configurações → Recursos em teste) or for one person to test it, without a
 * deploy. Read on the server only; clients get the resolved values from `/auth/me`, the mobile `/me`
 * and, for the landing, `/api/public/features`.
 *
 * `default` is the value when no admin has touched the flag: off, so a new flag never shows up on an
 * instance by surprise.
 */
export const FEATURE_FLAGS = {
  /** Subscriptions (epic TER-645): plans, checkout, paywall, trial limits and the provider's webhooks. */
  subscriptions: { default: false },
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlag[];
export const isFeatureFlag = (v: string): v is FeatureFlag => Object.hasOwn(FEATURE_FLAGS, v);

/** Every flag resolved for one person: what `/auth/me` and the mobile `/me` send as `features`. */
export type FeatureFlags = Record<FeatureFlag, boolean>;

export interface FlagContext {
  repos: Pick<Repositories, 'featureFlags'>;
  /** The signed-in person; null/undefined = nobody (the instance value only). */
  userId?: string | null;
}

/** The instance-wide value: what the admin set, else the default in code. */
export async function instanceValue(flag: FeatureFlag, repos: FlagContext['repos']): Promise<boolean> {
  return (await repos.featureFlags.instanceValue(flag)) ?? FEATURE_FLAGS[flag].default;
}

/**
 * The one check every gated feature goes through: the person's own override wins, else the instance
 * value. No cache on purpose: blue and green read the same rows, so an admin's switch holds on both
 * at once.
 */
export async function isEnabled(flag: FeatureFlag, ctx: FlagContext): Promise<boolean> {
  if (ctx.userId) {
    const own = await ctx.repos.featureFlags.overrideFor(flag, ctx.userId);
    if (own !== null) return own;
  }
  return instanceValue(flag, ctx.repos);
}

/** Every flag for one person (or for nobody, the instance values). */
export async function featuresFor(ctx: FlagContext): Promise<FeatureFlags> {
  const values = await Promise.all(FEATURE_FLAG_KEYS.map((flag) => isEnabled(flag, ctx)));
  return Object.fromEntries(FEATURE_FLAG_KEYS.map((flag, i) => [flag, values[i]])) as FeatureFlags;
}

/** The person a request acts for: the signed-in user (web), else the device's owner (mobile API). */
function requestUserId(request: FastifyRequest): string | null {
  return request.user?.id ?? request.scope?.user.id ?? null;
}

/**
 * `preHandler` for every route of a gated feature (billing, plans, checkout): while the flag is off for
 * this person the route answers exactly like a route that does not exist, so nothing gives it away.
 */
export function requireFeature(flag: FeatureFlag, repos: FlagContext['repos']) {
  return async (request: FastifyRequest) => {
    if (await isEnabled(flag, { repos, userId: requestUserId(request) })) return;
    throw new HttpError(404, tk('Rota não encontrada'), 'NOT_FOUND');
  };
}

/**
 * `preHandler` for a payment provider's webhook, which has no signed-in person: inert (200, nothing
 * read or written, so the provider does not retry) unless the flag is on for the instance or for at
 * least one tester. Once the handler knows whose event it is, it still checks `isEnabled` for that
 * person and drops the event when off.
 */
export function webhookGate(flag: FeatureFlag, repos: FlagContext['repos']) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if ((await instanceValue(flag, repos)) || (await repos.featureFlags.anyOverrideOn(flag))) return;
    request.log.info({ flag }, 'feature flag off: webhook ignored');
    return reply.code(200).send({ ok: true, ignored: true });
  };
}
