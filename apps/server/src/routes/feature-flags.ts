import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { audit } from '../auth/audit.js';
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS, featuresFor, isFeatureFlag, type FeatureFlag } from '../features/flags.js';
import { notFound } from '../lib/errors.js';
import { tk } from '../i18n/index.js';

/**
 * Configurações → Recursos em teste (TER-1040): an admin turns a feature flag on or off for the whole
 * instance, and for one person at a time to test it, without a deploy. Guarded by `feature_flags`.
 */

const keyParam = z.object({ key: z.string().min(1).max(64) });
const overrideParam = keyParam.extend({ user_id: z.string().min(1).max(64) });
const enabledBody = z.object({ enabled: z.boolean() });
const overrideBody = z.object({ email: z.string().trim().toLowerCase().email().max(254), enabled: z.boolean() });

function flagOf(params: unknown): FeatureFlag {
  const { key } = keyParam.parse(params);
  if (!isFeatureFlag(key)) throw notFound(tk('Flag não encontrada'));
  return key;
}

export async function featureFlagRoutes(app: FastifyInstance, repos: Repositories) {
  /** Every flag in code, its instance value and who has their own. */
  app.get('/', async () => {
    const rows = new Map((await repos.featureFlags.list()).map((r) => [r.key, r]));
    const flags = await Promise.all(
      FEATURE_FLAG_KEYS.map(async (key) => {
        const row = rows.get(key);
        return {
          key,
          default: FEATURE_FLAGS[key].default,
          enabled: row ? row.enabled : FEATURE_FLAGS[key].default,
          updated_at: row?.updated_at ?? null,
          overrides: await repos.featureFlags.listOverrides(key),
        };
      }),
    );
    return { flags };
  });

  /** The instance-wide switch. */
  app.put('/:key', async (request) => {
    const key = flagOf(request.params);
    const { enabled } = enabledBody.parse(request.body);
    await repos.featureFlags.setInstance(key, enabled, request.user?.id ?? null);
    request.log.info({ flag: key, enabled }, 'feature flag: instance value set');
    await audit(repos, request, 'feature_flag.update', { target: { type: 'feature_flag', id: key, label: key }, meta: { enabled } });
    return { key, enabled };
  });

  /** One person's own value, found by e-mail (the screen has no user list of its own). */
  app.put('/:key/overrides', async (request) => {
    const key = flagOf(request.params);
    const { email, enabled } = overrideBody.parse(request.body);
    const user = await repos.users.findByEmail(email);
    if (!user) throw notFound(tk('Usuário não encontrado'));
    await repos.featureFlags.setOverride(key, user.id, enabled, request.user?.id ?? null);
    request.log.info({ flag: key, userId: user.id, enabled }, 'feature flag: override set');
    await audit(repos, request, 'feature_flag.override', { target: { type: 'user', id: user.id, label: user.email }, meta: { flag: key, enabled } });
    return { overrides: await repos.featureFlags.listOverrides(key) };
  });

  /** Back to the instance value for that person. */
  app.delete('/:key/overrides/:user_id', async (request, reply) => {
    const key = flagOf(request.params);
    const { user_id } = overrideParam.parse(request.params);
    if (!(await repos.featureFlags.removeOverride(key, user_id))) throw notFound(tk('Usuário não encontrado'));
    request.log.info({ flag: key, userId: user_id }, 'feature flag: override removed');
    await audit(repos, request, 'feature_flag.override', { target: { type: 'user', id: user_id }, meta: { flag: key, enabled: null } });
    return reply.code(204).send();
  });
}

/** `GET /api/public/features`: the instance values, for the landing (no session there). */
export async function publicFeatureRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/features', { config: { public: true } }, async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return { features: await featuresFor({ repos }) };
  });
}
