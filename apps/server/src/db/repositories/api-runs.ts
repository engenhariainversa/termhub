import type { PrismaClient } from '../prisma.js';
import { Prisma, type ApiRun as PrismaApiRun } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

/**
 * Runs of the personal runs API (TER-1176, `/api/v1/runs`, behind the `runs_api` flag) and their
 * normalized events. Every read is by owner: a run id of another person is the same as a missing one.
 * Never the prompt; events are the owner's own data and are never logged.
 */

export const API_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type ApiRunStatus = (typeof API_RUN_STATUSES)[number];
/** A run that still holds a slot: counted by the limits (`runs/limits.ts`). */
export const ACTIVE_RUN_STATUSES: readonly ApiRunStatus[] = ['queued', 'running'];

export interface ApiRunWorkspace {
  kind: 'project' | 'worktree';
  path: string;
  branch: string | null;
}

export interface ApiRunUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number;
}

export interface ApiRun {
  id: string;
  user_id: string;
  token_id: string | null;
  project_id: string;
  machine_id: string | null;
  /** The machine's name, read now (null once it is gone). */
  machine_name: string | null;
  account_id: string | null;
  /** The AI account's label only, read now (null once it is gone). */
  account_label: string | null;
  provider: string | null;
  model: string | null;
  capabilities: string[];
  status: ApiRunStatus;
  workspace: ApiRunWorkspace | null;
  result: string | null;
  usage: ApiRunUsage | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  timeout_ms: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface CreateApiRunInput {
  user_id: string;
  token_id: string | null;
  project_id: string;
  capabilities: string[];
  timeout_ms: number;
  idempotency_key?: string | null;
  provider?: string | null;
  model?: string | null;
}

/** What may change on a run as it moves along; absent keys stay as they are. */
export interface ApiRunPatch {
  status?: ApiRunStatus;
  machine_id?: string | null;
  account_id?: string | null;
  provider?: string | null;
  model?: string | null;
  workspace?: ApiRunWorkspace | null;
  result?: string | null;
  usage?: ApiRunUsage | null;
  error_code?: string | null;
  error_message?: string | null;
  started_at?: Date | null;
  ended_at?: Date | null;
}

export interface RunEventRow {
  type: string;
  payload: Record<string, unknown>;
}

export interface StoredRunEvent extends RunEventRow {
  seq: number;
  at: string;
}

const include = { machine: { select: { name: true } }, account: { select: { label: true } } } as const;
type Row = PrismaApiRun & { machine: { name: string } | null; account: { label: string } | null };

const asStatus = (s: string): ApiRunStatus => ((API_RUN_STATUSES as readonly string[]).includes(s) ? (s as ApiRunStatus) : 'failed');
const iso = (d: Date | null) => d?.toISOString() ?? null;
const json = (v: unknown) => (v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

const mapRun = (r: Row): ApiRun => ({
  id: r.id,
  user_id: r.userId,
  token_id: r.tokenId,
  project_id: r.projectId,
  machine_id: r.machineId,
  machine_name: r.machine?.name ?? null,
  account_id: r.accountId,
  account_label: r.account?.label ?? null,
  provider: r.provider,
  model: r.model,
  capabilities: r.capabilities,
  status: asStatus(r.status),
  workspace: (r.workspace as ApiRunWorkspace | null) ?? null,
  result: r.result,
  usage: (r.usage as ApiRunUsage | null) ?? null,
  error_code: r.errorCode,
  error_message: r.errorMessage,
  idempotency_key: r.idempotencyKey,
  timeout_ms: r.timeoutMs,
  created_at: r.createdAt.toISOString(),
  started_at: iso(r.startedAt),
  ended_at: iso(r.endedAt),
});

export class ApiRunsRepository {
  constructor(private db: PrismaClient) {}

  async create(input: CreateApiRunInput): Promise<ApiRun> {
    const row = await this.db.apiRun.create({
      data: {
        id: newId(),
        userId: input.user_id,
        tokenId: input.token_id,
        projectId: input.project_id,
        capabilities: input.capabilities,
        timeoutMs: input.timeout_ms,
        idempotencyKey: input.idempotency_key ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
      },
      include,
    });
    return mapRun(row);
  }

  /** The run when it is this person's; undefined otherwise (another person's run is "not found"). */
  async findForUser(userId: string, id: string): Promise<ApiRun | undefined> {
    const row = await this.db.apiRun.findFirst({ where: { id, userId }, include });
    return row ? mapRun(row) : undefined;
  }

  /** The person's runs, newest first. */
  async listForUser(userId: string, opts: { projectId?: string; status?: ApiRunStatus; limit: number }): Promise<ApiRun[]> {
    const rows = await this.db.apiRun.findMany({
      where: { userId, ...(opts.projectId ? { projectId: opts.projectId } : {}), ...(opts.status ? { status: opts.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit,
      include,
    });
    return rows.map(mapRun);
  }

  /** The run created earlier with the same idempotency key, if any. */
  async findByIdempotency(userId: string, key: string): Promise<ApiRun | undefined> {
    const row = await this.db.apiRun.findFirst({ where: { userId, idempotencyKey: key }, include });
    return row ? mapRun(row) : undefined;
  }

  async setStatus(id: string, patch: ApiRunPatch): Promise<ApiRun | undefined> {
    const data: Prisma.ApiRunUncheckedUpdateInput = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.machine_id !== undefined) data.machineId = patch.machine_id;
    if (patch.account_id !== undefined) data.accountId = patch.account_id;
    if (patch.provider !== undefined) data.provider = patch.provider;
    if (patch.model !== undefined) data.model = patch.model;
    if (patch.workspace !== undefined) data.workspace = json(patch.workspace);
    if (patch.result !== undefined) data.result = patch.result;
    if (patch.usage !== undefined) data.usage = json(patch.usage);
    if (patch.error_code !== undefined) data.errorCode = patch.error_code;
    if (patch.error_message !== undefined) data.errorMessage = patch.error_message;
    if (patch.started_at !== undefined) data.startedAt = patch.started_at;
    if (patch.ended_at !== undefined) data.endedAt = patch.ended_at;
    const { count } = await this.db.apiRun.updateMany({ where: { id }, data });
    if (count === 0) return undefined;
    const row = await this.db.apiRun.findUnique({ where: { id }, include });
    return row ? mapRun(row) : undefined;
  }

  /**
   * Stores events after the run's last one and returns them with their `seq` (1, 2, …). The run row is
   * locked first, so two writers never hand out the same number.
   */
  async appendEvents(runId: string, events: readonly RunEventRow[]): Promise<StoredRunEvent[]> {
    if (events.length === 0) return [];
    return this.db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "api_runs" WHERE "id" = ${runId} FOR UPDATE`;
      if (!locked) return [];
      const last = await tx.apiRunEvent.aggregate({ where: { runId }, _max: { seq: true } });
      const first = (last._max.seq ?? 0) + 1;
      const at = new Date();
      await tx.apiRunEvent.createMany({ data: events.map((e, i) => ({ runId, seq: first + i, type: e.type, payload: e.payload as Prisma.InputJsonValue, at })) });
      return events.map((e, i) => ({ seq: first + i, type: e.type, payload: e.payload, at: at.toISOString() }));
    });
  }

  /** The run's events with `seq` above `afterSeq`, in order (0 = from the start). */
  async eventsAfter(runId: string, afterSeq: number, limit = 1000): Promise<StoredRunEvent[]> {
    const rows = await this.db.apiRunEvent.findMany({ where: { runId, seq: { gt: afterSeq } }, orderBy: { seq: 'asc' }, take: limit });
    return rows.map((r) => ({ seq: r.seq, type: r.type, payload: r.payload as Record<string, unknown>, at: r.at.toISOString() }));
  }

  /** Runs still holding a slot (queued or running), of one person or of one token. */
  async countRunning(by: { userId: string } | { tokenId: string }): Promise<number> {
    const owner = 'userId' in by ? { userId: by.userId } : { tokenId: by.tokenId };
    return this.db.apiRun.count({ where: { ...owner, status: { in: [...ACTIVE_RUN_STATUSES] } } });
  }

  /** Runs this token created at or after `since`. */
  async countCreatedSince(tokenId: string, since: Date): Promise<number> {
    return this.db.apiRun.count({ where: { tokenId, createdAt: { gte: since } } });
  }

  /** When the oldest of those runs was created (null = none): when the hourly window frees a slot. */
  async oldestCreatedSince(tokenId: string, since: Date): Promise<Date | null> {
    const row = await this.db.apiRun.findFirst({ where: { tokenId, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  }

  /** Drops events older than `before` (7 days); the run rows stay. Returns how many went. */
  async deleteEventsBefore(before: Date): Promise<number> {
    const { count } = await this.db.apiRunEvent.deleteMany({ where: { at: { lt: before } } });
    return count;
  }
}
