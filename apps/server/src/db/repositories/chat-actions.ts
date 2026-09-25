import type { PrismaClient } from '../prisma.js';
import type { ChatAction as PrismaChatAction } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';

export type ChatActionClass = 'read' | 'write' | 'irreversible';
export type ChatActionStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';

const OPEN_STATUSES: ChatActionStatus[] = ['pending', 'approved'];

/** One action the concierge proposed, and what became of it. `args` is never a tool result's
 * payload — no screen contents, no command output — only what was proposed (spec §7.1). */
export interface ChatAction {
  id: string;
  conversation_id: string;
  message_id: string | null;
  tool: string;
  args: unknown;
  class: ChatActionClass;
  status: ChatActionStatus;
  idempotency_key: string | null;
  machine_id: string | null;
  project_id: string | null;
  tab_id: string | null;
  grant_id: string | null;
  error_code: string | null;
  duration_ms: number | null;
  decided_by: string | null;
  decided_at: string | null;
  injected_at: string | null;
  created_at: string;
}

export interface InsertPendingInput {
  conversation_id: string;
  tool: string;
  args: unknown;
  class: ChatActionClass;
  message_id?: string | null;
  idempotency_key?: string | null;
  machine_id?: string | null;
  project_id?: string | null;
  tab_id?: string | null;
}

export interface InsertApprovedInput extends InsertPendingInput {
  grant_id: string;
  decided_by: string;
}

const mapAction = (a: PrismaChatAction): ChatAction => ({
  id: a.id,
  conversation_id: a.conversationId,
  message_id: a.messageId,
  tool: a.tool,
  args: a.args,
  class: a.class as ChatActionClass,
  status: a.status as ChatActionStatus,
  idempotency_key: a.idempotencyKey,
  machine_id: a.machineId,
  project_id: a.projectId,
  tab_id: a.tabId,
  grant_id: a.grantId,
  error_code: a.errorCode,
  duration_ms: a.durationMs,
  decided_by: a.decidedBy,
  decided_at: a.decidedAt?.toISOString() ?? null,
  injected_at: a.injectedAt?.toISOString() ?? null,
  created_at: a.createdAt.toISOString(),
});

export class ChatActionsRepository {
  constructor(private db: PrismaClient) {}

  /** The open (pending or approved) row for a key, or undefined once it has been decided one way
   * or the other — the partial unique index in the migration is what actually prevents two open
   * rows for the same key from existing at once; this is just the matching read. */
  async findOpenByKey(conversationId: string, idempotencyKey: string): Promise<ChatAction | undefined> {
    const row = await this.db.chatAction.findFirst({
      where: { conversationId, idempotencyKey, status: { in: OPEN_STATUSES } },
    });
    return row ? mapAction(row) : undefined;
  }

