import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';
import { invalidatePermissionCache } from './permissions.js';
import { authRoutes } from './routes.js';
import { VIEW_AS_COOKIE } from './scope.js';

const start = vi.fn();
const end = vi.fn();
const findUser = vi.fn();
const destroySession = vi.fn();

const admin = { id: 'adm', email: 'adm@x', name: 'Adm', role_id: 'role-admin', avatar_url: null };
const member = { id: 'mem', email: 'mem@x', name: 'Mem', role_id: 'role-member', avatar_url: null };
const bob = { id: 'bob', email: 'bob@x', name: 'Bob', role_id: 'role-member', avatar_url: null };

function buildApp(user: typeof admin) {
  const app = Fastify();
  void app.register(cookie);
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.user = user as never;
    request.scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id } as never;
  });
  const repos = {
    users: { findById: findUser },
    roles: { findById: async (id: string) => ({ id, is_admin: id === 'role-admin' }), permissionsOf: async () => [] },
    viewAsAudit: { start, end },
  } as unknown as Repositories;
  app.register((a) => authRoutes(a, { repos, service: { destroySession } } as never), { prefix: '/auth' });
  return app;
}

const viewAs = (app: ReturnType<typeof buildApp>, user_id: string | null) => app.inject({ method: 'POST', url: '/auth/view-as', payload: { user_id } });
const cookieOf = (res: Awaited<ReturnType<typeof viewAs>>) => res.cookies.find((c) => c.name === VIEW_AS_COOKIE);

describe('POST /auth/view-as audit (TER-746)', () => {
  beforeEach(() => {
    invalidatePermissionCache();
    start.mockReset().mockResolvedValue({});
    end.mockReset().mockResolvedValue(1);
    findUser.mockReset().mockImplementation(async (id: string) => (id === 'bob' ? bob : null));
    destroySession.mockReset().mockResolvedValue(undefined);
  });

  it('records the admin, the target user and the IP before switching', async () => {
    const res = await viewAs(buildApp(admin), 'bob');
    expect(res.statusCode).toBe(200);
    expect(start).toHaveBeenCalledWith({ admin_id: 'adm', scope: 'user', target_user_id: 'bob', ip: '127.0.0.1' });
    expect(cookieOf(res)?.value).toBe('bob');
  });

  it('records a switch to "all"', async () => {
    const res = await viewAs(buildApp(admin), '*');
    expect(res.json()).toEqual({ view_as: 'all' });
    expect(start).toHaveBeenCalledWith({ admin_id: 'adm', scope: 'all', ip: '127.0.0.1' });
  });

  it('does not switch when the record cannot be written', async () => {
    start.mockRejectedValue(new Error('db down'));
    const res = await viewAs(buildApp(admin), 'bob');
    expect(res.statusCode).toBe(500);
    expect(cookieOf(res)).toBeUndefined();
  });

  it('ends the period when the admin goes back to their own scope, even if the write fails', async () => {
    end.mockRejectedValue(new Error('db down'));
    for (const target of [null, 'adm']) {
      const res = await viewAs(buildApp(admin), target);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ view_as: null });
    }
    expect(end).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledWith('adm');
    expect(start).not.toHaveBeenCalled();
  });

  it('records nothing for an unknown user or a non-admin', async () => {
    expect((await viewAs(buildApp(admin), 'ghost')).statusCode).toBe(400);
    expect((await viewAs(buildApp(member), 'bob')).statusCode).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it('ends the period on sign-out while viewing as someone', async () => {
    const app = buildApp(admin);
    await app.inject({ method: 'POST', url: '/auth/logout', cookies: { [VIEW_AS_COOKIE]: 'bob' } });
    expect(end).toHaveBeenCalledWith('adm');
    end.mockClear();
    await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(end).not.toHaveBeenCalled();
  });
});
