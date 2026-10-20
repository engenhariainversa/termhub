import type { PrismaClient } from '../prisma.js';
import type { ChatCommandRule as PrismaRow } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { isCommandRuleMatch, type CommandRuleMatch } from '../../chat/command-rules.js';

/** A command the chat's run_command types without a card (TER-1081). */
export interface ChatCommandRule {
  id: string;
  user_id: string;
  /** null: every project of the user. */
  project_id: string | null;
  words: string[];
  match: CommandRuleMatch;
  /** Empty: every machine. */
  machine_ids: string[];
  conversation_id: string | null;
  source_action_id: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface NewChatCommandRule {
  user_id: string;
  project_id: string | null;
  words: string[];
  match: CommandRuleMatch;
  machine_ids?: string[];
  conversation_id?: string | null;
  source_action_id?: string | null;
  expires_at?: Date | null;
}

/** The most rules one list returns: the active ones are never paged, the history is the newest ones. */
export const COMMAND_RULE_LIST_MAX = 200;

/** Rows whose `match` the code does not know are skipped by the readers below. */
const map = (r: PrismaRow): ChatCommandRule | null =>
  isCommandRuleMatch(r.match)
    ? {
        id: r.id, user_id: r.userId, project_id: r.projectId, words: r.words, match: r.match, machine_ids: r.machineIds, conversation_id: r.conversationId,
        source_action_id: r.sourceActionId, created_at: r.createdAt.toISOString(), expires_at: r.expiresAt?.toISOString() ?? null,
        revoked_at: r.revokedAt?.toISOString() ?? null, revoked_by: r.revokedBy,
      }
    : null;
const mapKnown = (rows: PrismaRow[]) => rows.flatMap((r) => { const m = map(r); return m ? [m] : []; });

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** In force: not revoked, and not past its expiry. */
const activeWhere = (now: Date) => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

/** The command allow list. Every method is keyed by `user_id` (server-derived, never a client value). */
export class ChatCommandRulesRepository {
  constructor(private db: PrismaClient) {}

  /**
   * Adds a rule. The same rule already in force (same project, words, match and machines) is returned as
   * it is, with `created: false`, so clicking twice or proposing it again never stacks duplicates.
   */
  async create(input: NewChatCommandRule, now = new Date()): Promise<{ rule: ChatCommandRule; created: boolean }> {
    const machines = [...new Set(input.machine_ids ?? [])];
    const existing = mapKnown(await this.db.chatCommandRule.findMany({ where: { userId: input.user_id, projectId: input.project_id, match: input.match, ...activeWhere(now) } })).find(
      (r) => r.words.length === input.words.length && r.words.every((w, i) => w === input.words[i]) && sameSet(r.machine_ids, machines) && (r.expires_at === null) === (input.expires_at == null),
    );
    if (existing && input.expires_at == null) return { rule: existing, created: false };
    const row = await this.db.chatCommandRule.create({
      data: {
        id: newId(), userId: input.user_id, projectId: input.project_id, words: input.words, match: input.match, machineIds: machines,
        conversationId: input.conversation_id ?? null, sourceActionId: input.source_action_id ?? null, createdAt: now, expiresAt: input.expires_at ?? null,
      },
    });
    return { rule: map(row)!, created: true };
  }

  /** The rules in force that may cover a command in this project: the project's own and the global ones. */
  async listActiveFor(userId: string, projectId: string, now = new Date()): Promise<ChatCommandRule[]> {
    return mapKnown(await this.db.chatCommandRule.findMany({ where: { userId, OR: [{ projectId }, { projectId: null }], AND: [activeWhere(now)] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
  }

  /** Every rule of the user in force (`active`), or the ones revoked or expired (`ended`), newest first. */
  async listForUser(userId: string, state: 'active' | 'ended', now = new Date()): Promise<ChatCommandRule[]> {
    const where = state === 'active' ? { userId, ...activeWhere(now) } : { userId, OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] };
    return mapKnown(await this.db.chatCommandRule.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: COMMAND_RULE_LIST_MAX }));
  }

  async findByIdForUser(id: string, userId: string): Promise<ChatCommandRule | undefined> {
    const r = await this.db.chatCommandRule.findFirst({ where: { id, userId } });
    return r ? (map(r) ?? undefined) : undefined;
  }

  /** The rule a confirmation card created and still in force, if any — for the card's line and the injected sentence. */
  async findActiveBySourceAction(userId: string, actionId: string, now = new Date()): Promise<ChatCommandRule | undefined> {
    const r = await this.db.chatCommandRule.findFirst({ where: { userId, sourceActionId: actionId, ...activeWhere(now) }, orderBy: { createdAt: 'desc' } });
    return r ? (map(r) ?? undefined) : undefined;
  }

  /** "Revogar". Undefined when it matched nothing: wrong id, another user's, or already revoked. */
  async revoke(id: string, userId: string, now = new Date()): Promise<ChatCommandRule | undefined> {
    const { count } = await this.db.chatCommandRule.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: now, revokedBy: userId } });
    if (count === 0) return undefined;
    const r = await this.db.chatCommandRule.findUnique({ where: { id } });
    return r ? (map(r) ?? undefined) : undefined;
  }
}