  /**
   * The newest "no" the user gave for a key. `findOpenByKey` cannot see a decided row, and the partial
   * unique index deliberately lets a key be proposed again once it is decided — right for an executed
   * action, since the same command may legitimately be run twice, and wrong for one refused a moment
   * ago, which the model would otherwise just retry. How long a "no" keeps refusing is the gate's call,
   * not this read's: it returns the row and its `decided_at`. An `expired` row is not a "no" at all —
   * nobody answered it — so it is not returned and the question gets asked again.
   */
  async findDeniedByKey(conversationId: string, idempotencyKey: string): Promise<ChatAction | undefined> {
    const row = await this.db.chatAction.findFirst({
      where: { conversationId, idempotencyKey, status: 'denied' satisfies ChatActionStatus },
      orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? mapAction(row) : undefined;
  }

  /**
   * A single row by id, scoped to its owner exactly as `decide` scopes its update — through the
   * owning conversation's `user_id`, in the same query. Another user's row, or no row at all, both
   * come back `undefined`; a caller cannot tell them apart from this alone, which is the point: this
   * read never says who owns a row it will not show. It exists so a caller that already tried
   * `decide` and got `undefined` can tell "nothing here" from "here, but already decided" with one
   * indexed lookup, instead of scanning the whole trail or re-deriving the ownership rule itself.
   */
  async findByIdForUser(id: string, userId: string): Promise<ChatAction | undefined> {
    const row = await this.db.chatAction.findFirst({ where: { id, conversation: { userId } } });
    return row ? mapAction(row) : undefined;
  }

  async insertPending(input: InsertPendingInput): Promise<ChatAction> {
    const row = await this.db.chatAction.create({
      data: {
        id: newId(),
        conversationId: input.conversation_id,
        messageId: input.message_id ?? null,
        tool: input.tool,
        args: input.args as never,
        class: input.class,
        status: 'pending',
        idempotencyKey: input.idempotency_key ?? null,
        machineId: input.machine_id ?? null,
        projectId: input.project_id ?? null,
        tabId: input.tab_id ?? null,
      },
    });
    return mapAction(row);
  }

  /**
   * An action the user never saw as a card because a grant ("Permitir sempre nesta aba") already
   * answered it: inserted `approved`, decided now by the user who granted, so the gate's `execute()`
   * claims and audits it exactly like a clicked approval. Subject to the same partial unique index
   * as `insertPending` — a parallel identical call loses here.
   */
  async insertApproved(input: InsertApprovedInput): Promise<ChatAction> {
    const row = await this.db.chatAction.create({
      data: {
        id: newId(),
        conversationId: input.conversation_id,
        messageId: input.message_id ?? null,
        tool: input.tool,
        args: input.args as never,
        class: input.class,
        status: 'approved',
        idempotencyKey: input.idempotency_key ?? null,
        machineId: input.machine_id ?? null,
        projectId: input.project_id ?? null,
        tabId: input.tab_id ?? null,
        grantId: input.grant_id,
        decidedBy: input.decided_by,
        decidedAt: new Date(),
      },
    });
    return mapAction(row);
  }

  /**
   * Records the user's decision on a pending action. Filtered by `id` **and** the owning
   * conversation's `user_id` in the same query, so another user's row is refused in SQL — a
   * handler-level check would be bypassable by the next caller. Undefined when it matched nothing
   * (wrong user, wrong id, or already decided).
   */
  async decide(id: string, userId: string, status: 'approved' | 'denied'): Promise<ChatAction | undefined> {
    const { count } = await this.db.chatAction.updateMany({
      where: { id, status: 'pending', conversation: { userId } },
      data: { status, decidedBy: userId, decidedAt: new Date() },
    });
    if (count === 0) return undefined;
    const row = await this.db.chatAction.findUnique({ where: { id } });
    return row ? mapAction(row) : undefined;
  }

  /**
   * Takes an approved action out of the approved state so exactly one caller may execute it. Two
   * identical tool calls can both read the same `approved` row — an MCP client that issues them in
   * parallel, a re-injection delivered twice — and without this claim both would act on one approval.
   * The `UPDATE` is conditional on the row still being approved, so the database decides the winner:
   * `true` means this caller owns the execution, `false` means somebody else already does.
   *
   * It lands on `executed` because that is the only status available today, and `markExecuted` then
   * records the real outcome (including `failed`). A process that dies between the claim and the
   * outcome leaves `executed` with a null `duration_ms`: the action is never retried, which is the
   * safe direction when nobody can know whether the keystroke landed. The deferred `running` status
   * slots straight in here — write it instead, and nothing else has to change.
   */
  async claimApproved(id: string): Promise<boolean> {
    const { count } = await this.db.chatAction.updateMany({
      where: { id, status: 'approved' satisfies ChatActionStatus },
      data: { status: 'executed' satisfies ChatActionStatus },
    });
    return count === 1;
  }

  /**
   * Ages an approval out: the same conditional `UPDATE` as `claimApproved`, landing on `expired`
   * instead of `executed`, so an approval the gate judged too old and a caller claiming that very
   * approval can never both win. `false` means the row was no longer `approved` — somebody claimed it
   * first and is executing it — and the caller must answer that, not that the approval lapsed.
   *
   * Why the gate expires the row itself instead of leaving it to the hourly sweep: the row is still
   * *open* as far as the partial unique index is concerned, so while it sits there the identical
   * proposal cannot be recorded again. Without this the model would be told to propose the action
   * again and then be unable to, for ever.
   */
  async expireApproved(id: string): Promise<boolean> {
    const { count } = await this.db.chatAction.updateMany({
      where: { id, status: 'approved' satisfies ChatActionStatus },
      data: { status: 'expired' satisfies ChatActionStatus },
    });
    return count === 1;
  }

  async markExecuted(id: string, ok: boolean, errorCode?: string | null, durationMs?: number | null): Promise<void> {
    await this.db.chatAction.updateMany({
      where: { id },
      data: { status: ok ? 'executed' : 'failed', errorCode: errorCode ?? null, durationMs: durationMs ?? null },
    });
  }

  /**
   * The oldest decided (approved or denied) action for a conversation that has not yet been
   * re-injected — a decision made while a run held the lock, so `resumeAfterDecision`'s own attempt
   * never started. Oldest first, so a backlog drains in the order the user answered it, one per run
   * completion (Task 5 fix round 2, Review Focus 2's sibling: an answer given while busy, not while
   * dead).
   *
   * `excludeIds` are rows the caller has already failed to mark injected in this process. Marking is
   * what makes the injection at-most-once, so a row it failed on stays uninjected on purpose — and
   * would be handed back here immediately, for ever. Excluding it in SQL (rather than the caller
   * dropping what it reads) is what keeps a later decision behind it from being stuck too.
   */
  async findNextToInject(conversationId: string, excludeIds: string[] = []): Promise<ChatAction | undefined> {
    const row = await this.db.chatAction.findFirst({
      where: {
        conversationId,
        status: { in: ['approved', 'denied'] satisfies ChatActionStatus[] },
        injectedAt: null,
        grantId: null, // a grant-run row is never a user decision to re-inject: nobody saw its card
        ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    });
    return row ? mapAction(row) : undefined;
  }

  /**
   * Records that a decision is being re-injected. Set before the run that carries it starts, not
   * after: the same at-most-once trade-off `claimApproved` makes for the tool call itself — a run
   * that never starts (a race for the lock) or never finishes (a crash, an outage) leaves this one
   * decision unsent rather than risking the model seeing it injected twice.
   */
  async markInjected(id: string): Promise<void> {
    await this.db.chatAction.updateMany({ where: { id }, data: { injectedAt: new Date() } });
  }

  async listByConversation(conversationId: string, limit = 200): Promise<ChatAction[]> {
    const rows = await this.db.chatAction.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.reverse().map(mapAction);
  }

  /**
   * Moves stale open rows to `expired`, whichever way they are open, and returns how many changed.
   *
   * Both halves of "open" age, and they age from the clock that means something for each: a question
   * nobody answered from when it was *asked* (`created_at`), an approval nobody consumed from when it
   * was *given* (`decided_at`) — the same instant the gate measures an approval against, so the sweep
   * and the gate can never disagree about which approvals are still good. An approval that is merely
   * slow to be re-injected is well inside the window; one still sitting here a day later is one no run
   * ever came back for, and leaving it would let a byte-identical proposal claim it weeks afterwards
   * without anybody being asked again.
   */
  async expireOlderThan(cutoff: Date): Promise<number> {
    const { count } = await this.db.chatAction.updateMany({
      where: {
        OR: [
          { status: 'pending' satisfies ChatActionStatus, createdAt: { lt: cutoff } },
          { status: 'approved' satisfies ChatActionStatus, decidedAt: { lt: cutoff } },
        ],
      },
      data: { status: 'expired' satisfies ChatActionStatus },
    });
    return count;
  }

  /** Reset closes every open question of the conversation it archives: nobody reads that session any
   * more, so a pending card or an unconsumed approval must not be injected into it later. */
  async expireOpenForConversation(conversationId: string): Promise<number> {
    const { count } = await this.db.chatAction.updateMany({
      where: { conversationId, status: { in: ['pending', 'approved'] satisfies ChatActionStatus[] } },
      data: { status: 'expired' satisfies ChatActionStatus },
    });
    return count;
  }

  async countPendingByConversation(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.chatAction.groupBy({ by: ['conversationId'], where: { conversationId: { in: ids }, status: 'pending' satisfies ChatActionStatus }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.conversationId, r._count._all]));
  }
}
