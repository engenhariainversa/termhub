import type { PrismaClient } from '../prisma.js';
import type { ApiToken as PrismaApiToken } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { toScopes, type ApiTokenScope } from '../../auth/api-tokens.js';

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

const mapApiToken = (t: PrismaApiToken): ApiToken => ({
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
});

const activeWhere = (now: Date) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

export class ApiTokensRepository {
  constructor(private db: PrismaClient) {}

  async listByUser(userId: string): Promise<ApiToken[]> {
    const rows = await this.db.apiToken.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map(mapApiToken);
  }

  // The concierge mints its own token per conversation (one for the account-wide chat, one per
  // project chat, all live at once) and a tab token per agent tab (spec 2026-09-27 agent-tab-mcp
  // D13) — neither must count against the person's own token cap.
  async countActive(userId: string, now = new Date()): Promise<number> {
    return this.db.apiToken.count({ where: { userId, gated: false, tabId: null, ...activeWhere(now) } });
  }

  async create(
    userId: string,
    input: { name: string; scopes: ApiTokenScope[]; expiresAt: Date | null; gated?: boolean; chatConversationId?: string | null; tabId?: string | null },
    tokenHash: string,
  ): Promise<ApiToken> {
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
