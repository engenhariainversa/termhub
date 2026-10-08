import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';

export interface MonitorItem {
  tab: Tab;
  project: Project;
  machine: Machine;
}

/** Monitor: the scope's tabs with their project and machine, both of the scope's owner. */
export async function monitorRoutes(app: FastifyInstance, repos: Repositories) {
  async function itemsOf(owner: string | null, tabsQuery: Promise<Tab[]>): Promise<MonitorItem[]> {
    const [tabs, projects, machines] = await Promise.all([tabsQuery, repos.projects.list({ owner }), repos.machines.list(owner)]);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const machineById = new Map(machines.map((m) => [m.id, m]));
    const items: MonitorItem[] = [];
    for (const tab of tabs) {
      const project = projectById.get(tab.project_id);
      const machine = machineById.get(tab.machine_id);
      if (project && machine) items.push({ tab, project, machine });
    }
    return items;
  }

  /** Every tab whose tool reported a state, newest change first. */
  app.get('/tabs', async (request) => {
    const owner = request.scope.ownerId;
    return { items: await itemsOf(owner, repos.tabs.listWithState(owner)) };
  });

  /**
   * Every open terminal tab, reported a state or not, in tab-bar order: the sidebar's running
   * agents. Kept live by the monitor WS (`tab_upsert` / `tab_removed`).
   */
  app.get('/open-tabs', async (request) => {
    const owner = request.scope.ownerId;
    return { items: await itemsOf(owner, repos.tabs.listOpenTerminals(owner)) };
  });

  /**
   * The tabs an automatic run is working in, with the card's ref: the status dots mark them (TER-1044).
   * Re-read by the browser on the `automation` frames of the monitor WS (a run started or ended).
   */
  app.get('/auto-runs', async (request) => {
    return { items: await repos.automationRuns.activeTabRefs(request.scope.ownerId) };
  });
}
