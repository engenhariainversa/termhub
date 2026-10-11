import type { PrismaClient } from '../prisma.js';

/** When a user ("Pausar tudo") and a project were paused; null = not paused. */
export interface PauseState {
  user: Date | null;
  project: Date | null;
}

/**
 * The automatic work's pause switch (agentic board, spec D24): one timestamp per user, one per project.
 * `pause*` keeps the first timestamp when it is already set (pausing twice is one pause) and says whether
 * this call is the one that paused; `resume*` clears it and says whether it was paused.
 */
export class AutomationPausesRepository {
  constructor(private db: PrismaClient) {}

  async state(ownerId: string | null, projectId: string): Promise<PauseState> {
    const [user, project] = await Promise.all([
      ownerId ? this.db.user.findUnique({ where: { id: ownerId }, select: { automationPausedAt: true } }) : null,
      this.db.project.findUnique({ where: { id: projectId }, select: { automationPausedAt: true } }),
    ]);
    return { user: user?.automationPausedAt ?? null, project: project?.automationPausedAt ?? null };
  }

  async userPausedAt(userId: string): Promise<Date | null> {
    const row = await this.db.user.findUnique({ where: { id: userId }, select: { automationPausedAt: true } });
    return row?.automationPausedAt ?? null;
  }

  /** The projects of the scope that are paused on their own (`ownerId` null = every project, an admin's view). */
  async pausedProjects(ownerId: string | null): Promise<Array<{ id: string; paused_at: Date }>> {
    const rows = await this.db.project.findMany({
      where: { automationPausedAt: { not: null }, ...(ownerId ? { ownerId } : {}) },
      select: { id: true, automationPausedAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.flatMap((r) => (r.automationPausedAt ? [{ id: r.id, paused_at: r.automationPausedAt }] : []));
  }

  async pauseUser(userId: string, at: Date): Promise<{ paused_at: Date; fresh: boolean }> {
    const { count } = await this.db.user.updateMany({ where: { id: userId, automationPausedAt: null }, data: { automationPausedAt: at } });
    const row = await this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { automationPausedAt: true } });
    return { paused_at: row.automationPausedAt ?? at, fresh: count === 1 };
  }

  async resumeUser(userId: string): Promise<boolean> {
    const { count } = await this.db.user.updateMany({ where: { id: userId, automationPausedAt: { not: null } }, data: { automationPausedAt: null } });
    return count === 1;
  }

  async pauseProject(projectId: string, at: Date): Promise<{ paused_at: Date; fresh: boolean }> {
    const { count } = await this.db.project.updateMany({ where: { id: projectId, automationPausedAt: null }, data: { automationPausedAt: at } });
    const row = await this.db.project.findUniqueOrThrow({ where: { id: projectId }, select: { automationPausedAt: true } });
    return { paused_at: row.automationPausedAt ?? at, fresh: count === 1 };
  }

  async resumeProject(projectId: string): Promise<boolean> {
    const { count } = await this.db.project.updateMany({ where: { id: projectId, automationPausedAt: { not: null } }, data: { automationPausedAt: null } });
    return count === 1;
  }
}
