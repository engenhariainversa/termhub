import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { FeatureFlagOverride, Repositories } from '../db/repositories/index.js';
import type { SecurityEventInput } from '../db/repositories/security-events.js';
import { applyErrorHandler } from '../lib/errors.js';
import { featureFlagRoutes, publicFeatureRoutes } from './feature-flags.js';

/** Routes over in-memory flags, with the admin signed in and the security trail captured. */
function buildApp() {
  const instance = new Map<string, boolean>();
  const overrides = new Map<string, FeatureFlagOverride>();
  const recorded: SecurityEventInput[] = [];
  const people = [{ id: 'u2', email: 'tester@gmail.com', name: 'Tester' }];
  const repos = {
    users: { findByEmail: async (email: string) => people.find((p) => p.email === email) },
    securityEvents: { record: async (e: SecurityEventInput) => void recorded.push(e) },
    featureFlags: {
      list: async () => [...instance].map(([key, enabled]) => ({ key, enabled, updated_at: '2026-10-07T12:00:00.000Z', updated_by: 'admin' })),
      instanceValue: async (key: string) => instance.get(key) ?? null,
      overrideFor: async (key: string, userId: string) => overrides.get(`${key}:${userId}`)?.enabled ?? null,
      anyOverrideOn: async () => [...overrides.values()].some((o) => o.enabled),
      listOverrides: async (key: string) => [...overrides.values()].filter((o) => o.flag === key),
      setInstance: async (key: string, enabled: boolean) => void instance.set(key, enabled),
      setOverride: async (key: string, userId: string, enabled: boolean) => {
        const p = people.find((x) => x.id === userId)!;
        overrides.set(`${key}:${userId}`, { flag: key, user_id: userId, email: p.email, name: p.name, enabled, created_at: '2026-10-07T12:00:00.000Z' });
      },
      removeOverride: async (key: string, userId: string) => overrides.delete(`${key}:${userId}`),
    },
  } as unknown as Repositories;
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'admin', email: 'admin@gmail.com' } as never;
  });
  app.register((a) => featureFlagRoutes(a, repos), { prefix: '/feature-flags' });
  app.register((a) => publicFeatureRoutes(a, repos), { prefix: '/public' });
  return { app, recorded };
}

describe('feature flag admin routes', () => {
  it('lists subscriptions off by default, with nobody testing it', async () => {
    const { app } = buildApp();
    const r = await app.inject({ url: '/feature-flags' });
    expect(r.statusCode).toBe(200);
    expect(r.json().flags).toEqual([{ key: 'subscriptions', default: false, enabled: false, updated_at: null, overrides: [] }]);
  });

  it('turns the flag on for the instance and audits it', async () => {
    const { app, recorded } = buildApp();
    const r = await app.inject({ method: 'PUT', url: '/feature-flags/subscriptions', payload: { enabled: true } });
    expect(r.json()).toEqual({ key: 'subscriptions', enabled: true });
    expect((await app.inject({ url: '/feature-flags' })).json().flags[0].enabled).toBe(true);
    expect((await app.inject({ url: '/public/features' })).json()).toEqual({ features: { subscriptions: true } });
    expect(recorded).toEqual([expect.objectContaining({ action: 'feature_flag.update', target_id: 'subscriptions', meta: { enabled: true } })]);
  });

  it('turns it on for one tester by e-mail, and back to the instance value', async () => {
    const { app, recorded } = buildApp();
    const r = await app.inject({ method: 'PUT', url: '/feature-flags/subscriptions/overrides', payload: { email: 'Tester@Gmail.com', enabled: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json().overrides).toEqual([expect.objectContaining({ user_id: 'u2', enabled: true })]);
    // the instance (and so the landing) stays off
    expect((await app.inject({ url: '/public/features' })).json()).toEqual({ features: { subscriptions: false } });
    expect((await app.inject({ method: 'DELETE', url: '/feature-flags/subscriptions/overrides/u2' })).statusCode).toBe(204);
    expect((await app.inject({ url: '/feature-flags' })).json().flags[0].overrides).toEqual([]);
    expect(recorded.map((e) => e.action)).toEqual(['feature_flag.override', 'feature_flag.override']);
  });

  it('refuses an unknown flag, an unknown person and a malformed body', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'PUT', url: '/feature-flags/nope', payload: { enabled: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/feature-flags/subscriptions/overrides', payload: { email: 'ghost@gmail.com', enabled: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/feature-flags/subscriptions', payload: { enabled: 'yes' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/feature-flags/subscriptions/overrides/u2' })).statusCode).toBe(404);
  });
});
