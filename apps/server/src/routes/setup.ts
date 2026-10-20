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
import { recordSetupChange } from '../automation/setup-tools.js';
import { nudgeAiMemoryRules } from '../memory/ai-memory-sync.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/** Montado em /projects: setup do projeto e sync de tickets. */
export async function setupRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const setup = await repos.projectSetup.get(id);
    return { setup, effective_repos: await repos.projectRepositories.effective(id, setup.data) };
  });

  app.put('/:id/setup', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const stored = (await repos.projectSetup.get(id)).data;
    const sent = (key: string) => typeof request.body === 'object' && request.body !== null && key in request.body;
    // Overrides are checked against the project's level; with no automation block in the body, that is the stored one.
    const input = sent('repos') && !sent('automation') && stored.automation ? { ...(request.body as object), automation: stored.automation } : request.body;
    const parsed = setupInputSchema.safeParse(input);
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
    for (const integrationId of new Set([data.repo?.integration_id, data.repo_defaults.integration_id, ...data.repos.map((r) => r.integration_id)])) {
      if (integrationId && !(await exists(s.integration(integrationId)))) throw badRequest('Integração do repositório inexistente');
    }
    if (data.runner.machine_id && !(await exists(s.machine(data.runner.machine_id)))) throw badRequest('Máquina do runner inexistente');
    const before = stored.ticket_sources;
    // The ai block has its own endpoint (TER-589): a form loaded before it, or before the phone's edit, keeps it.
    if (stored.ai) data.ai = stored.ai;
    // An older client (the phone app, a form loaded before the deploy) omits the block: its zod default
    // would reset the stored one, so keep it. A client that sends the block is the one that edits it.
    if (stored.automation && !sent('automation')) data.automation = stored.automation;
    // The same for the per-repo overrides (spec 2026-10-07 multi-repo R1): a client that does not know them must not wipe them.
    if (stored.repos && !sent('repos')) data.repos = stored.repos;
    if (stored.repo_defaults && !sent('repo_defaults')) data.repo_defaults = stored.repo_defaults;
    // Same for ai_memory (TER-1019): a client from before it would turn the option off by leaving it out.
    if (stored.ai_memory && !sent('ai_memory')) data.ai_memory = stored.ai_memory;
    const kept = new Set(data.ticket_sources.map(sourceIdentity));
    const saved = await repos.projectSetup.save(id, data);
    if (stored.automation) await recordSetupChange(repos, id, stored.automation, saved.data.automation, 'web');
    for (const gone of before.filter((b) => !kept.has(sourceIdentity(b)))) {
      await repos.tickets.pruneSource(id, { integration_id: gone.integration_id, scope: gone.scope });
    }
    // the sources may have changed: "Sincronizar agora" right after saving must not answer the cached result
    forgetSync(id);
    if (saved.data.automation.enabled) dispatchTriggers.poke('setup_saved');
    // Publishes (or, turned off, removes) the rule pages in the background; `fresh` retries checkouts
    // that had no ai-memory, since the person may just have set it up.
    if (saved.data.ai_memory?.publish_rules || stored.ai_memory?.publish_rules) nudgeAiMemoryRules(repos, id, request.log, { fresh: true });
    return { setup: saved, effective_repos: await repos.projectRepositories.effective(id, saved.data) };
  });

  app.post('/:id/tickets/sync', { config: { resource: 'tickets', action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const result = await syncTickets(controlContextForRequest(repos, request), { project_id: id });
    const failed = result.sources.filter((x) => x.error);
    if (result.sources.length > 0 && failed.length === result.sources.length) throw new HttpError(502, failed[0].error!, 'PROVIDER_ERROR');
    return { ok: true, ...result };
  });
}
