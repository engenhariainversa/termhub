import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapTicket, type Ticket, type TaskStatus } from './types.js';

/** A setup ticket source's identity: the same integration may serve several scopes. */
export interface TicketSource {
  integration_id: string;
  scope: string;
}

export interface TicketUpsert {
  integration_id: string;
  scope: string;
  provider: 'github' | 'linear' | 'jira';
  sync_key: string;
  key: string;
  title: string;
  description: string | null;
  url: string;
  state: string;
  status: TaskStatus;
  meta: Record<string, unknown>;
}

/** Staging of synced tickets. They become cards only through an explicit import. */
export class TicketsRepository {
  constructor(private db: PrismaClient) {}

  /** The open tickets: an imported one its source no longer returns (`left_source_at`) only with `include_left`. */
  async listByProject(projectId: string, filter: { integration_id?: string; scope?: string; include_left?: boolean } = {}): Promise<Ticket[]> {
    const rows = await this.db.ticket.findMany({
      where: {
        projectId,
        ...(filter.integration_id ? { integrationId: filter.integration_id } : {}),
        ...(filter.scope ? { scope: filter.scope } : {}),
        ...(filter.include_left ? {} : { leftSourceAt: null }),
      },
      orderBy: [{ status: 'asc' }, { syncedAt: 'desc' }],
    });
    return rows.map(mapTicket);
  }

  async findByIds(projectId: string, ids: string[]): Promise<Ticket[]> {
    return (await this.db.ticket.findMany({ where: { projectId, id: { in: ids } } })).map(mapTicket);
  }

  async findByTaskId(taskId: string): Promise<Ticket | undefined> {
    const row = await this.db.ticket.findUnique({ where: { taskId } });
    return row ? mapTicket(row) : undefined;
  }

  /** Owner-scoped batch lookup, like the other repositories' `findByIdsForOwner` — another owner's
   * ticket (or one whose project belongs to someone else) is simply absent from the result. */
  async findByIdsForOwner(ids: string[], ownerId: string): Promise<Ticket[]> {
    if (ids.length === 0) return [];
    return (await this.db.ticket.findMany({ where: { id: { in: ids }, project: { ownerId } } })).map(mapTicket);
  }

  /** Exact key or URL (case-insensitive), or a key suffix ("/repo#12", "#12"), within these projects. */
  async findByKeyish(projectIds: string[], q: { key?: string; url?: string; suffix?: string }): Promise<Ticket[]> {
    if (projectIds.length === 0) return [];
    const where = q.url
      ? { url: { equals: q.url, mode: 'insensitive' as const } }
      : q.key
        ? { key: { equals: q.key, mode: 'insensitive' as const } }
        : { key: { endsWith: q.suffix ?? '', mode: 'insensitive' as const } };
    const rows = await this.db.ticket.findMany({ where: { projectId: { in: projectIds }, ...where }, orderBy: { key: 'asc' }, take: 20 });
    return rows.map(mapTicket);
  }

  /** Batch upsert; returns the tickets that already have a card (to refresh the mirror). */
  async upsertMany(projectId: string, items: TicketUpsert[]): Promise<{ created: number; updated: number; linked: Ticket[] }> {
    let created = 0;
    let updated = 0;
    const linked: Ticket[] = [];
    const now = new Date();
    for (const t of items) {
      const existing = await this.db.ticket.findUnique({ where: { projectId_syncKey: { projectId, syncKey: t.sync_key } } });
      const data = {
        integrationId: t.integration_id,
        scope: t.scope,
        provider: t.provider,
        key: t.key,
        title: t.title,
        description: t.description,
        url: t.url,
        state: t.state,
        status: t.status,
        meta: t.meta as object,
        syncedAt: now,
        // back in its source (reopened, or in the filter again): it is open there once more
        leftSourceAt: null,
      };
      if (!existing) {
        await this.db.ticket.create({ data: { id: newId(), projectId, syncKey: t.sync_key, ...data } });
        created++;
        continue;
      }
      const changed =
        existing.title !== t.title || (existing.description ?? null) !== t.description || existing.state !== t.state || existing.url !== t.url || existing.key !== t.key;
      const row = await this.db.ticket.update({ where: { id: existing.id }, data });
      if (changed) updated++;
      if (row.taskId) linked.push(mapTicket(row));
    }
    return { created, updated, linked };
  }

  async linkTask(ticketId: string, taskId: string): Promise<void> {
    await this.db.ticket.update({ where: { id: ticketId }, data: { taskId } });
  }

  async unlinkTask(taskId: string): Promise<void> {
    await this.db.ticket.updateMany({ where: { taskId }, data: { taskId: null } });
  }

  /** Non-imported tickets of this source that left it; with legacyNullScope, also the integration's pre-scope rows. */
  async pruneMissing(projectId: string, source: TicketSource, keepSyncKeys: string[], legacyNullScope: boolean): Promise<number> {
    const r = await this.db.ticket.deleteMany({
      where: {
        projectId,
        integrationId: source.integration_id,
        taskId: null,
        syncKey: { notIn: keepSyncKeys },
        ...(legacyNullScope ? { OR: [{ scope: source.scope }, { scope: null }] } : { scope: source.scope }),
      },
    });
    return r.count;
  }

  /**
   * Imported tickets of this source that it no longer returns and that are not marked yet (TER-718):
   * the import keeps their row, so pruneMissing never touches them. Oldest sync first.
   */
  async listLeftImported(projectId: string, source: TicketSource, keepSyncKeys: string[], legacyNullScope: boolean, take: number): Promise<Ticket[]> {
    const rows = await this.db.ticket.findMany({
      where: {
        projectId,
        integrationId: source.integration_id,
        taskId: { not: null },
        leftSourceAt: null,
        syncKey: { notIn: keepSyncKeys },
        ...(legacyNullScope ? { OR: [{ scope: source.scope }, { scope: null }] } : { scope: source.scope }),
      },
      orderBy: { syncedAt: 'asc' },
      take,
    });
    return rows.map(mapTicket);
  }

  /**
   * Marks a ticket as gone from its source, with what the provider says of it now when it answered
   * (`fresh`; its sync key and source stay). Without `fresh`, the last known fields stay.
   */
  async markLeftSource(ticketId: string, fresh?: Omit<TicketUpsert, 'integration_id' | 'scope' | 'sync_key' | 'provider'>): Promise<Ticket> {
    const now = new Date();
    const row = await this.db.ticket.update({
      where: { id: ticketId },
      data: {
        leftSourceAt: now,
        ...(fresh
          ? { key: fresh.key, title: fresh.title, description: fresh.description, url: fresh.url, state: fresh.state, status: fresh.status, meta: fresh.meta as object, syncedAt: now }
          : {}),
      },
    });
    return mapTicket(row);
  }

  /** A source removed from the setup: its non-imported tickets go; imported cards keep their link. */
  async pruneSource(projectId: string, source: TicketSource): Promise<number> {
    const r = await this.db.ticket.deleteMany({ where: { projectId, integrationId: source.integration_id, scope: source.scope, taskId: null } });
    return r.count;
  }
}
