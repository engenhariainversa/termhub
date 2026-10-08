import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { authRoutes } from './routes.js';

const setNickname = vi.fn();

function buildApp(user: { id: string; nickname: string | null }) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
  });
  const repos = { users: { setNickname, findByNickname: vi.fn(async () => undefined) }, featureFlags: { instanceValue: vi.fn(async () => null), overrideFor: vi.fn(async () => null) } } as unknown as Repositories;
  app.register((a) => authRoutes(a, { repos } as never), { prefix: '/auth' });
  return app;
}

const patch = (app: ReturnType<typeof buildApp>, nickname: unknown) => app.inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname } });

describe('PATCH /auth/me/nickname', () => {
  beforeEach(() => setNickname.mockReset().mockResolvedValue('ok'));

  it('claims a nickname, lowercased', async () => {
    const res = await patch(buildApp({ id: 'u1', nickname: null }), 'Pedro');
    expect(res.statusCode).toBe(200);
    expect(setNickname).toHaveBeenCalledWith('u1', 'pedro');
    expect(res.json().user.nickname).toBe('pedro');
  });

  it('refuses a reserved word and a bad shape without touching the database', async () => {
    for (const bad of ['city', 'ab', 'pe dro', 'pedro!']) {
      expect((await patch(buildApp({ id: 'u1', nickname: null }), bad)).statusCode).toBe(400);
    }
    expect(setNickname).not.toHaveBeenCalled();
  });

  it('answers 409 when another account already holds it', async () => {
    setNickname.mockResolvedValue('taken');
    const res = await patch(buildApp({ id: 'u2', nickname: null }), 'pedro');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_TAKEN');
  });

  // A shared /city/@nick link must keep pointing at the same person: once claimed, the address is
  // never released, so nobody else can pick it up and inherit every link already out there.
  it('refuses to change a nickname that is already set, without touching the database', async () => {
    const res = await patch(buildApp({ id: 'u1', nickname: 'alice' }), 'alice2');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_LOCKED');
    expect(setNickname).not.toHaveBeenCalled();
  });

  it('answers 409 NICKNAME_LOCKED when the write finds the nickname already set (a concurrent claim)', async () => {
    setNickname.mockResolvedValue('locked');
    const res = await patch(buildApp({ id: 'u1', nickname: null }), 'pedro');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NICKNAME_LOCKED');
  });

  it('refuses a body that is not an object at all, without touching the database', async () => {
    const app = buildApp({ id: 'u1', nickname: null });
    const res = await app.inject({ method: 'PATCH', url: '/auth/me/nickname', payload: '"not-an-object"', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    expect(setNickname).not.toHaveBeenCalled();
  });

  // The app builds share links from this, never from a hardcoded host: on a self-hosted instance a
  // termhub.dev link would point at somebody else's city.
  it('GET /auth/config tells the app where public cities live', async () => {
    const { config } = await import('../config.js');
    const res = await buildApp({ id: 'u1', nickname: null }).inject({ method: 'GET', url: '/auth/config' });
    expect(res.json().public_city_url).toBe(config.publicCityUrl);
    expect(res.json().public_city_url).toMatch(/^https?:\/\/[^/]+\/city$/);
  });
});

describe('PATCH /auth/me/nickname and the short link', () => {
  function buildWithHook(user: { id: string; nickname: string | null }, onNicknameClaimed: (u: unknown) => void) {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = user as never;
      request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
    });
    const repos = { users: { setNickname, findByNickname: vi.fn(async () => undefined) }, featureFlags: { instanceValue: vi.fn(async () => null), overrideFor: vi.fn(async () => null) } } as unknown as Repositories;
    app.register((a) => authRoutes(a, { repos } as never, { onNicknameClaimed }), { prefix: '/auth' });
    return app;
  }

  beforeEach(() => setNickname.mockReset().mockResolvedValue('ok'));

  it('asks for the partner link once, after the first claim is written', async () => {
    const onNicknameClaimed = vi.fn();
    const res = await buildWithHook({ id: 'u1', nickname: null }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'Pedro' } });
    expect(res.statusCode).toBe(200);
    expect(onNicknameClaimed).toHaveBeenCalledTimes(1);
    expect(onNicknameClaimed.mock.calls[0][0]).toMatchObject({ id: 'u1', nickname: 'pedro' });
    expect(setNickname.mock.invocationCallOrder[0]).toBeLessThan(onNicknameClaimed.mock.invocationCallOrder[0]);
  });

  it('does not ask on a re-sent nickname, on a refusal, or on a lost race', async () => {
    const onNicknameClaimed = vi.fn();
    await buildWithHook({ id: 'u1', nickname: 'pedro' }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'pedro' } });
    await buildWithHook({ id: 'u1', nickname: null }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'city' } });
    setNickname.mockResolvedValue('taken');
    await buildWithHook({ id: 'u1', nickname: null }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'pedro' } });
    setNickname.mockResolvedValue('locked');
    await buildWithHook({ id: 'u1', nickname: null }, onNicknameClaimed).inject({ method: 'PATCH', url: '/auth/me/nickname', payload: { nickname: 'pedro' } });
    expect(onNicknameClaimed).not.toHaveBeenCalled();
  });
});
