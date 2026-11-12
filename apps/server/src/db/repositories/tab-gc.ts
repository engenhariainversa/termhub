import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import type { TabState, TaskStatus } from './types.js';

/*
 * TER-1171: what the tab GC reads and writes (monitor/tab-gc). Kept apart from TabsRepository so the GC's
 * columns (pin, warning, reset) do not travel with every tab the app sends.
 */

/** An agent tab with what the GC needs to classify it. Times are ISO strings; null = never. */
export interface GcTab {
  id: string;
  project_id: string;
  owner_id: string | null;
  machine_id: string;
  name: string;
  tmux_session: string;
  state: TabState | null;
  state_tool: string | null;
  state_text: string | null;
  state_at: string | null;
  rate_limited_at: string | null;
  agent_session_id: string | null;
  cwd: string | null;
  /** the newest monitor event of the tab */
  last_event_at: string | null;
  /** the top-level card linked to the tab, if any */
  task: { id: string; ref_number: number | null; status: TaskStatus } | null;
  gc_pinned: boolean;
  gc_warned_at: string | null;
  gc_warned_state_at: string | null;
  gc_reset_at: string | null;
}

export interface TabGcArchiveInput {
  project_id: string;
  task_id: string | null;
  tab_id: string;
  tab_name: string;
  machine_id: string;
  machine_name: string;
  tool: string | null;
  state: string | null;
  reason: string;
  agent_session_id: string | null;
  cwd: string | null;
  last_answer: string | null;
  last_answer_at: string | null;
}

export interface TabGcArchive extends TabGcArchiveInput {
  id: string;
  collected_at: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** How many agent tabs one pass reads at most (bounds a runaway instance; the rest wait for the next pass). */
export const GC_TABS_LIMIT = 2000;

export class TabGcRepository {
  constructor(private db: PrismaClient) {}

  /**
   * Agent tabs (a terminal tab with a tmux session where an agent reported a state), oldest state first,
   * optionally of one owner, project or machine.
   */
  async listAgentTabs(filter: { ownerId?: string; projectId?: string; machineId?: string } = {}, limit = GC_TABS_LIMIT): Promise<GcTab[]> {
    const rows = await this.db.tab.findMany({
      where: {
        kind: 'terminal',
        tmuxSession: { not: null },
        stateTool: { not: null },
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        ...(filter.machineId ? { machineId: filter.machineId } : {}),
        ...(filter.ownerId ? { project: { ownerId: filter.ownerId } } : {}),
      },
      include: {
        project: { select: { ownerId: true } },
        tasks: { where: { parentId: null }, select: { id: true, number: true, status: true }, orderBy: { createdAt: 'asc' }, take: 1 },
        events: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
      },
      orderBy: [{ stateAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      project_id: r.projectId,
      owner_id: r.project.ownerId ?? null,
      machine_id: r.machineId,
      name: r.name,
      tmux_session: r.tmuxSession as string,
      state: (r.state as TabState | null) ?? null,
      state_tool: r.stateTool,
      state_text: r.stateText,
      state_at: iso(r.stateAt),
      rate_limited_at: iso(r.rateLimitedAt),
      agent_session_id: r.agentSessionId,
      cwd: r.cwd,
      last_event_at: iso(r.events[0]?.createdAt),
      task: r.tasks[0] ? { id: r.tasks[0].id, ref_number: r.tasks[0].number ?? null, status: r.tasks[0].status as TaskStatus } : null,
      gc_pinned: r.gcPinned,
      gc_warned_at: iso(r.gcWarnedAt),
      gc_warned_state_at: iso(r.gcWarnedStateAt),
      gc_reset_at: iso(r.gcResetAt),
    }));
  }

  /**
   * Marks the tab as warned, once: only a tab not warned yet is marked (two sweeps — blue and green during a
   * deploy — race here; the loser gets false and records nothing).
   */
  async warn(tabId: string, at: Date, stateAt: Date | null): Promise<boolean> {
    const r = await this.db.tab.updateMany({ where: { id: tabId, gcWarnedAt: null }, data: { gcWarnedAt: at, gcWarnedStateAt: stateAt } });
    return r.count > 0;
  }

  /** Drops the warning; true when there was one. */
  async clearWarning(tabId: string): Promise<boolean> {
    const r = await this.db.tab.updateMany({ where: { id: tabId, gcWarnedAt: { not: null } }, data: { gcWarnedAt: null, gcWarnedStateAt: null } });
    return r.count > 0;
  }

  /** Restarts the tab's rest clock ("manter", or a dry-run collection) and drops any warning. */
  async reset(tabId: string, at: Date): Promise<void> {
    await this.db.tab.updateMany({ where: { id: tabId }, data: { gcResetAt: at, gcWarnedAt: null, gcWarnedStateAt: null } });
  }

  async setPinned(tabId: string, pinned: boolean): Promise<void> {
    await this.db.tab.updateMany({ where: { id: tabId }, data: { gcPinned: pinned, ...(pinned ? { gcWarnedAt: null, gcWarnedStateAt: null } : {}) } });
  }

  async archive(input: TabGcArchiveInput): Promise<TabGcArchive> {
    const row = await this.db.tabGcArchive.create({
      data: {
        id: newId(),
        projectId: input.project_id,
        taskId: input.task_id,
        tabId: input.tab_id,
        tabName: input.tab_name,
        machineId: input.machine_id,
        machineName: input.machine_name,
        tool: input.tool,
        state: input.state,
        reason: input.reason,
        agentSessionId: input.agent_session_id,
        cwd: input.cwd,
        lastAnswer: input.last_answer,
        lastAnswerAt: input.last_answer_at ? new Date(input.last_answer_at) : null,
      },
    });
    return { ...input, id: row.id, collected_at: row.collectedAt.toISOString() };
  }

  /** What the GC kept of a project's collected tabs (or one card's), newest first. */
  async listArchive(projectId: string, opts: { taskId?: string; limit?: number } = {}): Promise<TabGcArchive[]> {
    const rows = await this.db.tabGcArchive.findMany({
      where: { projectId, ...(opts.taskId ? { taskId: opts.taskId } : {}) },
      orderBy: { collectedAt: 'desc' },
      take: opts.limit ?? 50,
    });
    return rows.map((r) => ({
      id: r.id,
      project_id: r.projectId,
      task_id: r.taskId,
      tab_id: r.tabId,
      tab_name: r.tabName,
      machine_id: r.machineId,
      machine_name: r.machineName,
      tool: r.tool,
      state: r.state,
      reason: r.reason,
      agent_session_id: r.agentSessionId,
      cwd: r.cwd,
      last_answer: r.lastAnswer,
      last_answer_at: iso(r.lastAnswerAt),
      collected_at: r.collectedAt.toISOString(),
    }));
  }

  /** A person's own level of the GC settings (raw; config.ts reads it leniently). */
  async userLevel(userId: string): Promise<unknown> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { tabGc: true } });
    return u?.tabGc ?? null;
  }

  /** A machine's level of the GC settings and its TER-1138 hours. */
  async machineLevel(machineId: string): Promise<{ level: unknown; idle_hours: number | null }> {
    const m = await this.db.machine.findUnique({ where: { id: machineId }, select: { tabGc: true, idleTabCloseHours: true } });
    return { level: m?.tabGc ?? null, idle_hours: m?.idleTabCloseHours ?? null };
  }
}
