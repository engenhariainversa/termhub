import type { PullRequestBadge } from '@termhub/mobile-api';
import type { PrismaClient } from '../prisma.js';
import type { ProgressEpicRow, ProgressTabRow } from '../../progress/aggregate.js';

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

const toTab = (t: TabWithMachine | null): ProgressTabRow | null =>
  t && { id: t.id, name: t.name, machine_name: t.machine.name, state: t.state, state_at: t.stateAt, activity: t.activity, activity_verb: t.activityVerb, rate_limited_at: t.rateLimitedAt };

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
          tab: toTab(c.tab),
          subtasks: c.subtasks.map((s) => ({ id: s.id, ref: ref(s.number), status: s.status, done_at: s.doneAt, tab: toTab(s.tab) })),
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
}
