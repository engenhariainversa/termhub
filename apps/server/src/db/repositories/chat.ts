import type { ChatAttachment } from '@termhub/mobile-api';
import type { PrismaClient } from '../prisma.js';
import { Prisma, type ChatConversation as PrismaConversation, type ChatMessage as PrismaMessage } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { mapAttachment, toPublicAttachment } from './chat-attachments.js';

export type ChatRole = 'user' | 'assistant';

export interface ChatConversation {
  id: string;
  user_id: string;
  title: string | null;
  cli_session_id: string | null;
  model: string | null;
  /** The host: the user's own machine this conversation runs on. Null = not chosen yet. */
  machine_id: string | null;
  /** The Claude account on that host. Null = the machine's default config dir. */
  ai_account_id: string | null;
  /** The project this conversation is about. Null = the account-wide chat (spec 2026-09-23 §3). */
  project_id: string | null;
  /** Set by "Nova conversa": the row is kept, but it is no longer the scope's active conversation. */
  archived_at: string | null;
  review_mode: boolean;
  last_message_at: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: ChatRole;
  text: string;
  usage: unknown | null;
  error_code: string | null;
  created_at: string;
  /** The files sent with a user message (spec 2026-09-26 §5.5). Present only when there is at least one. */
  attachments?: ChatAttachment[];
}

const mapConversation = (c: PrismaConversation): ChatConversation => ({
  id: c.id,
  user_id: c.userId,
  title: c.title,
  cli_session_id: c.cliSessionId,
  model: c.model,
  machine_id: c.machineId,
  ai_account_id: c.aiAccountId,
  project_id: c.projectId,
  archived_at: c.archivedAt?.toISOString() ?? null,
  review_mode: c.reviewMode,
  last_message_at: c.lastMessageAt?.toISOString() ?? null,
  created_at: c.createdAt.toISOString(),
});

const mapMessage = (m: PrismaMessage): ChatMessage => ({
  id: m.id,
  conversation_id: m.conversationId,
  role: m.role as ChatRole,
  text: m.text,
  usage: m.usage ?? null,
  error_code: m.errorCode,
  created_at: m.createdAt.toISOString(),
});

export class ChatRepository {
  constructor(private db: PrismaClient) {}

