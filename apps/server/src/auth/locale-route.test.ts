import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { authRoutes } from './routes.js';

const setLocale = vi.fn();
const setTimeZone = vi.fn();
const conciergePush = vi.fn();
const setConciergePush = vi.fn();
const findById = vi.fn();
const LEGAL = { pending: [{ id: 'v1', document: 'terms', version: '1', effective_at: '2026-10-01T00:00:00.000Z', url: 'https://termhub.dev/termos/', requires_acceptance: true, summary: null }], upcoming: [] };
const statusFor = vi.fn(async () => LEGAL);

function buildApp(user: Record<string, unknown> | null) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    if (user) request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
  });
  const repos = { users: { setLocale, setTimeZone, conciergePush, setConciergePush }, roles: { findById }, featureFlags: { instanceValue: vi.fn(async () => null), overrideFor: vi.fn(async () => null) }, legal: { statusFor } } as unknown as Repositories;
  app.register((a) => authRoutes(a, { repos } as never), { prefix: '/auth' });
  return app;
}

const user = { id: 'u1', email: 'a@b.c', name: 'A', role_id: null, locale: null, password_hash: null, google_id: null };
const patch = (app: ReturnType<typeof buildApp>, payload: unknown) => app.inject({ method: 'PATCH', url: '/auth/me/locale', payload: payload as never });

describe('PATCH /auth/me/locale', () => {
  beforeEach(() => setLocale.mockReset().mockResolvedValue(undefined));

  it('stores en, es, pt-BR or null (automatic) and answers 204', async () => {
    for (const locale of ['en', 'es', 'pt-BR', null]) {
      const res = await patch(buildApp(user), { locale });
      expect(res.statusCode).toBe(204);
      expect(setLocale).toHaveBeenLastCalledWith('u1', locale);
    }
  });

  it('refuses any other value', async () => {
    for (const locale of ['fr', 'es-AR', 'EN', '', 3]) {
      const res = await patch(buildApp(user), { locale });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION');
    }
    expect((await patch(buildApp(user), {})).statusCode).toBe(400);
    expect(setLocale).not.toHaveBeenCalled();
  });

  it('needs a signed-in user', async () => {
    const res = await patch(buildApp(null), { locale: 'en' });
    expect(res.statusCode).toBe(401);
    expect(setLocale).not.toHaveBeenCalled();
  });
});

describe('GET /auth/me', () => {
  it('returns the stored locale on the user', async () => {
    const res = await buildApp({ ...user, locale: 'en' }).inject({ url: '/auth/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.locale).toBe('en');
  });

  it('carries the legal acceptance status of the signed-in person (TER-742)', async () => {
    const res = await buildApp(user).inject({ url: '/auth/me' });
    expect(res.json().legal).toEqual(LEGAL);
    expect(statusFor).toHaveBeenCalledWith('u1');
  });

  it('carries the feature flags resolved for this person, off by default (TER-1040)', async () => {
    const res = await buildApp(user).inject({ url: '/auth/me' });
    expect(res.json().user.features).toEqual({ subscriptions: false });
  });
});

describe('PATCH /auth/me/time-zone', () => {
  beforeEach(() => setTimeZone.mockReset().mockResolvedValue(undefined));
  const send = (app: ReturnType<typeof buildApp>, payload: unknown) => app.inject({ method: 'PATCH', url: '/auth/me/time-zone', payload: payload as never });

  it('stores an IANA zone and answers 204', async () => {
    expect((await send(buildApp(user), { time_zone: 'America/Sao_Paulo' })).statusCode).toBe(204);
    expect(setTimeZone).toHaveBeenCalledWith('u1', 'America/Sao_Paulo');
  });

  it('refuses unknown zones and other shapes', async () => {
    for (const payload of [{ time_zone: 'Not/AZone' }, { time_zone: '' }, { time_zone: 3 }, {}]) {
      expect((await send(buildApp(user), payload)).statusCode).toBe(400);
    }
    expect(setTimeZone).not.toHaveBeenCalled();
  });

  it('needs a signed-in user', async () => {
    expect((await send(buildApp(null), { time_zone: 'UTC' })).statusCode).toBe(401);
  });
});

describe('/auth/me/concierge-push (TER-1101)', () => {
  const rules = { needs_you: true, done: true, quiet_start: null, quiet_end: null, group_minutes: 5 };
  beforeEach(() => {
    setTimeZone.mockReset().mockResolvedValue(undefined);
    setConciergePush.mockReset().mockResolvedValue(undefined);
    conciergePush.mockReset().mockResolvedValue(rules);
  });
  const put = (app: ReturnType<typeof buildApp>, payload: unknown) => app.inject({ method: 'PUT', url: '/auth/me/concierge-push', payload: payload as never });

  it('reads and saves the person\'s rules; quiet hours keep the browser\'s zone', async () => {
    expect((await buildApp(user).inject({ url: '/auth/me/concierge-push' })).json()).toEqual({ concierge: rules });
    const next = { ...rules, done: false, quiet_start: '22:00', quiet_end: '07:00' };
    const res = await put(buildApp(user), { concierge: next, time_zone: 'America/Sao_Paulo' });
    expect(res.statusCode).toBe(200);
    expect(setConciergePush).toHaveBeenCalledWith('u1', next);
    expect(setTimeZone).toHaveBeenCalledWith('u1', 'America/Sao_Paulo');
  });

  it('refuses half a quiet window or a group over an hour; needs a signed-in user', async () => {
    expect((await put(buildApp(user), { concierge: { ...rules, quiet_start: '22:00' } })).statusCode).toBe(400);
    expect((await put(buildApp(user), { concierge: { ...rules, group_minutes: 61 } })).statusCode).toBe(400);
    expect((await put(buildApp(null), { concierge: rules })).statusCode).toBe(401);
    expect(setConciergePush).not.toHaveBeenCalled();
  });
});
