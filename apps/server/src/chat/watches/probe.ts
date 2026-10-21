/**
 * TER-1099: the real `WatchProbe` — the database for tabs, cards and PRs, this process's agent registry for
 * machines, and npm for agent releases (read at most every `NPM_EVERY_MS`, and only while a watch asks).
 */
import type { Repositories } from '../../db/repositories/index.js';
import { fetchLatestAgentVersion, latestAgentVersion } from '../../agent/latest-version.js';
import type { WatchProbe } from './evaluate.js';
import type { CardStatus } from './kinds.js';

export const NPM_EVERY_MS = 2 * 60_000;

export interface ProbeDeps {
  repos: Pick<Repositories, 'tabs' | 'tasks' | 'taskPullRequests' | 'machines'>;
  agents: { isOnline(machineId: string): boolean };
  fetchLatest?: () => Promise<string | null>;
  now?: () => number;
}

export function createWatchProbe(deps: ProbeDeps): WatchProbe {
  const now = deps.now ?? (() => Date.now());
  const fetchLatest = deps.fetchLatest ?? (() => fetchLatestAgentVersion());
  /** When this process first saw each machine offline (cleared once it is online): the grace counts from here. */
  const offlineSince = new Map<string, number>();
  let npm: { at: number; version: string | null } | null = null;

  return {
    async tab(id) {
      const t = await deps.repos.tabs.findById(id);
      return t ? { id: t.id, name: t.name, project_id: t.project_id, machine_id: t.machine_id, state: t.state } : null;
    },
    tabEventsAfter: (tabId, after, kinds) => deps.repos.tabs.eventsAfter(tabId, after, kinds),
    async task(id) {
      const t = await deps.repos.tasks.findById(id);
      return t ? { id: t.id, ref: t.ref, title: t.title, project_id: t.project_id, column_id: t.column_id, status: t.status as CardStatus } : null;
    },
    async pullRequests(w) {
      if (w.params.pr_url) return deps.repos.taskPullRequests.listByUrlForOwner(w.params.pr_url, w.user_id);
      return w.target_id ? deps.repos.taskPullRequests.listByTasks([w.target_id]) : [];
    },
    async machine(id) {
      const m = await deps.repos.machines.findById(id);
      if (!m) {
        offlineSince.delete(id);
        return null;
      }
      const online = deps.agents.isOnline(id);
      if (online) offlineSince.delete(id);
      else if (!offlineSince.has(id)) offlineSince.set(id, now());
      return { id: m.id, name: m.name, online, offline_for_ms: online ? null : now() - offlineSince.get(id)! };
    },
    async latestAgentVersion() {
      if (!npm || now() - npm.at >= NPM_EVERY_MS) npm = { at: now(), version: (await fetchLatest().catch(() => null)) ?? latestAgentVersion() };
      return npm.version;
    },
  };
}
