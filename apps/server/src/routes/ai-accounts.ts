import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { forgetAccountUsage, getAccountUsage } from '../ai/index.js';
import { aiLogin } from '../ai/login.js';
import { setAccountExclusive } from '../control/account-exclusive.js';
import { ControlError, controlContextForRequest } from '../control/context.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
/** TER-990: the only project the account may run in; null clears it. */
const exclusiveBody = z.object({ exclusive_project_id: z.string().min(1).max(64).nullable().optional() });
const usageQuery = z.object({ refresh: z.coerce.boolean().optional() });

const accountBody = z.object({
  provider: z.enum(['claude', 'chatgpt', 'gemini', 'antigravity']),
  label: z.string().trim().min(1).max(60),
  machine_id: z.string().min(1).max(64),
  config_dir: z.string().trim().max(512).nullable().optional(),
});

export async function aiAccountRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/', async (request) => ({ accounts: await repos.aiAccounts.list(request.scope.ownerId) }));

  app.post('/', async (request, reply) => {
    const body = accountBody.parse(request.body);
    await scoped(repos, request).machine(body.machine_id).catch(() => {
      throw badRequest('Machine does not exist');
    });
    const account = await repos.aiAccounts.create({ ...body, config_dir: body.config_dir || null });
    return reply.code(201).send({ account });
  });

  app.patch('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const s = scoped(repos, request);
    await s.aiAccount(id);
    const patch = accountBody.omit({ provider: true }).partial().parse(request.body);
    const { exclusive_project_id } = exclusiveBody.parse(request.body);
    if (patch.machine_id) {
      await s.machine(patch.machine_id).catch(() => {
        throw badRequest('Machine does not exist');
      });
    }
    if (exclusive_project_id !== undefined) {
      const ctx = { ...controlContextForRequest(repos, request), log: request.log };
      await setAccountExclusive(ctx, { account_id: id, project_id: exclusive_project_id }, 'web').catch((e: unknown) => {
        if (!(e instanceof ControlError)) throw e;
        throw e.code === 'NOT_FOUND' ? notFound(e.localized) : e.code === 'FORBIDDEN' ? forbidden(e.localized) : conflict(e.localized);
      });
    }
    forgetAccountUsage(id);
    // Another machine or config dir is another login: its state is checked again, an open flow ends.
    if (patch.machine_id !== undefined || patch.config_dir !== undefined) aiLogin.forget(id);
    return { account: await repos.aiAccounts.update(id, { ...patch, config_dir: patch.config_dir === undefined ? undefined : patch.config_dir || null }) };
  });

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).aiAccount(id);
    await repos.aiAccounts.delete(id);
    forgetAccountUsage(id);
    aiLogin.forget(id);
    return { ok: true };
  });

  /** Usage of every account (cached 60 s; ?refresh=1 forces a new read). Accounts are queried in parallel. */
  app.get('/usage', async (request) => {
    const { refresh } = usageQuery.parse(request.query);
    const [accounts, machines] = await Promise.all([repos.aiAccounts.list(request.scope.ownerId), repos.machines.list(request.scope.ownerId)]);
    const byId = new Map(machines.map((m) => [m.id, m]));
    const usage = await Promise.all(accounts.map((a) => getAccountUsage(a, byId.get(a.machine_id), !!refresh)));
    return { usage };
  });

  app.get('/:id/usage', async (request) => {
    const { id } = idParam.parse(request.params);
    const { refresh } = usageQuery.parse(request.query);
    const { account, machine } = await scoped(repos, request).aiAccount(id);
    return { usage: await getAccountUsage(account, machine, !!refresh) };
  });
}
