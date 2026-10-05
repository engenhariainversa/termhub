import type { FastifyInstance } from 'fastify';
import { dispatchTriggers } from '../automation/events.js';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { scoped } from '../auth/scope.js';
import { controlContextForRequest } from '../control/context.js';
import { syncTickets } from '../control/tickets.js';
import { setupInputSchema, sourceIdentity, withSourcesFromLegacy } from '../setup/schema.js';
import { forgetSync } from '../setup/tickets-sync.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** Montado em /projects: setup do projeto e sync de tickets. */
export async function setupRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    return { setup: await repos.projectSetup.get(id) };
  });

  app.put('/:id/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const parsed = setupInputSchema.safeParse(request.body);
    if (!parsed.success) {
      if (parsed.error.issues.some((i) => i.message === 'Fonte de tickets repetida')) throw new HttpError(400, 'Fonte de tickets repetida', 'DUPLICATE_SOURCE');
      throw parsed.error;
    }
    // A setup form left open in the web app from before the deploy sends `tickets` only: keep that source.
    const data = withSourcesFromLegacy(request.body, parsed.data);
    const s = scoped(repos, request);
    const exists = (p: Promise<unknown>) => p.then(() => true, () => false);
    for (const source of data.ticket_sources) {
      if (!(await exists(s.integration(source.integration_id)))) throw badRequest('Integração de tickets inexistente');
    }
    if (data.repo?.integration_id && !(await exists(s.integration(data.repo.integration_id)))) throw badRequest('Integração do repositório inexistente');
    if (data.runner.machine_id && !(await exists(s.machine(data.runner.machine_id)))) throw badRequest('Máquina do runner inexistente');
    const stored = (await repos.projectSetup.get(id)).data;
    const before = stored.ticket_sources;
    // The ai block has its own endpoint (TER-589): a form loaded before it, or before the phone's edit, keeps it.
    if (stored.ai) data.ai = stored.ai;
    // An older client (the phone app, a form loaded before the deploy) omits the block: its zod default
    // would reset the stored one, so keep it. A client that sends the block is the one that edits it.
    const sentAutomation = typeof request.body === 'object' && request.body !== null && 'automation' in request.body;
    if (stored.automation && !sentAutomation) data.automation = stored.automation;
    const kept = new Set(data.ticket_sources.map(sourceIdentity));
    const saved = await repos.projectSetup.save(id, data);
    for (const gone of before.filter((b) => !kept.has(sourceIdentity(b)))) {
      await repos.tickets.pruneSource(id, { integration_id: gone.integration_id, scope: gone.scope });
    }
    // the sources may have changed: "Sincronizar agora" right after saving must not answer the cached result
    forgetSync(id);
    if (saved.data.automation.enabled) dispatchTriggers.poke('setup_saved');
    return { setup: saved };
  });

  app.post('/:id/tickets/sync', { config: { resource: 'tickets', action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const result = await syncTickets(controlContextForRequest(repos, request), { project_id: id });
    const failed = result.sources.filter((x) => x.error);
    if (result.sources.length > 0 && failed.length === result.sources.length) throw new HttpError(502, failed[0].error!, 'PROVIDER_ERROR');
    return { ok: true, ...result };
  });
}
