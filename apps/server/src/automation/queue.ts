import { CAPABILITY_WORKTREE } from '@termhub/agent-protocol';
import { agents } from '../agent/registry.js';
import type { ControlContext } from '../control/context.js';
import { DEFAULT_LOCALE, t, type Locale } from '../i18n/index.js';
import { eligibilityOf, REASON_TEXT, type IneligibleReason } from './eligibility.js';

export interface QueueItem {
  task_id: string;
  ref: string;
  title: string;
  eligible: boolean;
  reason: IneligibleReason | null;
  reason_text: string | null;
}

/**
 * The tagged cards of a project in board order (column position, then card position: the order is the
 * priority), each with its eligibility. Untagged cards and subtasks are not in the queue.
 */
export async function automationQueue(ctx: ControlContext, projectId: string, locale: Locale = DEFAULT_LOCALE): Promise<QueueItem[]> {
  await ctx.scoped.project(projectId);
  const { repos } = ctx;
  const [cards, columns, setup, links] = await Promise.all([
    repos.tasks.listByProject(projectId),
    repos.taskColumns.list(projectId),
    repos.projectSetup.get(projectId),
    repos.projectMachines.listByProject(projectId),
  ]);
  const { automation, repo } = setup.data;
  const column = new Map(columns.map((c) => [c.id, c]));
  const tagged = cards.filter((c) => c.auto);
  if (tagged.length === 0) return [];

  let capable = 0;
  for (const l of links) {
    if ((agents.capabilities(l.machine_id) ?? []).includes(CAPABILITY_WORKTREE)) capable++;
  }
  const project = {
    automation,
    paused: false, // Task 9 wires the pause state in
    repo_ready: Boolean(repo?.full_name && repo.integration_id),
    capable_machines: capable,
  };

  const items: Array<QueueItem & { col: number; pos: number }> = [];
  for (const c of tagged) {
    const col = c.column_id ? column.get(c.column_id) : undefined;
    const tab = c.tab_id ? await repos.tabs.findById(c.tab_id) : undefined;
    const verdict = eligibilityOf({
      card: {
        type: c.type,
        parent_id: c.parent_id,
        auto: c.auto,
        column_category: col?.category ?? null,
        description: c.description,
        subtask_count: c.subtask_counts.total,
        tab_alive: Boolean(tab),
        active_run: false, // Task 11 adds the runs table
      },
      project,
    });
    if (!verdict) continue;
    const reason = verdict.eligible ? null : verdict.reason;
    items.push({
      task_id: c.id,
      ref: c.ref,
      title: c.title,
      eligible: verdict.eligible,
      reason,
      reason_text: reason ? t(locale, REASON_TEXT[reason]) : null,
      col: col?.position ?? Number.MAX_SAFE_INTEGER,
      pos: c.position,
    });
  }
  items.sort((a, b) => a.col - b.col || a.pos - b.pos);
  return items.map(({ col: _c, pos: _p, ...item }) => item);
}
