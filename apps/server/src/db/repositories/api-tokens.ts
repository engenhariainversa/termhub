import type { PrismaClient } from '../prisma.js';
import type { ApiToken as PrismaApiToken, Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import {
  assertScopesFor,
  PERSON_REVOKED_TOKEN_RETENTION_DAYS,
  SYSTEM_TOKEN_IDLE_DAYS,
  SYSTEM_TOKEN_ORIGINS,
  SYSTEM_TOKEN_RETENTION_DAYS,
  toScopes,
  type ApiTokenOrigin,
  type ApiTokenScope,
} from '../../auth/api-tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The name the concierge's tokens carry (chat/token.ts); here only to classify rows minted before `gated`. */
const LEGACY_CONCIERGE_NAME = 'concierge (automático)';

/** A personal API token as routes see it: never the hash, never the plain token. */
export interface ApiToken {
  id: string;
  user_id: string;
  name: string;
  scopes: ApiTokenScope[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  /** True when the token's writes pass the chat's confirmation gate — the concierge's, never a
   * person's own. */
  gated: boolean;
  /** The conversation this token was minted for — null for a person's own token, and for a
   * concierge token minted before tokens named their conversation. */
  chat_conversation_id: string | null;
  /** The tab this token was minted for — null for a person's own token or a concierge token
   * (spec 2026-09-27 agent-tab-mcp D1). */
  tab_id: string | null;
  /** Where it came from (TER-1191). */
  origin: ApiTokenOrigin;
  /** The project and machine it acts for, when it has one (a tab's, a project chat's); the names are read now. */
  project_id: string | null;
  project_name: string | null;
  machine_id: string | null;
  machine_name: string | null;
}

export type ApiTokenStatus = 'active' | 'expired' | 'revoked';

/** Settings → Tokens de API's filters (TER-1191). Every field narrows; an absent one does not. */
export interface ApiTokenFilter {
  origins?: ApiTokenOrigin[];
  status?: ApiTokenStatus;
  project_id?: string;
  machine_id?: string;
  scope?: ApiTokenScope;
  created_from?: Date;
  created_to?: Date;
  used_from?: Date;
  used_to?: Date;
  /** part of the name, case-insensitive */
  q?: string;
  /** keyset cursor: the last row of the previous page */
  before?: { created_at: Date; id: string };
}

/** One MCP tool call: metadata only (never typed text, screen content or prompts). */
export interface ApiTokenEventInput {
  token_id: string;
  tool: string;
  machine_id?: string | null;
  project_id?: string | null;
  tab_id?: string | null;
  attachment_id?: string | null;
  ok: boolean;
  error_code?: string | null;
  duration_ms: number;
}

/** One MCP call as Settings → Tokens de API shows it (TER-577): the names are read now, null once the row is gone. */
export interface ApiTokenEvent {
  id: string;
  tool: string;
  ok: boolean;
  error_code: string | null;
  duration_ms: number;
  machine_id: string | null;
  machine_name: string | null;
  project_id: string | null;
  project_name: string | null;
  tab_id: string | null;
  tab_name: string | null;
  attachment_id: string | null;
  created_at: string;
}

const TOUCH_INTERVAL_MS = 60_000;

/** The origin of a row, also for one the previous release minted without it (see the migration of TER-1191). */
export function originOf(t: Pick<PrismaApiToken, 'origin' | 'gated' | 'chatConversationId' | 'tabId' | 'name'>): ApiTokenOrigin {
  if (t.origin === 'person' || t.origin === 'concierge' || t.origin === 'tab' || t.origin === 'automation') return t.origin;
  if (t.tabId) return 'tab';
  if (t.gated || t.chatConversationId || t.name === LEGACY_CONCIERGE_NAME) return 'concierge';
  return 'person';
}

/** The rows of these origins, origin null included (classified the way `originOf` does). */
function originWhere(origins: readonly ApiTokenOrigin[]): Prisma.ApiTokenWhereInput {
  const legacy: Prisma.ApiTokenWhereInput[] = [];
  if (origins.includes('tab')) legacy.push({ tabId: { not: null } });
  if (origins.includes('concierge')) legacy.push({ tabId: null, OR: [{ gated: true }, { chatConversationId: { not: null } }, { name: LEGACY_CONCIERGE_NAME }] });
  if (origins.includes('person')) legacy.push({ tabId: null, gated: false, chatConversationId: null, name: { not: LEGACY_CONCIERGE_NAME } });
  return { OR: [{ origin: { in: [...origins] } }, ...(legacy.length ? [{ origin: null, OR: legacy }] : [])] };
}

function statusWhere(status: ApiTokenStatus, now: Date): Prisma.ApiTokenWhereInput {
  if (status === 'revoked') return { revokedAt: { not: null } };
  if (status === 'expired') return { revokedAt: null, expiresAt: { lte: now } };
  return activeWhere(now);
}

function filterWhere(userId: string, f: ApiTokenFilter, now: Date): Prisma.ApiTokenWhereInput {
  const and: Prisma.ApiTokenWhereInput[] = [{ userId }];
  if (f.origins?.length) and.push(originWhere(f.origins));
  if (f.status) and.push(statusWhere(f.status, now));
  if (f.project_id) and.push({ projectId: f.project_id });
  if (f.machine_id) and.push({ machineId: f.machine_id });
  if (f.scope) and.push({ scopes: { has: f.scope } });
  if (f.created_from || f.created_to) and.push({ createdAt: { ...(f.created_from ? { gte: f.created_from } : {}), ...(f.created_to ? { lt: f.created_to } : {}) } });
  if (f.used_from || f.used_to) and.push({ lastUsedAt: { not: null, ...(f.used_from ? { gte: f.used_from } : {}), ...(f.used_to ? { lt: f.used_to } : {}) } });
  if (f.q) and.push({ name: { contains: f.q, mode: 'insensitive' } });
  if (f.before) and.push({ OR: [{ createdAt: { lt: f.before.created_at } }, { createdAt: f.before.created_at, id: { lt: f.before.id } }] });
  return { AND: and };
}

type Names = { projects: Map<string, string>; machines: Map<string, string> };
const NO_NAMES: Names = { projects: new Map(), machines: new Map() };

const mapApiToken = (t: PrismaApiToken, names: Names = NO_NAMES): ApiToken => ({
  id: t.id,
  user_id: t.userId,
  name: t.name,
  scopes: toScopes(t.scopes),
  expires_at: t.expiresAt?.toISOString() ?? null,
  last_used_at: t.lastUsedAt?.toISOString() ?? null,
  revoked_at: t.revokedAt?.toISOString() ?? null,
  created_at: t.createdAt.toISOString(),
  gated: t.gated,
  chat_conversation_id: t.chatConversationId,
  tab_id: t.tabId,
  origin: originOf(t),
  project_id: t.projectId,
  project_name: t.projectId ? (names.projects.get(t.projectId) ?? null) : null,
  machine_id: t.machineId,
  machine_name: t.machineId ? (names.machines.get(t.machineId) ?? null) : null,
});

const activeWhere = (now: Date) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

export class ApiTokensRepository {
  constructor(private db: PrismaClient) {}

  async listByUser(userId: string): Promise<ApiToken[]> {
    const rows = await this.db.apiToken.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map((r) => mapApiToken(r));
  }

  /** One page of `userId`'s tokens, newest first (TER-1191); `limit` rows at most, names resolved. */
  async list(userId: string, filter: ApiTokenFilter, limit: number, now = new Date()): Promise<ApiToken[]> {
    const rows = await this.db.apiToken.findMany({ where: filterWhere(userId, filter, now), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    return this.withNames(userId, rows);
  }

  private async withNames(userId: string, rows: PrismaApiToken[]): Promise<ApiToken[]> {
    const ids = (k: 'projectId' | 'machineId') => [...new Set(rows.map((r) => r[k]).filter((v): v is string => !!v))];
    const [projects, machines] = await Promise.all([this.projectNames(userId, ids('projectId')), this.machineNames(userId, ids('machineId'))]);
    return rows.map((r) => mapApiToken(r, { projects, machines }));
  }

  // Names only of the owner's own rows: a token's ids came from their own tab or conversation, and a row
  // that has since moved to someone else (a transferred machine) shows its id instead of a foreign name.
  private async projectNames(userId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.db.project.findMany({ where: { id: { in: ids }, ownerId: userId }, select: { id: true, name: true } });
    return new Map(rows.map((x) => [x.id, x.name]));
  }

  private async machineNames(userId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.db.machine.findMany({ where: { id: { in: ids }, ownerId: userId }, select: { id: true, name: true } });
    return new Map(rows.map((x) => [x.id, x.name]));
  }

  /** The projects and machines `userId`'s tokens name, for the screen's filter selects (TER-1191). */
  async facets(userId: string): Promise<{ projects: { id: string; name: string | null }[]; machines: { id: string; name: string | null }[] }> {
    const [p, m] = await Promise.all([
      this.db.apiToken.findMany({ where: { userId, projectId: { not: null } }, distinct: ['projectId'], select: { projectId: true } }),
      this.db.apiToken.findMany({ where: { userId, machineId: { not: null } }, distinct: ['machineId'], select: { machineId: true } }),
    ]);
    const pIds = p.map((x) => x.projectId!);
    const mIds = m.map((x) => x.machineId!);
    const [pn, mn] = await Promise.all([this.projectNames(userId, pIds), this.machineNames(userId, mIds)]);
    const byName = (a: { name: string | null }, b: { name: string | null }) => (a.name ?? '').localeCompare(b.name ?? '');
    return {
      projects: pIds.map((id) => ({ id, name: pn.get(id) ?? null })).sort(byName),
      machines: mIds.map((id) => ({ id, name: mn.get(id) ?? null })).sort(byName),
    };
  }

  /** The live system tokens "Revogar inativos" takes: unused (or never used) for SYSTEM_TOKEN_IDLE_DAYS. */
  private idleSystemWhere(userId: string, now: Date): Prisma.ApiTokenWhereInput {
    const idleSince = new Date(now.getTime() - SYSTEM_TOKEN_IDLE_DAYS * DAY_MS);
    return {
      AND: [
        { userId },
        originWhere(SYSTEM_TOKEN_ORIGINS),
        activeWhere(now),
        { OR: [{ lastUsedAt: { lt: idleSince } }, { lastUsedAt: null, createdAt: { lt: idleSince } }] },
      ],
    };
  }

  /** How many of `userId`'s system tokens are live, and how many of those are idle (TER-1191). */
  async systemSummary(userId: string, now = new Date()): Promise<{ active: number; idle: number }> {
    const [active, idle] = await Promise.all([
      this.db.apiToken.count({ where: { AND: [{ userId }, originWhere(SYSTEM_TOKEN_ORIGINS), activeWhere(now)] } }),
      this.db.apiToken.count({ where: this.idleSystemWhere(userId, now) }),
    ]);
    return { active, idle };
  }

  /** Revokes `userId`'s idle system tokens (TER-1191); a person's own tokens are never touched. */
  async revokeIdleSystem(userId: string, now = new Date()): Promise<number> {
    const { count } = await this.db.apiToken.updateMany({ where: this.idleSystemWhere(userId, now), data: { revokedAt: now } });
    return count;
  }

  /**
   * The retention of TER-1191: deletes system tokens revoked or expired more than SYSTEM_TOKEN_RETENTION_DAYS
   * ago and a person's own tokens revoked more than PERSON_REVOKED_TOKEN_RETENTION_DAYS ago. A token a tab
   * still names as its opener (`tabs.created_by_token_id`, the close_tab card reads it) stays while that tab
   * exists. Their events go by cascade, and are older than their own 30-day retention anyway.
   */
  async purgeStale(now = new Date()): Promise<number> {
    const systemCut = new Date(now.getTime() - SYSTEM_TOKEN_RETENTION_DAYS * DAY_MS);
    const personCut = new Date(now.getTime() - PERSON_REVOKED_TOKEN_RETENTION_DAYS * DAY_MS);
    const openers = await this.db.tab.findMany({ where: { createdByTokenId: { not: null } }, distinct: ['createdByTokenId'], select: { createdByTokenId: true } });
    const keep = openers.map((t) => t.createdByTokenId!);
    const { count } = await this.db.apiToken.deleteMany({
      where: {
        AND: [
          ...(keep.length ? [{ id: { notIn: keep } }] : []),
          {
            OR: [
              { AND: [originWhere(SYSTEM_TOKEN_ORIGINS), { OR: [{ revokedAt: { lt: systemCut } }, { revokedAt: null, expiresAt: { lt: systemCut } }] }] },
              { AND: [originWhere(['person']), { revokedAt: { lt: personCut } }] },
            ],
          },
        ],
      },
    });
    return count;
  }

  /** The live concierge tokens of one conversation (and, for the account-wide chat, the ones minted before
   *  tokens named their conversation): what `mintConciergeToken` revokes before minting the next. */
  async revokeLiveConcierge(userId: string, conversationId: string, opts: { accountWide?: boolean } = {}): Promise<number> {
    const conv: Prisma.ApiTokenWhereInput[] = [{ chatConversationId: conversationId }];
    if (opts.accountWide) conv.push({ chatConversationId: null });
    const { count } = await this.db.apiToken.updateMany({
      where: { AND: [{ userId, revokedAt: null, tabId: null }, originWhere(['concierge']), { OR: conv }] },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  /** Which of these ids are gated (concierge) tokens of `userId` — the close_tab card's one lookup. */
  async gatedIdsAmong(userId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.db.apiToken.findMany({ where: { userId, id: { in: ids }, gated: true }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  // The concierge mints its own token per conversation (one for the account-wide chat, one per
  // project chat, all live at once) and a tab token per agent tab (spec 2026-09-27 agent-tab-mcp
  // D13) — neither must count against the person's own token cap.
  async countActive(userId: string, now = new Date()): Promise<number> {
    return this.db.apiToken.count({ where: { userId, gated: false, tabId: null, ...activeWhere(now) } });
  }

  async create(
    userId: string,
    input: {
      name: string;
      scopes: ApiTokenScope[];
      expiresAt: Date | null;
      gated?: boolean;
      chatConversationId?: string | null;
      tabId?: string | null;
      /** Defaults from the kind: tab when tabId, concierge when gated or tied to a conversation, else person. */
      origin?: ApiTokenOrigin;
      projectId?: string | null;
      machineId?: string | null;
    },
    tokenHash: string,
  ): Promise<ApiToken> {
    assertScopesFor(input, input.scopes);
    const t = await this.db.apiToken.create({
      data: {
        id: newId(),
        userId,
        name: input.name,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        tokenHash,
        gated: input.gated ?? false,
        chatConversationId: input.chatConversationId ?? null,
        tabId: input.tabId ?? null,
        origin: input.origin ?? (input.tabId ? 'tab' : input.gated || input.chatConversationId ? 'concierge' : 'person'),
        projectId: input.projectId ?? null,
        machineId: input.machineId ?? null,
      },
    });
    return mapApiToken(t);
  }

  /** Revokes the user's token (idempotent: a second call keeps the first timestamp). Undefined when it isn't theirs. */
  async revoke(id: string, userId: string): Promise<ApiToken | undefined> {
    await this.db.apiToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    const t = await this.db.apiToken.findFirst({ where: { id, userId } });
    return t ? mapApiToken(t) : undefined;
  }

  /** Revokes every live concierge token of a conversation — used when "Nova conversa" archives it. */
  async revokeForConversation(conversationId: string): Promise<number> {
    const { count } = await this.db.apiToken.updateMany({ where: { chatConversationId: conversationId, revokedAt: null }, data: { revokedAt: new Date() } });
    return count;
  }

  /** Revokes a tab's live token(s) — used by `TabsRepository.delete` (spec 2026-09-27
   * agent-tab-mcp D6): a tab token dies with its tab, in the same transaction. */
  async revokeForTab(tabId: string): Promise<number> {
    const { count } = await this.db.apiToken.updateMany({ where: { tabId, revokedAt: null }, data: { revokedAt: new Date() } });
    return count;
  }

  /** Revokes the live tokens of several tabs at once — for a project or machine delete, whose tabs go by
   * database cascade rather than `TabsRepository.delete` (spec 2026-09-27 agent-tab-mcp D6). */
  async revokeForTabs(tabIds: string[]): Promise<number> {
    if (tabIds.length === 0) return 0;
    const { count } = await this.db.apiToken.updateMany({ where: { tabId: { in: tabIds }, revokedAt: null }, data: { revokedAt: new Date() } });
    return count;
  }

  /** Whether a tab still has a live (neither revoked nor expired) tab token — the account swap keeps the
   * tab's memory MCP on the resumed session only then (spec 2026-09-27 agent-tab-mcp D11). */
  async hasLiveForTab(tabId: string, now = new Date()): Promise<boolean> {
    return (await this.db.apiToken.count({ where: { tabId, ...activeWhere(now) } })) > 0;
  }

  /** The token for a presented secret's hash, when it is neither revoked nor expired. */
  async findActiveByHash(tokenHash: string, now = new Date()): Promise<ApiToken | undefined> {
    const t = await this.db.apiToken.findFirst({ where: { tokenHash, ...activeWhere(now) } });
    return t ? mapApiToken(t) : undefined;
  }

  /** Records a use; skips the write when the last one is under a minute old. */
  async touchLastUsed(id: string, now = new Date()): Promise<void> {
    await this.db.apiToken.updateMany({
      where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: new Date(now.getTime() - TOUCH_INTERVAL_MS) } }] },
      data: { lastUsedAt: now },
    });
  }

  async recordEvent(e: ApiTokenEventInput): Promise<void> {
    await this.db.apiTokenEvent.create({
      data: {
        id: newId(),
        tokenId: e.token_id,
        tool: e.tool,
        machineId: e.machine_id ?? null,
        projectId: e.project_id ?? null,
        tabId: e.tab_id ?? null,
        attachmentId: e.attachment_id ?? null,
        ok: e.ok,
        errorCode: e.error_code ?? null,
        durationMs: e.duration_ms,
      },
    });
  }

  /**
   * The newest calls made with one of `userId`'s own tokens; undefined when the token is not theirs.
   * Names come from the rows as they are now (a call keeps only ids).
   */
  async listEvents(tokenId: string, userId: string, limit: number): Promise<ApiTokenEvent[] | undefined> {
    const token = await this.db.apiToken.findFirst({ where: { id: tokenId, userId }, select: { id: true } });
    if (!token) return undefined;
    const rows = await this.db.apiTokenEvent.findMany({ where: { tokenId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    const ids = (k: 'machineId' | 'projectId' | 'tabId') => [...new Set(rows.map((r) => r[k]).filter((v): v is string => !!v))];
    const [machines, projects, tabs] = await Promise.all([
      this.db.machine.findMany({ where: { id: { in: ids('machineId') } }, select: { id: true, name: true } }),
      this.db.project.findMany({ where: { id: { in: ids('projectId') } }, select: { id: true, name: true } }),
      this.db.tab.findMany({ where: { id: { in: ids('tabId') } }, select: { id: true, name: true } }),
    ]);
    const nameOf = (list: { id: string; name: string }[]) => new Map(list.map((x) => [x.id, x.name]));
    const [m, p, t] = [nameOf(machines), nameOf(projects), nameOf(tabs)];
    return rows.map((r) => ({
      id: r.id,
      tool: r.tool,
      ok: r.ok,
      error_code: r.errorCode,
      duration_ms: r.durationMs,
      machine_id: r.machineId,
      machine_name: r.machineId ? (m.get(r.machineId) ?? null) : null,
      project_id: r.projectId,
      project_name: r.projectId ? (p.get(r.projectId) ?? null) : null,
      tab_id: r.tabId,
      tab_name: r.tabId ? (t.get(r.tabId) ?? null) : null,
      attachment_id: r.attachmentId,
      created_at: r.createdAt.toISOString(),
    }));
  }

  async purgeEventsBefore(cutoff: Date): Promise<number> {
    const r = await this.db.apiTokenEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  }
}
