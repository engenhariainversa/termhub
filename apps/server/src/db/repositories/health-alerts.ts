import type { PrismaClient } from '../prisma.js';
import type { ProjectHealthAlert as PrismaAlert } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import type { HealthDetail, HealthLevel } from '../../health/signals.js';
import type { HealthSignal } from '../../setup/schema.js';

/** TER-1121: one sign of stalled work the health watcher saw, and where its episode is. */
export interface HealthAlert {
  id: string;
  project_id: string;
  signal: HealthSignal;
  subject: string;
  level: HealthLevel;
  detail: HealthDetail;
  since_at: string;
  first_seen_at: string;
  last_seen_at: string;
  opened_at: string | null;
  woken_at: string | null;
  noticed_at: string | null;
  resolved_at: string | null;
}

export interface SeenAlert {
  signal: HealthSignal;
  subject: string;
  level: HealthLevel;
  detail: HealthDetail;
  /** null = from the first sighting */
  since: Date | null;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const map = (r: PrismaAlert): HealthAlert => ({
  id: r.id, project_id: r.projectId, signal: r.signal as HealthSignal, subject: r.subject, level: r.level as HealthLevel,
  detail: (r.detail ?? {}) as HealthDetail, since_at: r.sinceAt.toISOString(), first_seen_at: r.firstSeenAt.toISOString(),
  last_seen_at: r.lastSeenAt.toISOString(), opened_at: iso(r.openedAt), woken_at: iso(r.wokenAt), noticed_at: iso(r.noticedAt), resolved_at: iso(r.resolvedAt),
});

/** Resolved alerts are kept this long (the panel's "resolvido" and the tests), then purged. */
export const HEALTH_ALERTS_KEPT_MS = 30 * 24 * 3600_000;

/**
 * The health watcher's alerts. One row per (project, signal, subject): a sign seen again after it was resolved
 * starts a new episode on the same row, so "once per occurrence" is the episode's claims (`claimWake`,
 * `claimNotice`), which only one caller wins — both colours sweep.
 */
export class HealthAlertsRepository {
  constructor(private db: PrismaClient) {}

  /** The project's alerts still running (open or not yet past their minutes). */
  async listUnresolved(projectId: string): Promise<HealthAlert[]> {
    const rows = await this.db.projectHealthAlert.findMany({ where: { projectId, resolvedAt: null }, orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }] });
    return rows.map(map);
  }

  /** The project's open alerts (past their minutes, not resolved), oldest first: the panel and `get_project_health`. */
  async listOpen(projectId: string): Promise<HealthAlert[]> {
    const rows = await this.db.projectHealthAlert.findMany({ where: { projectId, resolvedAt: null, openedAt: { not: null } }, orderBy: [{ openedAt: 'asc' }, { id: 'asc' }] });
    return rows.map(map);
  }

  /** Open alerts of several projects (the daily summary). */
  async listOpenByProjects(projectIds: string[]): Promise<HealthAlert[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.db.projectHealthAlert.findMany({ where: { projectId: { in: projectIds }, resolvedAt: null, openedAt: { not: null } }, orderBy: [{ openedAt: 'asc' }, { id: 'asc' }] });
    return rows.map(map);
  }

  /**
   * Records a sighting: a new row, a running episode refreshed (detail, level, last seen; `since` only moves
   * when the snapshot tells a new one), or a resolved row reopened as a new episode with its claims cleared.
   */
  async seen(projectId: string, a: SeenAlert, now = new Date()): Promise<HealthAlert> {
    const where = { projectId_signal_subject: { projectId, signal: a.signal, subject: a.subject } };
    const current = await this.db.projectHealthAlert.findUnique({ where });
    const detail = a.detail as object;
    if (!current) {
      try {
        return map(await this.db.projectHealthAlert.create({ data: { id: newId(), projectId, signal: a.signal, subject: a.subject, level: a.level, detail, sinceAt: a.since ?? now, firstSeenAt: now, lastSeenAt: now } }));
      } catch {
        // the other colour created it in between
        return map(await this.db.projectHealthAlert.findUniqueOrThrow({ where }));
      }
    }
    if (current.resolvedAt) {
      // a new episode: only the caller that still sees it resolved restarts it
      await this.db.projectHealthAlert.updateMany({
        where: { id: current.id, resolvedAt: current.resolvedAt },
        data: { level: a.level, detail, sinceAt: a.since ?? now, firstSeenAt: now, lastSeenAt: now, openedAt: null, wokenAt: null, noticedAt: null, resolvedAt: null },
      });
    } else {
      await this.db.projectHealthAlert.update({ where: { id: current.id }, data: { level: a.level, detail, lastSeenAt: now, ...(a.since ? { sinceAt: a.since } : {}) } });
    }
    return map(await this.db.projectHealthAlert.findUniqueOrThrow({ where }));
  }

  /** Marks an alert open (past its minutes); true for the caller that did. */
  async open(id: string, now = new Date()): Promise<boolean> {
    const { count } = await this.db.projectHealthAlert.updateMany({ where: { id, openedAt: null, resolvedAt: null }, data: { openedAt: now } });
    return count === 1;
  }

  /** The signs no longer seen: their episode ends. Answers how many. */
  async resolve(ids: string[], now = new Date()): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.db.projectHealthAlert.updateMany({ where: { id: { in: ids }, resolvedAt: null }, data: { resolvedAt: now } });
    return count;
  }

  /** The chat's wake for these open alerts: answers the ids this caller won. */
  async claimWake(ids: string[], now = new Date()): Promise<string[]> {
    const won: string[] = [];
    for (const id of ids) {
      const { count } = await this.db.projectHealthAlert.updateMany({ where: { id, wokenAt: null, resolvedAt: null }, data: { wokenAt: now } });
      if (count === 1) won.push(id);
    }
    return won;
  }

  /** A wake that could not start is handed back, so the next sweep tries again. */
  async releaseWake(ids: string[]): Promise<void> {
    if (ids.length) await this.db.projectHealthAlert.updateMany({ where: { id: { in: ids } }, data: { wokenAt: null } });
  }

  /** The person's push for these open alerts: answers the ids this caller won. */
  async claimNotice(ids: string[], now = new Date()): Promise<string[]> {
    const won: string[] = [];
    for (const id of ids) {
      const { count } = await this.db.projectHealthAlert.updateMany({ where: { id, noticedAt: null, resolvedAt: null }, data: { noticedAt: now } });
      if (count === 1) won.push(id);
    }
    return won;
  }

  async purgeResolvedBefore(cutoff: Date): Promise<number> {
    const { count } = await this.db.projectHealthAlert.deleteMany({ where: { resolvedAt: { lt: cutoff } } });
    return count;
  }
}
