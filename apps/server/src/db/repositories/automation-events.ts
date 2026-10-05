import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

/** What the automatic work did (agentic board). `ci_fix_requested` ({ pr, sha }) lets the red-CI loop
 * ask for a fix once per commit. */
export type AutomationEventKind =
  | 'run_started'
  | 'run_resumed'
  | 'run_done'
  | 'run_blocked'
  | 'question_answered'
  | 'escalated'
  | 'pr_opened'
  | 'merged'
  | 'merge_needs_approval'
  | 'deploy_ok'
  | 'deploy_failed'
  | 'release_ok'
  | 'release_failed'
  | 'quota_hit'
  | 'quota_reset'
  | 'paused'
  | 'resumed'
  | 'budget_hit'
  | 'ci_fix_requested';

/** Flat on purpose: ids, URLs, counts and reasons — never terminal content, transcripts or prompts. */
export type AutomationEventPayload = Record<string, string | number | boolean | null>;

export interface AutomationEvent {
  id: string;
  project_id: string;
  task_id: string | null;
  run_id: string | null;
  kind: AutomationEventKind;
  payload: AutomationEventPayload;
  created_at: string;
}

export interface AutomationEventInput {
  project_id: string;
  task_id?: string | null;
  run_id?: string | null;
  kind: AutomationEventKind;
  payload?: AutomationEventPayload;
}

/** Events are kept this long (the hourly purge drops older rows). */
export const AUTOMATION_EVENT_RETENTION_MS = 30 * 24 * 3600_000;
export const AUTOMATION_EVENTS_PAGE_MAX = 100;

type Row = Awaited<ReturnType<PrismaClient['automationEvent']['findFirstOrThrow']>>;
const map = (r: Row): AutomationEvent => ({
  id: r.id,
  project_id: r.projectId,
  task_id: r.taskId,
  run_id: r.runId,
  kind: r.kind as AutomationEventKind,
  payload: (r.payload ?? {}) as AutomationEventPayload,
  created_at: r.createdAt.toISOString(),
});

export class AutomationEventsRepository {
  constructor(private db: PrismaClient) {}

  async insert(e: AutomationEventInput): Promise<AutomationEvent> {
    const row = await this.db.automationEvent.create({
      data: { id: newId(), projectId: e.project_id, taskId: e.task_id ?? null, runId: e.run_id ?? null, kind: e.kind, payload: e.payload ?? {} },
    });
    return map(row);
  }

  /** Newest first; `before` pages back from an earlier page's last `created_at`. */
  async listByProject(projectId: string, opts: { before?: Date; limit: number }): Promise<AutomationEvent[]> {
    const rows = await this.db.automationEvent.findMany({
      where: { projectId, ...(opts.before ? { createdAt: { lt: opts.before } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(opts.limit, 1), AUTOMATION_EVENTS_PAGE_MAX),
    });
    return rows.map(map);
  }

  /** Drops events older than `cutoff`; the number removed. */
  async purgeBefore(cutoff: Date): Promise<number> {
    const { count } = await this.db.automationEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return count;
  }
}
