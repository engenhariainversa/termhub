import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { scoped } from '../auth/scope.js';
import { linkTabTask } from '../control/agents.js';
import { ControlError, controlContextForRequest } from '../control/context.js';
import { importTickets, pushTicketStatus } from '../control/tickets.js';
import { readTicketLink } from '../integrations/ticket-link.js';
import { conflict, forbidden } from '../lib/errors.js';
import { publishTabOpened } from '../monitor/tab-events.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const importBody = z.object({ ticket_ids: z.array(z.string().min(1).max(64)).min(1).max(200) });
const terminalBody = z.object({ machine_id: z.string().min(1).max(64).optional() }).strict();
const linkTabBody = z.object({ tab_id: z.string().min(1).max(64) }).strict();

/** Montado em /projects: lista de tickets sincronizados e importação para o backlog. */
export async function projectTicketRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/:id/tickets', async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).project(id);
    const q = z.object({ integration_id: z.string().max(64).optional() }).parse(request.query);
    return { tickets: await repos.tickets.listByProject(id, { integration_id: q.integration_id }) };
  });

  /** Manda tickets escolhidos para o backlog (cria tasks vinculadas). */
  app.post('/:id/tickets/import', { config: { resource: 'tasks', action: 'create' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { ticket_ids } = importBody.parse(request.body);
    const { cards } = await importTickets(controlContextForRequest(repos, request), { project_id: id, ticket_ids });
    // the control operation already loaded everything through the scope (CLAUDE.md: no findById in handlers)
    return { tasks: cards.filter((c) => c.created).map((c) => c.task) };
  });
}

/** Montado em /tasks: ações que ligam a task ao ticket externo e ao terminal. */
export async function taskTicketRoutes(app: FastifyInstance, repos: Repositories) {
  /** Empurra a coluna atual da task para o provedor (ação explícita). */
  app.post('/:id/push-status', { config: { action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { task, state } = await pushTicketStatus(controlContextForRequest(repos, request), { task_id: id });
    return { task, state };
  });

  /** Abre (ou reaproveita) uma tab de terminal para a task e a vincula. */
  app.post('/:id/terminal', { config: { resource: 'terminals', action: 'create' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { task } = await scoped(repos, request).task(id);
    if (task.tab_id) {
      const existing = await repos.tabs.findById(task.tab_id);
      if (existing) return { task, tab: existing, created: false };
    }
    // Same contract as `POST /projects/:id/tabs`: with one linked machine it is used; with several,
    // `machine_id` is required (400 MACHINE_REQUIRED); with none, 400 NO_MACHINE (see `projectMachineFor`).
    const { machine_id } = terminalBody.parse(request.body ?? {});
    const { machine } = await scoped(repos, request).projectMachineFor(task.project_id, machine_id);
    const name = (readTicketLink(task.external_ref)?.key ?? task.title).slice(0, 40);
    const tab = await repos.tabs.create(task.project_id, machine.id, name);
    publishTabOpened(tab, machine);
    const updated = await repos.tasks.setTab(id, tab.id);
    return { task: updated, tab, created: true };
  });

  /**
   * Links the task to a terminal tab that is already open in its project (TER-499) — an agent someone
   * started by hand — and starts work on it, as `start_agent` does for the tab it opens.
   */
  app.post('/:id/link-tab', { config: { resource: 'tasks', action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    const { tab_id } = linkTabBody.parse(request.body);
    try {
      await linkTabTask(controlContextForRequest(repos, request), { tab_id, task_id: id });
    } catch (e) {
      if (e instanceof ControlError) throw e.code === 'FORBIDDEN' ? forbidden(e.localized) : conflict(e.localized);
      throw e;
    }
    // the board's own shape of the card (the control operation answers the tools' one)
    return { task: (await scoped(repos, request).task(id)).task };
  });

  app.delete('/:id/terminal', { config: { resource: 'tasks', action: 'update' } }, async (request) => {
    const { id } = idParam.parse(request.params);
    await scoped(repos, request).task(id);
    return { task: await repos.tasks.setTab(id, null) };
  });
}
