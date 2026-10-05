import type { PullRequestBadge } from '@termhub/mobile-api';
import type { PrismaClient } from '../prisma.js';
import type { AutomationEvent } from './automation-events.js';
import type { FeedRow, ProgressEpicRow, ProgressTabRow } from '../../progress/aggregate.js';

const TAB = { include: { machine: { select: { name: true } } } } as const;

type TabWithMachine = {
  id: string;
  name: string;
  state: ProgressTabRow['state'];
  stateAt: Date | null;
  activity: string | null;
  activityVerb: string | null;
  rateLimitedAt: Date | null;
  machine: { name: string };
};

const toTab = (t: TabWithMachine | null, automatic: Set<string>): ProgressTabRow | null =>
  t && { id: t.id, name: t.name, machine_name: t.machine.name, state: t.state, state_at: t.stateAt, activity: t.activity, activity_verb: t.activityVerb, rate_limited_at: t.rateLimitedAt, automatic: automatic.has(t.id) };

/**
 * The progress panel's rows (spec 2026-09-26 progress-panel §4.5): epics of the owner's
 * non-archived projects, each with its top-level cards, their subtasks and the tabs linked to
 * either. A card's tab always belongs to the card's project, so the project filter scopes it too.
 */
export class ProgressRepository {
  constructor(private db: PrismaClient) {}

  async list(opts: { owner: string | null; projectId: string | null }): Promise<ProgressEpicRow[]> {
    const project = { status: { not: 'archived' as const }, ...(opts.owner ? { ownerId: opts.owner } : {}), ...(opts.projectId ? { id: opts.projectId } : {}) };
    const epics = await this.db.task.findMany({
      where: { type: 'epic', project },
      include: { project: { select: { id: true, key: true, name: true } } },
      orderBy: [{ projectId: 'asc' }, { number: 'asc' }],
    });
    if (epics.length === 0) return [];
    const cards = await this.db.task.findMany({
      where: { epicId: { in: epics.map((e) => e.id) }, parentId: null, type: { not: 'epic' } },
      include: {
        column: { select: { name: true } },
        tab: TAB,
        subtasks: { include: { tab: TAB }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
        pullRequests: { orderBy: [{ number: 'desc' }] },
      },
    });
    const tabIds = cards.flatMap((c) => [c.tabId, ...c.subtasks.map((s) => s.tabId)]).filter((id): id is string => !!id);
    const automatic = new Set(
      tabIds.length === 0 ? [] : (await this.db.automationRun.findMany({ where: { tabId: { in: tabIds } }, select: { tabId: true }, distinct: ['tabId'] })).map((r) => r.tabId!),
    );
    const byEpic = new Map<string, typeof cards>();
    for (const c of cards) {
      const list = byEpic.get(c.epicId!) ?? [];
      list.push(c);
      byEpic.set(c.epicId!, list);
    }
    return epics.map((e) => {
      const ref = (n: number) => `${e.project.key}-${n}`;
      return {
        id: e.id,
        ref: ref(e.number),
        title: e.title,
        project: e.project,
        cards: (byEpic.get(e.id) ?? []).map((c) => ({
          id: c.id,
          ref: ref(c.number),
          title: c.title,
          type: c.type,
          status: c.status,
          position: c.position,
          column_name: c.column?.name ?? null,
          auto: c.auto,
          started_at: c.startedAt,
          done_at: c.doneAt,
          active_seconds: c.activeSeconds,
          tab: toTab(c.tab, automatic),
          subtasks: c.subtasks.map((s) => ({ id: s.id, ref: ref(s.number), status: s.status, done_at: s.doneAt, tab: toTab(s.tab, automatic) })),
          pull_requests: c.pullRequests.map(
            (p): PullRequestBadge => ({
              number: p.number,
              url: p.url,
              title: p.title,
              state: p.state as 'open' | 'closed' | 'merged',
              draft: p.draft,
              ci_state: p.ciState as PullRequestBadge['ci_state'],
              ci_summary: { total: 0, passed: 0, failed: 0, running: 0, failing: [], ...(p.ciSummary as object) },
              deploy_state: p.deployState as PullRequestBadge['deploy_state'],
              deploy_url: p.deployUrl,
              release_runs: p.releaseRuns as unknown as NonNullable<PullRequestBadge['release_runs']>,
            }),
          ),
        })),
      };
    });
  }

  /**
   * The newest automatic events of the owner's non-archived projects, each with the card, epic, machine and
   * account its sentence names (the run's, when the payload does not carry them). Empty for someone with no
   * automatic work: the section never shows and costs no request of its own.
   */
  async feed(opts: { owner: string | null; projectId: string | null; limit: number }): Promise<FeedRow[]> {
    const project = { status: { not: 'archived' as const }, ...(opts.owner ? { ownerId: opts.owner } : {}), ...(opts.projectId ? { id: opts.projectId } : {}) };
    const events = await this.db.automationEvent.findMany({
      where: { project },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit,
      include: { task: { select: { number: true, epic: { select: { title: true } }, project: { select: { key: true } } } } },
    });
    if (events.length === 0) return [];
    const payloadOf = (e: (typeof events)[number]) => (e.payload ?? {}) as AutomationEvent['payload'];
    const runIds = [...new Set(events.map((e) => e.runId).filter((id): id is string => !!id))];
    const runs = new Map((await this.db.automationRun.findMany({ where: { id: { in: runIds } }, select: { id: true, tabId: true, machineId: true, accountId: true, branch: true } })).map((r) => [r.id, r]));
    const machineIds = new Set<string>();
    const accountIds = new Set<string>();
    for (const e of events) {
      const p = payloadOf(e);
      const run = e.runId ? runs.get(e.runId) : undefined;
      for (const id of [p.machine_id, run?.machineId]) if (typeof id === 'string') machineIds.add(id);
      for (const id of [p.account_id, run?.accountId]) if (typeof id === 'string') accountIds.add(id);
    }
    const machines = new Map((await this.db.machine.findMany({ where: { id: { in: [...machineIds] } }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
    const accounts = new Map((await this.db.aiAccount.findMany({ where: { id: { in: [...accountIds] } }, select: { id: true, label: true } })).map((a) => [a.id, a.label]));
    return events.map((e) => {
      const p = payloadOf(e);
      const run = e.runId ? runs.get(e.runId) : undefined;
      const machineId = typeof p.machine_id === 'string' ? p.machine_id : run?.machineId;
      const accountId = typeof p.account_id === 'string' ? p.account_id : run?.accountId;
      return {
        event: { id: e.id, project_id: e.projectId, task_id: e.taskId, run_id: e.runId, kind: e.kind as AutomationEvent['kind'], payload: p, created_at: e.createdAt.toISOString() },
        ref: e.task ? `${e.task.project.key}-${e.task.number}` : null,
        epic: e.task?.epic?.title ?? null,
        machine: (machineId && machines.get(machineId)) || null,
        account: (accountId && accounts.get(accountId)) || null,
        tab_id: run?.tabId ?? null,
        branch: run?.branch ?? null,
      };
    });
  }
}
