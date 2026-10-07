import { CAPABILITY_WORKTREE } from '@termhub/agent-protocol';
import { versionAtLeast } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import type { ControlContext } from '../control/context.js';
import { DEFAULT_LOCALE, t, type Locale } from '../i18n/index.js';
import { eligibilityOf, REASON_TEXT, type IneligibleReason } from './eligibility.js';
import { mergeWaitOf } from './merge-wait.js';
import { isPaused } from './pause.js';
import { WAITING_AS_REASON, waitingOf } from './placement.js';
import { MAX_START_FAILURES, startRetryBackoffMs } from './start-retry.js';
import { placeDetailText } from './waiting-text.js';
import { GUARD_MIN_AGENT_VERSION } from '../terminal/tab-mcp.js';

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
 * priority), each with its eligibility. Untagged cards and subtasks are not in the queue. An eligible card
 * the dispatcher found no place for shows why it waits (`no_account`, …) instead, with each machine and
 * account it left out (TER-985). One whose last start failed and waits for the next attempt says so, with the
 * failure's reason (`start_backoff`, TER-987).
 */
export async function automationQueue(ctx: ControlContext, projectId: string, locale: Locale = DEFAULT_LOCALE): Promise<QueueItem[]> {
  const now = new Date();
  const items = await eligibilityQueue(ctx, projectId, locale);
  return Promise.all(
    items.map(async (item) => {
      // a card past `todo` whose PR the merge executor holds says why it is not merged yet
      const merge = item.reason === 'not_in_todo' ? mergeWaitOf(item.task_id, now) : null;
      if (merge) return { ...item, reason: merge, reason_text: t(locale, REASON_TEXT[merge]) };
      if (item.eligible) {
        const retry = await startRetryOf(ctx, item.task_id, locale, now);
        if (retry) return { ...item, eligible: false, reason: 'start_backoff' as const, reason_text: retry };
      }
      const waiting = item.eligible ? waitingOf(item.task_id, now) : null;
      if (!waiting) return item;
      const reason = WAITING_AS_REASON[waiting.reason];
      const detail = waiting.detail ? placeDetailText(locale, waiting.detail) : '';
      return { ...item, eligible: false, reason, reason_text: detail ? `${t(locale, REASON_TEXT[reason])}: ${detail}` : t(locale, REASON_TEXT[reason]) };
    }),
  );
}

/** The text of a card waiting for its next start after a failed one, or null when it is not waiting. */
async function startRetryOf(ctx: ControlContext, taskId: string, locale: Locale, now: Date): Promise<string | null> {
  const failures = await ctx.repos.automationRuns.startFailures(taskId, startRetryBackoffMs);
  if (!failures.recent || !failures.retry_at) return null;
  const minutes = Math.max(1, Math.ceil((failures.retry_at.getTime() - now.getTime()) / 60_000));
  const head = t(locale, 'O início falhou ({{attempt}} de {{max}}); nova tentativa em {{minutes}} min', { attempt: failures.consecutive, max: MAX_START_FAILURES, minutes });
  const blocked = failures.last_run_id ? await ctx.repos.automationEvents.lastForRun(failures.last_run_id, 'run_blocked') : null;
  const why = blocked ? (locale === 'en' ? blocked.payload.message_en : null) ?? blocked.payload.message : null;
  return typeof why === 'string' && why ? `${head}. ${why}` : head;
}

/** The queue as the eligibility rules read it (spec §5), without the dispatcher's waiting reasons: what the dispatcher walks. */
export async function eligibilityQueue(ctx: ControlContext, projectId: string, locale: Locale = DEFAULT_LOCALE): Promise<QueueItem[]> {
  const { project: row } = await ctx.scoped.project(projectId);
  const { repos } = ctx;
  const [cards, columns, setup, links, runs] = await Promise.all([
    repos.tasks.listByProject(projectId),
    repos.taskColumns.list(projectId),
    repos.projectSetup.get(projectId),
    repos.projectMachines.listByProject(projectId),
    repos.automationRuns.activeByProject(projectId),
  ]);
  const running = new Set(runs.map((r) => r.task_id));
  const { automation, repo } = setup.data;
  const column = new Map(columns.map((c) => [c.id, c]));
  const tagged = cards.filter((c) => c.auto);
  if (tagged.length === 0) return [];

  let capable = 0;
  for (const l of links) {
    // worktrees and the hard-lock guard (agent 0.19.0, TER-1005): a run never starts without the guard
    const version = agents.info(l.machine_id)?.agent_version;
    if ((agents.capabilities(l.machine_id) ?? []).includes(CAPABILITY_WORKTREE) && !!version && versionAtLeast(version, GUARD_MIN_AGENT_VERSION)) capable++;
  }
  const project = {
    automation,
    paused: await isPaused(repos, row.owner_id, projectId),
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
        active_run: running.has(c.id),
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
