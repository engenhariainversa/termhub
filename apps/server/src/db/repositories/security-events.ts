import type { PrismaClient } from '../prisma.js';
import type { Prisma, SecurityEvent as PrismaSecurityEvent } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

/**
 * Every action the security trail records (TER-577). The web names each one in pt-BR; the group before
 * the dot is what the screen's filter offers ("auth" matches every `auth.*`).
 */
export const SECURITY_EVENT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.view_as',
  'auth.view_as_end',
  'user.invite',
  'user.role_change',
  'user.delete',
  'user.deletion_requested',
  'user.deletion_canceled',
  'role.create',
  'role.update',
  'role.delete',
  'role.permission_toggle',
  'machine.create',
  'machine.delete',
  'machine.transfer',
  'machine.agent_token_rotate',
  'api_token.create',
  'api_token.revoke',
  'integration.create',
  'integration.delete',
  'terminal.input',
  'terminal.view_as_open',
  'audit.export',
] as const;

export type SecurityEventAction = (typeof SECURITY_EVENT_ACTIONS)[number];

export const SECURITY_EVENT_GROUPS = [...new Set(SECURITY_EVENT_ACTIONS.map((a) => a.split('.')[0]!))];

export interface SecurityEventInput {
  actor_id?: string | null;
  actor_email?: string | null;
  view_as_id?: string | null;
  action: SecurityEventAction;
  target_type?: string | null;
  target_id?: string | null;
  target_label?: string | null;
  ip?: string | null;
  /** Ids, names, counts and flags only: never typed text, passwords, codes or tokens. */
  meta?: Record<string, unknown>;
}

export interface SecurityEvent {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  view_as_id: string | null;
  action: SecurityEventAction;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  ip: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface SecurityEventFilter {
  /** an exact action (`auth.login`) or a group (`auth`) */
  action?: string;
  actor_id?: string;
  /** case-insensitive substring of the actor's e-mail, the target's label or the IP */
  q?: string;
  from?: Date;
  to?: Date;
  /** keyset cursor: rows strictly older than this one */
  before?: { created_at: Date; id: string };
}

const mapSecurityEvent = (e: PrismaSecurityEvent): SecurityEvent => ({
  id: e.id,
  actor_id: e.actorId,
  actor_email: e.actorEmail,
  view_as_id: e.viewAsId,
  action: e.action as SecurityEventAction,
  target_type: e.targetType,
  target_id: e.targetId,
  target_label: e.targetLabel,
  ip: e.ip,
  meta: (e.meta ?? {}) as Record<string, unknown>,
  created_at: e.createdAt.toISOString(),
});

function whereOf(f: SecurityEventFilter): Prisma.SecurityEventWhereInput {
  const and: Prisma.SecurityEventWhereInput[] = [];
  if (f.action) and.push(f.action.includes('.') ? { action: f.action } : { action: { startsWith: `${f.action}.` } });
  if (f.actor_id) and.push({ actorId: f.actor_id });
  if (f.q) {
    const contains = { contains: f.q, mode: 'insensitive' as const };
    and.push({ OR: [{ actorEmail: contains }, { targetLabel: contains }, { ip: contains }] });
  }
  if (f.from) and.push({ createdAt: { gte: f.from } });
  if (f.to) and.push({ createdAt: { lt: f.to } });
  if (f.before) {
    and.push({ OR: [{ createdAt: { lt: f.before.created_at } }, { createdAt: f.before.created_at, id: { lt: f.before.id } }] });
  }
  return and.length ? { AND: and } : {};
}

/** Append-only by design: no update method, and the table's trigger refuses one anyway. */
export class SecurityEventsRepository {
  constructor(private db: PrismaClient) {}

  async record(e: SecurityEventInput): Promise<void> {
    await this.db.securityEvent.create({
      data: {
        id: newId(),
        actorId: e.actor_id ?? null,
        actorEmail: e.actor_email ?? null,
        viewAsId: e.view_as_id ?? null,
        action: e.action,
        targetType: e.target_type ?? null,
        targetId: e.target_id ?? null,
        targetLabel: e.target_label ?? null,
        ip: e.ip ?? null,
        meta: (e.meta ?? {}) as never,
      },
    });
  }

  /** Newest first. */
  async list(filter: SecurityEventFilter, limit: number): Promise<SecurityEvent[]> {
    const rows = await this.db.securityEvent.findMany({
      where: whereOf(filter),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(mapSecurityEvent);
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const r = await this.db.securityEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  }
}
