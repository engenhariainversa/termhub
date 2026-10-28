import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import type { NoteWrittenBy } from './memory-items.js';

/** One hourly quota bucket (TER-1137): an owner's notes of one project (null = account-wide) from one
 *  origin, or an owner's lessons of one project (`writtenBy` null). */
export interface MemoryBucket {
  ownerId: string;
  projectId: string | null;
  what: 'note' | 'lesson';
  writtenBy: NoteWrittenBy | null;
}

export interface QueuedMemoryWrite extends MemoryBucket {
  id: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

interface RawQueued {
  id: string;
  owner_id: string;
  project_id: string | null;
  what: string;
  written_by: string | null;
  payload: unknown;
  created_at: Date;
}

const mapQueued = (r: RawQueued): QueuedMemoryWrite => ({
  id: r.id,
  ownerId: r.owner_id,
  projectId: r.project_id,
  what: r.what as MemoryBucket['what'],
  writtenBy: r.written_by as NoteWrittenBy | null,
  payload: (r.payload ?? {}) as Record<string, unknown>,
  createdAt: r.created_at,
});

/** The memory writes over their hourly quota, waiting for room (TER-1137). */
export class MemoryWriteQueueRepository {
  constructor(private db: PrismaClient) {}

  async enqueue(b: MemoryBucket, payload: object): Promise<QueuedMemoryWrite> {
    // Through JSON first: dates become ISO strings, as they come back out of the column.
    const json = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const row = await this.db.memoryWriteQueue.create({
      data: { id: newId(), ownerId: b.ownerId, projectId: b.projectId, what: b.what, writtenBy: b.writtenBy, payload: json as object },
    });
    return { id: row.id, ownerId: row.ownerId, projectId: row.projectId, what: b.what, writtenBy: b.writtenBy, payload: json, createdAt: row.createdAt };
  }

  /** How many writes wait in this bucket. */
  count(b: MemoryBucket): Promise<number> {
    return this.db.memoryWriteQueue.count({ where: { ownerId: b.ownerId, projectId: b.projectId, what: b.what, writtenBy: b.writtenBy } });
  }

  /** Every bucket with a write waiting, the person's first, then the oldest waiting write first. */
  async buckets(): Promise<MemoryBucket[]> {
    const rows = await this.db.$queryRaw<{ owner_id: string; project_id: string | null; what: string; written_by: string | null }[]>`
      SELECT "owner_id", "project_id", "what", "written_by" FROM "memory_write_queue"
      GROUP BY "owner_id", "project_id", "what", "written_by"
      ORDER BY ("written_by" = 'person') DESC NULLS LAST, MIN("created_at")`;
    return rows.map((r) => ({ ownerId: r.owner_id, projectId: r.project_id, what: r.what as MemoryBucket['what'], writtenBy: r.written_by as NoteWrittenBy | null }));
  }

  /**
   * Takes the bucket's `limit` oldest writes out of the queue, oldest first. Rows another instance is
   * taking at the same moment are skipped (`SKIP LOCKED`), so the two colours never write one twice.
   */
  async claim(b: MemoryBucket, limit: number): Promise<QueuedMemoryWrite[]> {
    if (limit <= 0) return [];
    const rows = await this.db.$queryRaw<RawQueued[]>`
      DELETE FROM "memory_write_queue" WHERE "id" IN (
        SELECT "id" FROM "memory_write_queue"
        WHERE "owner_id" = ${b.ownerId} AND "project_id" IS NOT DISTINCT FROM ${b.projectId}::text AND "what" = ${b.what}
          AND "written_by" IS NOT DISTINCT FROM ${b.writtenBy}::text
        ORDER BY "created_at", "id" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING *`;
    return rows.map(mapQueued).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id));
  }

  /**
   * How many of the owner's projects had work going on since `since` (TER-1137, the global cap): an
   * automatic run alive or started in the window, or a tab that reported a state in it. Notes themselves
   * never count, so writing into many projects does not raise the cap it is checked against.
   */
  async activeProjectCount(ownerId: string, since: Date): Promise<number> {
    const rows = await this.db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM "projects" p
      WHERE p."owner_id" = ${ownerId} AND (
        EXISTS (SELECT 1 FROM "automation_runs" r WHERE r."project_id" = p."id" AND (r."created_at" >= ${since} OR r."heartbeat_at" >= ${since} OR r."ended_at" >= ${since}))
        OR EXISTS (SELECT 1 FROM "tabs" t WHERE t."project_id" = p."id" AND t."state_at" >= ${since}))`;
    return Number(rows[0]!.count);
  }
}
