import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { SecurityEventAction, SecurityEventInput } from '../db/repositories/security-events.js';
import { VIEW_AS_ALL, type Scope } from './scope.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows older than this leave the trail (SECURITY_EVENT_RETENTION_DAYS, config.securityEventRetentionDays). */
export function securityEventCutoff(retentionDays: number, now = Date.now()): Date {
  return new Date(now - retentionDays * DAY_MS);
}

export interface AuditTarget {
  type: string;
  id?: string | null;
  label?: string | null;
}

export interface AuditDetails {
  target?: AuditTarget;
  /** Ids, names, counts and flags only: never typed text, passwords, codes or tokens. */
  meta?: Record<string, unknown>;
  /** Who acted, when it is not the request's signed-in user (a sign-in: nobody is signed in yet); null = unknown. */
  actor?: Pick<User, 'id' | 'email'> | null;
}

/** The person an admin is viewing as ("*" for everyone), or null when acting as themselves. */
export function viewAsIdOf(scope: Scope | undefined): string | null {
  if (!scope) return null;
  if (scope.viewAs.kind === 'all') return VIEW_AS_ALL;
  if (scope.viewAs.kind === 'user') return scope.viewAs.user.id;
  return null;
}

/** Client address of a raw upgrade request: the real IP forwarded by nginx/Cloudflare, else the socket peer. */
export function upgradeIp(req: IncomingMessage): string | null {
  const forwarded = req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
}

/**
 * Writes one row of the security trail (TER-577). Best effort: a failed write is logged (the action
 * only, nothing of the payload) and never fails what the person was doing — a sign-in must not break
 * because the trail could not be written.
 */
export async function recordSecurityEvent(repos: Pick<Repositories, 'securityEvents'>, input: SecurityEventInput, log?: FastifyBaseLogger): Promise<void> {
  try {
    await repos.securityEvents.record(input);
  } catch (err) {
    log?.warn({ action: input.action, err: err instanceof Error ? err.message : String(err) }, 'security trail: write failed');
  }
}

/** `recordSecurityEvent` from an HTTP request: actor, view-as and IP come from the request. */
export function audit(repos: Pick<Repositories, 'securityEvents'>, request: FastifyRequest, action: SecurityEventAction, details: AuditDetails = {}): Promise<void> {
  // A sign-in names its own actor; whatever session the cookies still carried is not part of it.
  const own = details.actor === undefined;
  const actor = own ? request.user : details.actor;
  return recordSecurityEvent(
    repos,
    {
      actor_id: actor?.id ?? null,
      actor_email: actor?.email ?? null,
      view_as_id: own ? viewAsIdOf(request.scope) : null,
      action,
      target_type: details.target?.type ?? null,
      target_id: details.target?.id ?? null,
      target_label: details.target?.label ?? null,
      ip: request.ip || null,
      meta: details.meta,
    },
    request.log,
  );
}
