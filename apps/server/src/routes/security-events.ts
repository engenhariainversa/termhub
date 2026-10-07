import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { SECURITY_EVENT_ACTIONS, SECURITY_EVENT_GROUPS, type SecurityEvent, type SecurityEventFilter } from '../db/repositories/security-events.js';
import { audit } from '../auth/audit.js';
import { badRequest } from '../lib/errors.js';

/** One screen of the trail. */
export const SECURITY_EVENTS_PAGE_MAX = 200;
/** The most rows one export carries; a wider window is narrowed by date. */
export const SECURITY_EVENTS_EXPORT_MAX = 10_000;

const actionFilter = z
  .string()
  .max(64)
  .refine((v) => (SECURITY_EVENT_ACTIONS as readonly string[]).includes(v) || SECURITY_EVENT_GROUPS.includes(v), 'unknown action');

const filterQuery = z.object({
  action: actionFilter.optional(),
  actor_id: z.string().min(1).max(64).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const listQuery = filterQuery.extend({
  limit: z.coerce.number().int().min(1).max(SECURITY_EVENTS_PAGE_MAX).default(50),
  /** the `next` an earlier page returned */
  before: z.string().max(128).optional(),
});

const exportQuery = filterQuery.extend({ format: z.enum(['csv', 'json']).default('csv') });

/** `<iso date>_<id>`: the keyset cursor of the last row a page showed. */
const cursorOf = (e: SecurityEvent) => `${e.created_at}_${e.id}`;

function parseCursor(raw: string): SecurityEventFilter['before'] {
  const at = raw.indexOf('_');
  const created_at = new Date(raw.slice(0, at));
  const id = raw.slice(at + 1);
  if (at <= 0 || Number.isNaN(created_at.getTime()) || !/^[a-z0-9]{1,64}$/.test(id)) throw badRequest('Cursor inválido');
  return { created_at, id };
}

function filterOf(q: z.infer<typeof filterQuery>): SecurityEventFilter {
  return { action: q.action, actor_id: q.actor_id, q: q.q, from: q.from, to: q.to };
}

export const CSV_COLUMNS = ['created_at', 'action', 'actor_id', 'actor_email', 'view_as_id', 'target_type', 'target_id', 'target_label', 'ip', 'meta'] as const;

/**
 * RFC 4180 quoting, plus a guard against formula injection: a spreadsheet would run a cell that
 * starts with `=`, `+`, `-`, `@`, tab or CR, and a target label is text someone else chose.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: SecurityEvent[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * The security trail (TER-577), Settings → Auditoria. Guarded as resource "security_events": admins see
 * it, and any role an admin grants `security_events:read`. Instance-wide on purpose — it is not scoped
 * by owner, and the "view as" switch does not narrow it.
 */
export async function securityEventRoutes(app: FastifyInstance, repos: Repositories, opts: { retentionDays: number }) {
  app.get('/', async (request) => {
    const q = listQuery.parse(request.query);
    const events = await repos.securityEvents.list({ ...filterOf(q), before: q.before ? parseCursor(q.before) : undefined }, q.limit + 1);
    const page = events.slice(0, q.limit);
    return {
      events: page,
      next: events.length > q.limit ? cursorOf(page[page.length - 1]!) : null,
      actions: SECURITY_EVENT_ACTIONS,
      retention_days: opts.retentionDays,
    };
  });

  app.get('/export', async (request, reply) => {
    const q = exportQuery.parse(request.query);
    const events = await repos.securityEvents.list(filterOf(q), SECURITY_EVENTS_EXPORT_MAX);
    // Who took a copy of the trail is part of the trail.
    await audit(repos, request, 'audit.export', {
      meta: { format: q.format, rows: events.length, filter: { action: q.action ?? null, actor_id: q.actor_id ?? null, q: q.q ?? null, from: q.from?.toISOString() ?? null, to: q.to?.toISOString() ?? null } },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="termhub-security-${stamp}.${q.format}"`);
    reply.header('cache-control', 'no-store');
    if (q.format === 'json') {
      reply.type('application/json; charset=utf-8');
      return JSON.stringify({ events, truncated: events.length >= SECURITY_EVENTS_EXPORT_MAX }, null, 2);
    }
    reply.type('text/csv; charset=utf-8');
    return toCsv(events);
  });
}