  /** The active conversation of one scope — the account-wide chat (`projectId === null`) or one
   * project's — created on first use. The partial unique index `chat_conversations_one_active` makes
   * two concurrent first loads converge on one row: the loser's insert is refused (P2002) and it
   * re-reads the winner. */
  private async getOrCreateActive(userId: string, projectId: string | null): Promise<ChatConversation> {
    const where = { userId, projectId, tabId: null, archivedAt: null };
    const existing = await this.db.chatConversation.findFirst({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (existing) return mapConversation(existing);
    try {
      return mapConversation(await this.db.chatConversation.create({ data: { id: newId(), userId, projectId } }));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.db.chatConversation.findFirst({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        if (winner) return mapConversation(winner);
      }
      throw err;
    }
  }

  /** The account-wide conversation: the one `/chat` shows and the one that holds the host (spec §3). */
  getOrCreateForUser(userId: string): Promise<ChatConversation> {
    return this.getOrCreateActive(userId, null);
  }

  /** A project's active conversation. Ownership of the project is the caller's check. */
  getOrCreateForProject(userId: string, projectId: string): Promise<ChatConversation> {
    return this.getOrCreateActive(userId, projectId);
  }

  /**
   * Where a tab's question is pushed (spec 2026-09-25 §5.2): the project's most recently active
   * conversation that is still on screen somewhere — not archived, not tab-bound. A project nobody has
   * chatted in yet has none, and its tabs' questions stay in the tab.
   */
  async findLatestActiveForProject(projectId: string, ownerId: string): Promise<ChatConversation | undefined> {
    const row = await this.db.chatConversation.findFirst({
      where: { projectId, userId: ownerId, tabId: null, archivedAt: null },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? mapConversation(row) : undefined;
  }

  async findByIdForUser(id: string, userId: string): Promise<ChatConversation | undefined> {
    const row = await this.db.chatConversation.findFirst({ where: { id, userId } });
    return row ? mapConversation(row) : undefined;
  }

  /** "Nova conversa": the row and its transcript stay, but it stops being the scope's active one. */
  async archive(id: string): Promise<void> {
    await this.db.chatConversation.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date() } });
  }

  /** A host change moves every project conversation too: their CLI sessions live in the old host's
   * config dir and cannot be resumed anywhere else (user-hosted spec §3). */
  async clearProjectSessions(userId: string): Promise<void> {
    await this.db.chatConversation.updateMany({ where: { userId, projectId: { not: null }, archivedAt: null }, data: { cliSessionId: null } });
  }

  /** The user's active project conversations, with when each last saw a message (null = none yet). */
  async listActiveProjectConversations(userId: string): Promise<{ id: string; project_id: string; last_message_at: string | null }[]> {
    const rows = await this.db.chatConversation.findMany({
      where: { userId, projectId: { not: null }, tabId: null, archivedAt: null },
      select: { id: true, projectId: true, lastMessageAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, project_id: r.projectId!, last_message_at: r.lastMessageAt?.toISOString() ?? null }));
  }

  async setCliSession(id: string, sessionId: string | null): Promise<void> {
    await this.db.chatConversation.update({ where: { id }, data: { cliSessionId: sessionId } });
  }

  /**
   * Points the conversation at the machine and the account that will run it (spec §3).
   *
   * Clears `cli_session_id` only when the pair **provably moved**: a machine that was stored and is now
   * a different one, or a different account. The CLI's session lives inside the config directory of the
   * machine that ran it, so it exists neither on another host nor under a second login on the same one,
   * and keeping the uuid would ask that host to `--resume` a session it has never seen. Our own
   * transcript is never touched either way.
   *
   * A conversation with **no machine stored keeps its session**, and that is the whole point of this
   * comparison: with a single machine the host is resolved on the fly and nothing is written, so the run
   * happened on the very machine that was then the only candidate — naming it now (which is what the
   * user does the moment they enrol a second machine and are asked to choose) moves no host at all, and
   * wiping the model's memory of the conversation for it would be pure loss. The opposite mistake is
   * cheap and self-healing: a user who instead names a machine the session was never on gets one
   * `missing_session` on their next message, which `ChatService` already answers by starting a fresh
   * session (spec §11's existing path), while a session dropped here is gone for good.
   *
   * Read and write in one transaction: two host changes racing must not both read "unchanged" and leave
   * a session pointing at neither host.
   *
   * Ownership is the caller's business: the route resolves both ids through owner-scoped reads before
   * calling this, exactly like every other write that takes an id from the browser.
   */
  /**
   * Records the machine a run is about to use, but **only when the conversation names none** — never
   * over a choice the user made, and never a second time.
   *
   * Without this, `machine_id === null` means two different things that need different screens: "nothing
   * was ever chosen" (the single-machine user, where the auto-pick is simply right) and "the host this
   * conversation ran on was unenrolled and the foreign key nulled it" (where `cli_session_id` still
   * points at a session in that machine's config dir, and the next run on another machine loses the
   * model's memory). Pinning the auto-pick the first time it actually runs is what makes the second one
   * recognisable — and it is what `resolveHost` reads to warn before that loss instead of after it.
   *
   * `updateMany` with the null in the filter, so the guard is the database's and not a read-then-write:
   * a host chosen between the resolve and this call keeps the user's choice.
   */
  async pinHostMachine(id: string, machineId: string): Promise<void> {
    await this.db.chatConversation.updateMany({ where: { id, machineId: null }, data: { machineId } });
  }

  /**
   * `moved` is the one true signal that the pair changed (see the doc comment above): callers that
   * need to strand *other* rows tied to this host (the project conversations, spec §3) must branch on
   * it and not re-derive it from the returned conversation, whose own `cli_session_id` can be null for
   * reasons that have nothing to do with a move (a fresh "Nova conversa" row, for one).
   */
  async setHost(id: string, host: { machine_id: string; ai_account_id: string | null }): Promise<{ conversation: ChatConversation; moved: boolean }> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.chatConversation.findUnique({ where: { id } });
      // A null stored machine is "not known to have moved", never "moved from nothing".
      const machineMoved = current !== null && current.machineId !== null && current.machineId !== host.machine_id;
      const accountMoved = (current?.aiAccountId ?? null) !== host.ai_account_id;
      const moved = machineMoved || accountMoved;
      const row = await tx.chatConversation.update({
        where: { id },
        data: { machineId: host.machine_id, aiAccountId: host.ai_account_id, ...(moved ? { cliSessionId: null } : {}) },
      });
      return { conversation: mapConversation(row), moved };
    });
  }

  async addMessage(input: { conversation_id: string; role: ChatRole; text: string; usage?: unknown; error_code?: string | null }): Promise<ChatMessage> {
    const [message] = await this.db.$transaction([
      this.db.chatMessage.create({
        data: {
          id: newId(),
          conversationId: input.conversation_id,
          role: input.role,
          text: input.text,
          usage: (input.usage ?? null) as never,
          errorCode: input.error_code ?? null,
        },
      }),
      this.db.chatConversation.update({ where: { id: input.conversation_id }, data: { lastMessageAt: new Date() } }),
    ]);
    return mapMessage(message);
  }

  async updateMessage(id: string, patch: { text?: string; usage?: unknown; error_code?: string | null }): Promise<ChatMessage> {
    const row = await this.db.chatMessage.update({
      where: { id },
      data: {
        ...(patch.text === undefined ? {} : { text: patch.text }),
        ...(patch.usage === undefined ? {} : { usage: patch.usage as never }),
        ...(patch.error_code === undefined ? {} : { errorCode: patch.error_code }),
      },
    });
    return mapMessage(row);
  }

  /**
   * Removes a message. Used when a run never started at all (the concierge is not configured, or
   * refused the request): the empty assistant row must not stay behind as a bubble that waits for
   * an answer that will never come. `deleteMany` so a row already gone is not an error.
   */
  async deleteMessage(id: string): Promise<void> {
    await this.db.chatMessage.deleteMany({ where: { id } });
  }

  /**
   * The newest `limit` messages, returned oldest-first. The window must be anchored at the end of
   * the conversation, not at its start: taking the *oldest* rows means that past `limit` messages
   * the payload never again contains the message the user just sent or its answer — the screen
   * would freeze on ancient history with no error and no way out.
   */
  async listMessages(conversationId: string, limit = 200): Promise<ChatMessage[]> {
    const rows = await this.db.chatMessage.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    const messages = rows.reverse().map(mapMessage);
    if (messages.length === 0) return messages;
    // Every listed message's attachments in one query; a message with none stays as it was.
    const attached = await this.db.chatAttachment.findMany({ where: { messageId: { in: messages.map((m) => m.id) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (attached.length === 0) return messages;
    const byMessage = new Map<string, ChatAttachment[]>();
    for (const a of attached) {
      const row = mapAttachment(a);
      byMessage.set(row.message_id!, [...(byMessage.get(row.message_id!) ?? []), toPublicAttachment(row)]);
    }
    return messages.map((m) => (byMessage.has(m.id) ? { ...m, attachments: byMessage.get(m.id) } : m));
  }
}
