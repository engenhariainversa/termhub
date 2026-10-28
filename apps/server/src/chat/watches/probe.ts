/**
 * TER-1099: the real `WatchProbe` — the database for tabs, cards and PRs, this process's agent registry for
 * machines, and npm for agent releases (read at most every `NPM_EVERY_MS`, and only while a watch asks).
 */
import type { Repositories } from '../../db/repositories/index.js';
import { fetchLatestAgentVersion, latestAgentVersion } from '../../agent/latest-version.js';
import { MERGE_NO_CI, MERGE_PERSON_CARD } from '../../automation/escalation-text.js';
import type { TaskPullRequest } from '../../db/repositories/task-pull-requests.js';
import type { ProbePr, WatchProbe } from './evaluate.js';
import type { CardStatus } from './kinds.js';

export const NPM_EVERY_MS = 2 * 60_000;

export interface ProbeDeps {
  repos: Pick<Repositories, 'tabs' | 'tasks' | 'taskPullRequests' | 'machines'> & Partial<Pick<Repositories, 'automationEvents'>>;
  agents: { isOnline(machineId: string): boolean };
  fetchLatest?: () => Promise<string | null>;
  now?: () => number;
}

/** TER-1136: the escalations that mean termhub will not merge a green head by itself. */
const MERGE_BLOCKS: readonly string[] = [MERGE_PERSON_CARD, MERGE_NO_CI];

export function createWatchProbe(deps: ProbeDeps): WatchProbe {
  /** Each open PR head with what the merge executor last said about it: held, or waiting for an approval. */
  async function withMergeBlocks(rows: TaskPullRequest[]): Promise<ProbePr[]> {
    const events = deps.repos.automationEvents;
    if (!events) return rows;
    const said = new Map<string, string | null>();
    const out: ProbePr[] = [];
    for (const r of rows) {
      if (r.state !== 'open') {
        out.push(r);
        continue;
      }
      const key = `${r.project_id}:${r.number}@${r.head_sha}`;
      if (!said.has(key)) {
        const e = await events.lastForPullHead(r.project_id, ['escalated', 'merge_needs_approval'], r.number, r.head_sha);
        const reason = e ? e.payload.reason : null;
        said.set(key, e?.kind === 'merge_needs_approval' ? 'merge_needs_approval' : typeof reason === 'string' && MERGE_BLOCKS.includes(reason) ? reason : null);
      }
      out.push({ ...r, merge_blocked: said.get(key) ?? null });
    }
    return out;
  }

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
      const rows = w.params.pr_url
        ? await deps.repos.taskPullRequests.listByUrlForOwner(w.params.pr_url, w.user_id)
        : w.target_id
          ? await deps.repos.taskPullRequests.listByTasks([w.target_id])
          : [];
      return withMergeBlocks(rows);
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
