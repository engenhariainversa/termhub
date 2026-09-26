import type { PrismaClient } from '../prisma.js';
import type { ChatGrant as PrismaChatGrant } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

/** How long "Permitir sempre nesta aba" lasts at most (spec 2026-09-25 §2): the conversation, capped
 * at the same 24 h an approval lives (`ACTION_TTL_MS`). A reset ends it earlier (`revokeForConversation`). */
export const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

/** A standing "yes" for one tool on one tab, in one conversation. */
export interface ChatGrant {
  id: string;
  conversation_id: string;
  tab_id: string;
  tool: string;
  source_action_id: string | null;
  granted_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface GrantInput {
  conversation_id: string;
  tab_id: string;
  tool: string;
  source_action_id?: string | null;
  granted_by: string;
}

/** Where a page of the grant history ended: the last row's `(created_at, id)`. */
export interface GrantCursor {
  created_at: string;
  id: string;
}

/** A grant with what the list needs from the conversation that granted it. */
export interface ChatGrantWithConversation extends ChatGrant {
  conversation_project_id: string | null;
  conversation_archived: boolean;
}

/** The most rows one page (or the active list) ever returns. */
export const GRANT_LIST_MAX = 100;

const mapGrant = (g: PrismaChatGrant): ChatGrant => ({
  id: g.id,
  conversation_id: g.conversationId,
  tab_id: g.tabId,
  tool: g.tool,
  source_action_id: g.sourceActionId,
  granted_by: g.grantedBy,
  created_at: g.createdAt.toISOString(),
  expires_at: g.expiresAt.toISOString(),
  revoked_at: g.revokedAt?.toISOString() ?? null,
  revoked_by: g.revokedBy,
});

/**
 * Who may read what. Methods keyed by a conversation id (`findActive`, `listActive`,
 * `findActiveBySourceAction`, `revokeForConversation`) trust that id: every caller derives it on the
 * server — minted into the gated token, or the scope user's own conversation — never from a client.
 * Methods keyed by an id a client sends (`findByIdForUser`, `revoke`, `listForUser`) filter by the
 * owning conversation's `user_id` in SQL, so another user's grant reads as no grant at all.
 */
export class ChatGrantsRepository {
  constructor(private db: PrismaClient) {}

  /**
   * Trusts a tab for a tool in a conversation. The previous grant for the same triple — active or
   * merely expired, both hold the partial unique slot — is revoked in the same transaction, so granting
   * again is how the 24 h restart.
   */
  async grant(input: GrantInput, now = new Date()): Promise<ChatGrant> {
    const row = await this.db.$transaction(async (tx) => {
      await tx.chatGrant.updateMany({
        where: { conversationId: input.conversation_id, tabId: input.tab_id, tool: input.tool, revokedAt: null },
        data: { revokedAt: now, revokedBy: input.granted_by },
      });
      return tx.chatGrant.create({
        data: {
          id: newId(),
          conversationId: input.conversation_id,
          tabId: input.tab_id,
          tool: input.tool,
          sourceActionId: input.source_action_id ?? null,
          grantedBy: input.granted_by,
          createdAt: now,
          expiresAt: new Date(now.getTime() + GRANT_TTL_MS),
        },
      });
    });
    return mapGrant(row);
  }

  async findActive(conversationId: string, tabId: string, tool: string, now = new Date()): Promise<ChatGrant | undefined> {
    const row = await this.db.chatGrant.findFirst({ where: { conversationId, tabId, tool, revokedAt: null, expiresAt: { gt: now } } });
    return row ? mapGrant(row) : undefined;
  }

  async listActive(conversationId: string, now = new Date()): Promise<ChatGrant[]> {
    const rows = await this.db.chatGrant.findMany({ where: { conversationId, revokedAt: null, expiresAt: { gt: now } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(mapGrant);
  }

  /** The active grant a confirmation card created, if any — for the injected sentence. Keyed by the
   * card's conversation too, so the lookup rides the `(conversation_id)` index on every approval. */
  async findActiveBySourceAction(conversationId: string, actionId: string, now = new Date()): Promise<ChatGrant | undefined> {
    const row = await this.db.chatGrant.findFirst({ where: { conversationId, sourceActionId: actionId, revokedAt: null, expiresAt: { gt: now } } });
    return row ? mapGrant(row) : undefined;
  }

  /** Scoped through the owning conversation's `user_id`, like `ChatActionsRepository.findByIdForUser`:
   * another user's grant and no grant at all are the same `undefined`. */
  async findByIdForUser(id: string, userId: string): Promise<ChatGrant | undefined> {
    const row = await this.db.chatGrant.findFirst({ where: { id, conversation: { userId } } });
    return row ? mapGrant(row) : undefined;
  }

  /** "Revogar". Undefined when it matched nothing: wrong id, another user's, or already revoked. */
  async revoke(id: string, userId: string, now = new Date()): Promise<ChatGrant | undefined> {
    const { count } = await this.db.chatGrant.updateMany({ where: { id, revokedAt: null, conversation: { userId } }, data: { revokedAt: now, revokedBy: userId } });
    if (count === 0) return undefined;
    const row = await this.db.chatGrant.findUnique({ where: { id } });
    return row ? mapGrant(row) : undefined;
  }

  /** "Nova conversa" ends the conversation, and with it every grant it held. */
  async revokeForConversation(conversationId: string, now = new Date()): Promise<number> {
    const { count } = await this.db.chatGrant.updateMany({ where: { conversationId, revokedAt: null }, data: { revokedAt: now, revokedBy: null } });
    return count;
  }

  /**
   * Every grant of one user, across all their conversations ("Abas confiáveis", spec 2026-09-26 §3.1),
   * scoped by the owning conversation's `user_id` in SQL. `active` returns what is in force (capped at
   * `GRANT_LIST_MAX`, no paging: at most one per conversation + tab, each ≤ 24 h). `ended` is the history,
   * newest first, paged by `(created_at, id)` so rows sharing a timestamp are neither skipped nor repeated.
   */
  async listForUser(userId: string, opts: { state: 'active' | 'ended'; cursor?: GrantCursor | null; limit: number }, now = new Date()): Promise<{ grants: ChatGrantWithConversation[]; next: GrantCursor | null }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), GRANT_LIST_MAX);
    const state = opts.state === 'active' ? { revokedAt: null, expiresAt: { gt: now } } : { OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] };
    const cursor = opts.state === 'ended' ? opts.cursor : null;
    const after = cursor ? { OR: [{ createdAt: { lt: new Date(cursor.created_at) } }, { createdAt: new Date(cursor.created_at), id: { lt: cursor.id } }] } : {};
    const rows = await this.db.chatGrant.findMany({
      where: { AND: [{ conversation: { userId } }, state, after] },
      include: { conversation: { select: { projectId: true, archivedAt: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      grants: page.map((r) => ({ ...mapGrant(r), conversation_project_id: r.conversation.projectId, conversation_archived: r.conversation.archivedAt !== null })),
      next: opts.state === 'ended' && rows.length > limit && last ? { created_at: last.createdAt.toISOString(), id: last.id } : null,
    };
  }
}
