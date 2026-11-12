import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { CATALOGS } from '../i18n/catalog.js';
import { applyErrorHandler } from '../lib/errors.js';
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS, featuresFor, isEnabled, requireFeature, webhookGate } from './flags.js';

/** An in-memory `featureFlags` repository: instance values and per-user overrides. */
function fakeFlags(instance: Record<string, boolean> = {}, overrides: Record<string, Record<string, boolean>> = {}) {
  return {
    featureFlags: {
      instanceValue: async (key: string) => instance[key] ?? null,
      overrideFor: async (key: string, userId: string) => overrides[key]?.[userId] ?? null,
      anyOverrideOn: async (key: string) => Object.values(overrides[key] ?? {}).some(Boolean),
    },
  } as unknown as Pick<Repositories, 'featureFlags'>;
}

describe('FEATURE_FLAGS catalog (TER-1187)', () => {
  it.each(FEATURE_FLAG_KEYS)('%s has a title, a description and its card, in pt-BR, English and Spanish', (key) => {
    const flag: { title: string; description: string; card: string } = FEATURE_FLAGS[key];
    expect(flag.title.trim()).not.toBe('');
    expect(flag.title).not.toBe(key);
    expect(flag.description.trim().length).toBeGreaterThan(flag.title.length);
    expect(flag.card).toMatch(/^TER-\d+$/);
    for (const locale of ['en', 'es'] as const) {
      expect(CATALOGS[locale][flag.title], `${locale}: ${flag.title}`).toBeTruthy();
      expect(CATALOGS[locale][flag.description], `${locale}: ${flag.description}`).toBeTruthy();
    }
  });
});

describe('isEnabled', () => {
  it('is off by default: subscriptions ships dark', async () => {
    expect(FEATURE_FLAGS.subscriptions.default).toBe(false);
    expect(FEATURE_FLAGS.chat_open_permissions.default).toBe(false);
    expect(FEATURE_FLAGS.sequential_epics.default).toBe(false);
    expect(await isEnabled('subscriptions', { repos: fakeFlags() })).toBe(false);
    expect(await isEnabled('subscriptions', { repos: fakeFlags(), userId: 'u1' })).toBe(false);
  });

  it('follows the instance value the admin set', async () => {
    expect(await isEnabled('subscriptions', { repos: fakeFlags({ subscriptions: true }), userId: 'u1' })).toBe(true);
  });

  it("a person's own override wins over the instance, both ways", async () => {
    const on = fakeFlags({}, { subscriptions: { tester: true } });
    expect(await isEnabled('subscriptions', { repos: on, userId: 'tester' })).toBe(true);
    expect(await isEnabled('subscriptions', { repos: on, userId: 'someone' })).toBe(false);
    expect(await isEnabled('subscriptions', { repos: on })).toBe(false);
    const off = fakeFlags({ subscriptions: true }, { subscriptions: { holdout: false } });
    expect(await isEnabled('subscriptions', { repos: off, userId: 'holdout' })).toBe(false);
  });

  it('featuresFor resolves every flag', async () => {
    expect(await featuresFor({ repos: fakeFlags(), userId: 'u1' })).toEqual({ subscriptions: false, chat_open_permissions: false, tab_gc: false, tab_gc_live: false, sequential_epics: false, runs_api: false });
    expect(await featuresFor({ repos: fakeFlags({}, { subscriptions: { u1: true } }), userId: 'u1' })).toEqual({ subscriptions: true, chat_open_permissions: false, tab_gc: false, tab_gc_live: false, sequential_epics: false, runs_api: false });
  });
});

function gatedApp(repos: Pick<Repositories, 'featureFlags'>, userId: string | null) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = userId ? ({ id: userId } as never) : null;
  });
  app.get('/billing/plans', { preHandler: requireFeature('subscriptions', repos) }, async () => ({ plans: [] }));
  app.post('/billing/webhook', { preHandler: webhookGate('subscriptions', repos) }, async () => ({ ok: true, handled: true }));
  return app;
}

describe('requireFeature', () => {
  it('answers like a missing route while the flag is off', async () => {
    const r = await gatedApp(fakeFlags(), 'u1').inject({ url: '/billing/plans' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets the request through for a tester with the flag on', async () => {
    const repos = fakeFlags({}, { subscriptions: { tester: true } });
    expect((await gatedApp(repos, 'tester').inject({ url: '/billing/plans' })).statusCode).toBe(200);
    expect((await gatedApp(repos, 'other').inject({ url: '/billing/plans' })).statusCode).toBe(404);
  });

  it('lets everyone through once the instance has it on', async () => {
    expect((await gatedApp(fakeFlags({ subscriptions: true }), 'u1').inject({ url: '/billing/plans' })).statusCode).toBe(200);
  });
});

describe('webhookGate', () => {
  it('is inert while nobody has the flag: 200, the handler never runs', async () => {
    const r = await gatedApp(fakeFlags(), null).inject({ method: 'POST', url: '/billing/webhook', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, ignored: true });
  });

  it('reaches the handler when a tester has the flag on', async () => {
    const r = await gatedApp(fakeFlags({}, { subscriptions: { tester: true } }), null).inject({ method: 'POST', url: '/billing/webhook', payload: {} });
    expect(r.json()).toEqual({ ok: true, handled: true });
  });

  it('reaches the handler when the instance has it on', async () => {
    const r = await gatedApp(fakeFlags({ subscriptions: true }), null).inject({ method: 'POST', url: '/billing/webhook', payload: {} });
    expect(r.json()).toEqual({ ok: true, handled: true });
  });
});
