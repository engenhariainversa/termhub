import type { PrismaClient } from '../prisma.js';
import type { ChatBlock as PrismaRow } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { isBlockEffect, isBlockKind, type BlockEffect, type BlockKind } from '../../chat/open-permissions.js';

/** Something the chat must not do on its own (TER-1164, flag `chat_open_permissions`). */
export interface ChatBlock {
  id: string;
  user_id: string;
  /** null: every project of the user. */
  project_id: string | null;
  kind: BlockKind;
  /** run_command only: the commands that start with these words; empty = every command. */
  words: string[];
  effect: BlockEffect;
  conversation_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface NewChatBlock {
  user_id: string;
  project_id: string | null;
  kind: BlockKind;
  words?: string[];
  effect?: BlockEffect;
  conversation_id?: string | null;
}

/** The most blocks one person keeps in force; past it, a new one is refused. */
export const BLOCKS_MAX = 200;

/** A row whose `kind` or `effect` the code no longer knows is skipped by the readers. */
const map = (r: PrismaRow): ChatBlock | null =>
  isBlockKind(r.kind) && isBlockEffect(r.effect)
    ? {
        id: r.id,
        user_id: r.userId,
        project_id: r.projectId,
        kind: r.kind,
        words: r.words ?? [],
        effect: r.effect,
        conversation_id: r.conversationId,
        created_at: r.createdAt.toISOString(),
        revoked_at: r.revokedAt?.toISOString() ?? null,
      }
    : null;

const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((w, i) => w === b[i]);

export class ChatBlocksRepository {
  constructor(private db: PrismaClient) {}

  /** Every block of this user in force, oldest first. Owner-keyed by the server-derived user id only. */
  async listActive(userId: string): Promise<ChatBlock[]> {
    const rows = await this.db.chatBlock.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'asc' }, take: BLOCKS_MAX });
    return rows.map(map).filter((b): b is ChatBlock => b !== null);
  }

  /**
   * Adds a block, or returns the one in force with the same kind, project and words (its effect updated
   * when it differs). `created` says which.
   */
  async create(input: NewChatBlock): Promise<{ block: ChatBlock; created: boolean }> {
    const words = input.words ?? [];
    const effect = input.effect ?? 'ask';
    const existing = (await this.db.chatBlock.findMany({ where: { userId: input.user_id, projectId: input.project_id, kind: input.kind, revokedAt: null } })).find((r) => sameWords(r.words ?? [], words));
    if (existing) {
      const row = existing.effect === effect ? existing : await this.db.chatBlock.update({ where: { id: existing.id }, data: { effect } });
      return { block: map(row)!, created: false };
    }
    const row = await this.db.chatBlock.create({
      data: { id: newId(), userId: input.user_id, projectId: input.project_id, kind: input.kind, words, effect, conversationId: input.conversation_id ?? null },
    });
    return { block: map(row)!, created: true };
  }

  async countActive(userId: string): Promise<number> {
    return this.db.chatBlock.count({ where: { userId, revokedAt: null } });
  }

  /** Lifts one block of this user. Undefined when unknown, another user's or already lifted. */
  async revoke(id: string, userId: string): Promise<ChatBlock | undefined> {
    const { count } = await this.db.chatBlock.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: userId } });
    if (count === 0) return undefined;
    const row = await this.db.chatBlock.findUnique({ where: { id } });
    return row ? (map(row) ?? undefined) : undefined;
  }
}
