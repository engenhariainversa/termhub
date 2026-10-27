/**
 * TER-1121: what the health watcher reads of one project, from the database and from this process's own view
 * (agents online, the merge executor's waits and base reading, the dispatcher's waiting reasons through the
 * queue). Ids, names, states and reason codes only — never terminal content.
 */
import { agents } from '../agent/registry.js';
import { MIN_AGENT_VERSION } from '../agent/min-version.js';
import { baseReadingOf, mergeWaitOf } from '../automation/merge-wait.js';
import { isPaused } from '../automation/pause.js';
import { automationQueue } from '../automation/queue.js';
import { controlContextFor } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Project, User } from '../db/repositories/types.js';
import { localeOf } from '../i18n/index.js';
import type { ProjectSetupData } from '../setup/schema.js';
import type { HealthSnapshot, SnapshotCard, SnapshotMachine, SnapshotPr, SnapshotRun } from './signals.js';

/** Merged PRs older than this no longer count for a failed deploy or release. */
export const DELIVERY_LOOKBACK_MS = 3 * 24 * 3600_000;

const date = (v: string | Date | null | undefined): Date | null => (v ? new Date(v) : null);
const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));

export async function buildSnapshot(repos: Repositories, project: Project, owner: User, setup: ProjectSetupData, now = new Date()): Promise<HealthSnapshot> {
  const automationOn = setup.automation.enabled && !(await isPaused(repos, project.owner_id, project.id));
  const [tasks, columns, tabs, active, links, prRows, lastRunAt] = await Promise.all([
    repos.tasks.listByProject(project.id),
    repos.taskColumns.list(project.id),
    repos.tabs.listByProject(project.id),
    repos.automationRuns.activeByProject(project.id),
    repos.projectMachines.listByProject(project.id),
    automationOn ? repos.taskPullRequests.listForHealth(project.id, new Date(now.getTime() - DELIVERY_LOOKBACK_MS)) : Promise.resolve([]),
    automationOn ? repos.automationRuns.lastStartedAt(project.id) : Promise.resolve(null),
  ]);
  const refOf = new Map(tasks.map((t) => [t.id, t.ref]));
  const runTabs = new Set(active.flatMap((r) => (r.tab_id ? [r.tab_id] : [])));
  const tabIds = new Set(tabs.map((t) => t.id));
  // TER-1134: a card in a waiting column waits on a person or a third party; it is in "esperando você", never an orphan
  const waitingColumns = new Set(columns.filter((c) => c.waiting).map((c) => c.id));

  // a PR naming several cards has one row per card: one entry per URL
  const prs = new Map<string, SnapshotPr>();
  const auto = new Set(tasks.filter((t) => t.auto).map((t) => t.id));
  for (const r of prRows) {
    // termhub merges only the PRs of cards tagged automático: a manual card's PR is the person's to merge
    if (prs.has(r.url) || !auto.has(r.task_id)) continue;
    prs.set(r.url, {
      url: r.url, repo: r.repo, number: r.number, title: r.title, task_ref: refOf.get(r.task_id) ?? '', state: r.state, draft: r.draft,
      ci_state: r.ci_state, base_ref: r.base_ref, merged_at: r.merged_at, deploy_state: r.deploy_state, deploy_url: r.deploy_url,
      release_runs: r.release_runs.map((x) => ({ workflow: x.workflow, state: x.state, url: x.url })), wait: mergeWaitOf(r.task_id, now),
    });
  }
  const openPrTasks = new Set(prRows.filter((r) => r.state === 'open').map((r) => r.task_id));

  const runs: SnapshotRun[] = [];
  const doing: SnapshotCard[] = [];
  if (automationOn) {
    const activeTasks = new Set(active.map((r) => r.task_id));
    for (const r of active) runs.push({ id: r.id, task_id: r.task_id, ref: r.task_id ? (refOf.get(r.task_id) ?? null) : null, status: r.status, waiting_reason: r.waiting_reason, ended_at: r.ended_at });
    for (const t of tasks) {
      if (t.status !== 'doing' || t.parent_id !== null || t.type === 'epic' || (t.column_id && waitingColumns.has(t.column_id))) continue;
      const latest = await repos.automationRuns.latestOfTask(t.id);
      if (latest?.status === 'blocked') runs.push({ id: latest.id, task_id: t.id, ref: t.ref, status: latest.status, waiting_reason: latest.waiting_reason, ended_at: latest.ended_at });
      doing.push({
        task_id: t.id, ref: t.ref, title: t.title, since: later(date(t.updated_at), latest?.ended_at ?? null) ?? now,
        tab_alive: !!t.tab_id && tabIds.has(t.tab_id), active_run: activeTasks.has(t.id), latest_run: latest?.status ?? null, open_pr: openPrTasks.has(t.id),
      });
    }
  }

  const queued = automationOn
    ? (await automationQueue(controlContextFor(repos, owner), project.id, localeOf(owner.locale)))
        .filter((q) => q.reason !== 'not_in_todo')
        .map((q) => ({ task_id: q.task_id, ref: q.ref, reason: q.reason, reason_text: q.reason_text }))
    : [];

  const machines: SnapshotMachine[] = [];
  for (const l of links) {
    const m = await repos.machines.findById(l.machine_id);
    if (!m) continue;
    const online = agents.isOnline(m.id);
    machines.push({
      id: m.id, name: m.name, agent: m.type === 'agent', online, last_seen_at: date(m.agent_last_seen_at),
      agent_version: (online ? agents.info(m.id)?.agent_version : null) ?? m.agent_version,
      has_work: tabs.some((t) => t.machine_id === m.id) || active.some((r) => r.machine_id === m.id),
    });
  }

  const base = automationOn ? baseReadingOf(project.id, now) : null;
  return {
    now,
    automation: automationOn,
    autonomy: setup.automation.autonomy,
    base_branch: setup.repo?.base_branch ?? 'main',
    prs: [...prs.values()],
    base: base ? { state: base.state, sha: base.sha, failing: base.failing } : null,
    queued,
    active_runs: active.length,
    last_run_at: lastRunAt,
    tabs: tabs.filter((t) => t.kind === 'terminal').map((t) => ({ id: t.id, name: t.name, state: t.state, state_at: date(t.state_at), machine_id: t.machine_id, run: runTabs.has(t.id) })),
    doing,
    runs,
    machines,
    min_agent_version: MIN_AGENT_VERSION,
  };
}
