import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { authRoutes } from './routes.js';

const setLocale = vi.fn();
const findById = vi.fn();

function buildApp(user: Record<string, unknown> | null) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    if (user) request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
  });
  const repos = { users: { setLocale }, roles: { findById } } as unknown as Repositories;
  app.register((a) => authRoutes(a, { repos } as never), { prefix: '/auth' });
  return app;
}

const user = { id: 'u1', email: 'a@b.c', name: 'A', role_id: null, locale: null, password_hash: null, google_id: null };
const patch = (app: ReturnType<typeof buildApp>, payload: unknown) => app.inject({ method: 'PATCH', url: '/auth/me/locale', payload: payload as never });

describe('PATCH /auth/me/locale', () => {
  beforeEach(() => setLocale.mockReset().mockResolvedValue(undefined));

  it('stores en, pt-BR or null (automatic) and answers 204', async () => {
    for (const locale of ['en', 'pt-BR', null]) {
      const res = await patch(buildApp(user), { locale });
      expect(res.statusCode).toBe(204);
      expect(setLocale).toHaveBeenLastCalledWith('u1', locale);
    }
  });

  it('refuses any other value', async () => {
    for (const locale of ['es', 'EN', '', 3]) {
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
});
