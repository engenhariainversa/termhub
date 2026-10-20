import type { PrismaClient } from '../prisma.js';
import type { TabState } from './types.js';

/**
 * The reads behind the admin troubleshooting endpoints (TER-1092): technical metadata of ONE user in a
 * bounded window, picked field by field. Never message, prompt or answer content, terminal screens,
 * attachments, e-mail, tokens or IPs — the `select`s below are the guarantee, not a filter applied after.
 */

export interface SupportWindow {
  from: Date;
  to: Date;
}

/** A user found by name or e-mail: the opaque id and the name only, never the e-mail. */
export interface SupportUserHit {
  user_id: string;
  name: string;
  created_at: string;
  last_login_at: string | null;
}

export interface SupportRequest {
  at: string;
  kind: string;
  method: string;
  /** the route pattern (`/api/tabs/:id`), never a query string */
  route: string;
  status: number | null;
  duration_ms: number | null;
  client: string | null;
}

export interface SupportTab {
  tab_id: string;
  kind: string;
  /** the agent its hooks last reported (claude, codex, cursor…); null when none ever did */
  agent: string | null;
  machine_id: string;
  /** the machine's name in termhub, as its owner gave it: never the hostname or an address */
  machine_name: string;
  state: TabState | null;
  state_at: string | null;
  created_at: string;
  /** monitor events in the window, counted by kind: never their text */
  events: Partial<Record<TabState, number>>;
}

export interface SupportError {
  at: string;
  source: 'http' | 'mcp';
  method?: string;
  route?: string;
  status?: number | null;
  tool?: string;
  error_code?: string | null;
  duration_ms: number | null;
}

export interface SupportClient {
  client: string;
  os: string | null;
  requests: number;
  last_at: string;
}

export interface SupportDevice {
  platform: string;
  model: string;
  os_version: string;
  app_version: string;
  status: string;
  last_seen_at: string | null;
}

/** The chat's gate answers that are not failures of the tool: a card waiting, refused or expired. */
const GATE_CODE_PREFIX = 'CONFIRMATION_';

export class SupportRepository {
  constructor(private db: PrismaClient) {}

  /** Case-insensitive substring of the name or the e-mail; the e-mail is matched, never returned. */
  async searchUsers(q: string, limit: number): Promise<SupportUserHit[]> {
    const contains = { contains: q, mode: 'insensitive' as const };
    const rows = await this.db.user.findMany({
      where: { OR: [{ name: contains }, { email: contains }] },
      select: { id: true, name: true, createdAt: true, lastLoginAt: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((u) => ({ user_id: u.id, name: u.name, created_at: u.createdAt.toISOString(), last_login_at: u.lastLoginAt?.toISOString() ?? null }));
  }

  async findUser(id: string): Promise<{ id: string; name: string } | undefined> {
    return (await this.db.user.findUnique({ where: { id }, select: { id: true, name: true } })) ?? undefined;
  }

  /** Newest first; `limit` + 1 rows are read so the caller can say the list was cut. */
  async requests(userId: string, w: SupportWindow, routePrefix: string | undefined, limit: number): Promise<SupportRequest[]> {
    const rows = await this.db.accessLog.findMany({
      where: { userId, createdAt: { gte: w.from, lt: w.to }, ...(routePrefix ? { route: { startsWith: routePrefix } } : {}) },
      select: { createdAt: true, kind: true, method: true, route: true, status: true, durationMs: true, client: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((r) => ({ at: r.createdAt.toISOString(), kind: r.kind, method: r.method, route: r.route, status: r.status, duration_ms: r.durationMs, client: r.client }));
  }

  /**
   * The user's tabs that existed in the window: still open now (a closed tab's row is gone) and created
   * before its end. Tabs follow their project's owner.
   */
  async tabs(userId: string, w: SupportWindow, limit: number): Promise<SupportTab[]> {
    const rows = await this.db.tab.findMany({
      where: { project: { ownerId: userId }, createdAt: { lt: w.to } },
      select: { id: true, kind: true, stateTool: true, state: true, stateAt: true, createdAt: true, machineId: true, machine: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    const counts = rows.length
      ? await this.db.tabEvent.groupBy({
          by: ['tabId', 'kind'],
          where: { tabId: { in: rows.map((r) => r.id) }, createdAt: { gte: w.from, lt: w.to } },
          _count: { _all: true },
        })
      : [];
    const events = new Map<string, Partial<Record<TabState, number>>>();
    for (const c of counts) {
      const byKind = events.get(c.tabId) ?? {};
      byKind[c.kind as TabState] = c._count._all;
      events.set(c.tabId, byKind);
    }
    return rows.map((r) => ({
      tab_id: r.id,
      kind: r.kind,
      agent: r.stateTool,
      machine_id: r.machineId,
      machine_name: r.machine.name,
      state: (r.state as TabState | null) ?? null,
      state_at: r.stateAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      events: events.get(r.id) ?? {},
    }));
  }

  /** 5xx answers to the user's requests and failed MCP calls of their tokens, newest first. */
  async errors(userId: string, w: SupportWindow, limit: number): Promise<SupportError[]> {
    const [http, mcp] = await Promise.all([
      this.db.accessLog.findMany({
        where: { userId, createdAt: { gte: w.from, lt: w.to }, status: { gte: 500 } },
        select: { createdAt: true, method: true, route: true, status: true, durationMs: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
      this.db.apiTokenEvent.findMany({
        where: { token: { userId }, createdAt: { gte: w.from, lt: w.to }, ok: false, NOT: { errorCode: { startsWith: GATE_CODE_PREFIX } } },
        select: { createdAt: true, tool: true, errorCode: true, durationMs: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    ]);
    const out: SupportError[] = [
      ...http.map((r) => ({ at: r.createdAt.toISOString(), source: 'http' as const, method: r.method, route: r.route, status: r.status, duration_ms: r.durationMs })),
      ...mcp.map((r) => ({ at: r.createdAt.toISOString(), source: 'mcp' as const, tool: r.tool, error_code: r.errorCode, duration_ms: r.durationMs })),
    ];
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  /** The clients (and systems) the user's requests came from in the window, most recent first. */
  async clients(userId: string, w: SupportWindow): Promise<SupportClient[]> {
    const rows = await this.db.accessLog.groupBy({
      by: ['client', 'os'],
      where: { userId, createdAt: { gte: w.from, lt: w.to }, client: { not: null } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return rows
      .map((r) => ({ client: r.client!, os: r.os, requests: r._count._all, last_at: r._max.createdAt?.toISOString() ?? '' }))
      .sort((a, b) => b.last_at.localeCompare(a.last_at));
  }

  /** The user's paired phones: platform, model and versions only (no name, address or keys). */
  async devices(userId: string): Promise<SupportDevice[]> {
    const rows = await this.db.device.findMany({
      where: { userId },
      select: { platform: true, model: true, osVersion: true, appVersion: true, status: true, lastSeenAt: true },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    return rows.map((d) => ({ platform: d.platform, model: d.model, os_version: d.osVersion, app_version: d.appVersion, status: d.status, last_seen_at: d.lastSeenAt?.toISOString() ?? null }));
  }
}
