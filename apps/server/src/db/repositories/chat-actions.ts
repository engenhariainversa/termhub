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
  /** The tab's name when the action was asked (TER-1024): what a closed tab's card still calls it. */
  tab_name: string | null;
  grant_id: string | null;
  error_code: string | null;
  duration_ms: number | null;
  decided_by: string | null;
  decided_at: string | null;
  injected_at: string | null;
  /** The CLI tool_use_id of the call this action came from, when it ran inside a subagent's turn. */
  tool_use_id: string | null;
  /** The subagent (`chat_subagents`) whose turn proposed this action, when it ran inside one. */
  subagent_id: string | null;
  created_at: string;
  /** When the card was last brought back to the end of the chat (TER-477): the thread orders by it, else `created_at`. */
  surfaced_at: string | null;
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
  tab_name?: string | null;
  tool_use_id?: string | null;
  subagent_id?: string | null;
  /** Born injected: a card the server asks itself (`automation_merge`), never a concierge proposal the
   *  model must be told about — its decision is acted on by the server, not re-injected. */
  injected?: boolean;
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
  tab_name: a.tabName,
  grant_id: a.grantId,
  error_code: a.errorCode,
  duration_ms: a.durationMs,
  decided_by: a.decidedBy,
  decided_at: a.decidedAt?.toISOString() ?? null,
  injected_at: a.injectedAt?.toISOString() ?? null,
  tool_use_id: a.toolUseId,
  subagent_id: a.subagentId,
  created_at: a.createdAt.toISOString(),
  surfaced_at: a.surfacedAt?.toISOString() ?? null,
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

  /**
   * Ties every action of this conversation's tool_use_id to the subagent that turned out to have run
   * it (spec 2026-09-26 §4): the gate proposes an action before it can know which subagent's turn it
   * came from — that is only learned once the `task_started`/action frames are correlated — so this
   * back-fills `subagent_id` once it is known. Only rows still unset: a row already tied to a subagent
   * is never touched again, so a duplicate correlation (a retried frame) is a no-op and never returns
   * a row that was already attributed a moment ago.
   */
  async setSubagentByToolUse(conversationId: string, toolUseId: string, subagentId: string): Promise<ChatAction[]> {
    const { count } = await this.db.chatAction.updateMany({
      where: { conversationId, toolUseId, subagentId: null },
      data: { subagentId },
    });
    if (count === 0) return [];
    const rows = await this.db.chatAction.findMany({ where: { conversationId, toolUseId, subagentId } });
    return rows.map(mapAction);
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
        tabName: input.tab_name ?? null,
        toolUseId: input.tool_use_id ?? null,
        subagentId: input.subagent_id ?? null,
        injectedAt: input.injected ? new Date() : null,
      },
    });
    return mapAction(row);
  }

  /** A row by id, unscoped: for the server's own cards (`automation_merge`), never for a request's id. */
  async findById(id: string): Promise<ChatAction | undefined> {
    const row = await this.db.chatAction.findUnique({ where: { id } });
    return row ? mapAction(row) : undefined;
  }

  /** The newest row of a key in any of the user's conversations of a project, whatever its status: a server card is asked once per key. */
  async findLatestByKeyInProject(userId: string, projectId: string, idempotencyKey: string): Promise<ChatAction | undefined> {
    const row = await this.db.chatAction.findFirst({ where: { idempotencyKey, conversation: { userId, projectId } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return row ? mapAction(row) : undefined;
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
        tabName: input.tab_name ?? null,
        toolUseId: input.tool_use_id ?? null,
        subagentId: input.subagent_id ?? null,
        grantId: input.grant_id,
        decidedBy: input.decided_by,
        decidedAt: new Date(),
      },
    });
    return mapAction(row);
  }

  /** How many calls a grant already covered since `since` — the project grant's hourly budget (spec
   * 2026-09-26 project grant §2). Keyed by the conversation too, so it rides `(conversation_id, created_at)`.
   * `tools`, when given, counts only those tools — e.g. the shell/keys budget kept separate from the
   * board budget under the same grant (TER-325). */
  async countForGrantSince(conversationId: string, grantId: string, since: Date, tools?: readonly string[]): Promise<number> {
    return this.db.chatAction.count({ where: { conversationId, grantId, createdAt: { gt: since }, ...(tools ? { tool: { in: [...tools] } } : {}) } });
  }

  /** Calls charged to one grant since `since`, across conversations (a standing grant, TER-386). */
  async countByGrantSince(grantId: string, since: Date): Promise<number> {
    return this.db.chatAction.count({ where: { grantId, createdAt: { gt: since } } });
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

  /** Every decided-but-uninjected user decision of a conversation, oldest decision first (spec
   * 2026-09-26 §7.2): re-injection takes them all in one run instead of one per run. Same filters and
   * the same `excludeIds` reasoning as `findNextToInject`; `limit` keeps one injected turn bounded. */
  async listToInject(conversationId: string, excludeIds: string[] = [], limit = 20): Promise<ChatAction[]> {
    const rows = await this.db.chatAction.findMany({
      where: {
        conversationId,
        status: { in: ['approved', 'denied'] satisfies ChatActionStatus[] },
        injectedAt: null,
        grantId: null,
        ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(mapAction);
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

  /**
   * `markInjected` for every decision one run carries, all or none, and never a row twice: only rows
   * still uninjected are marked, and the answer is how many there were. Anything short of `ids.length`
   * means another run already carried one of them — the transaction is rolled back, so nothing is
   * marked and the caller must not start its run; the rest stay for the next drain.
   */
  async markInjectedMany(ids: string[]): Promise<number> {
    const short = Symbol('short');
    let count = 0;
    try {
      await this.db.$transaction(async (tx) => {
        ({ count } = await tx.chatAction.updateMany({ where: { id: { in: ids }, injectedAt: null }, data: { injectedAt: new Date() } }));
        if (count !== ids.length) throw short;
      });
    } catch (err) {
      if (err !== short) throw err;
    }
    return count;
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

  /**
   * A pending card whose tab is gone (TER-986): nothing it asks can happen any more — not the call, not a
   * grant on its tab or its tab's project — so it ends `failed` with `TAB_GONE`, the same way the gate ends
   * an approval whose tab died, and the screens show it as stale. Conditional on `pending`: a card decided
   * in the same instant is left alone. Resolves the row (with its owner, for the bus) or undefined.
   */
  async failPendingTabGone(id: string): Promise<{ action: ChatAction; user_id: string } | undefined> {
    const { count } = await this.db.chatAction.updateMany({ where: { id, status: 'pending' satisfies ChatActionStatus }, data: { status: 'failed', errorCode: 'TAB_GONE' } });
    if (count === 0) return undefined;
    const row = await this.db.chatAction.findUnique({ where: { id }, include: { conversation: { select: { userId: true } } } });
    return row ? { action: mapAction(row), user_id: row.conversation.userId } : undefined;
  }

  /** `failPendingTabGone` for every pending card of a tab that was just removed (closed from the UI, by
   * the concierge, or with its machine or project). Resolves the rows it moved, with their owners. */
  async failPendingForTab(tabId: string): Promise<Array<{ action: ChatAction; user_id: string }>> {
    const moved = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "chat_actions" SET "status" = 'failed', "error_code" = 'TAB_GONE'
       WHERE "tab_id" = ${tabId} AND "status" = 'pending'
      RETURNING "id"`;
    return this.withOwners(moved.map((r) => r.id));
  }

  /**
   * Every pending card whose tab row is gone without a lifecycle event saying so — the other color removed
   * it during a blue/green switch, or this process was down — moved the same way. At boot and in the
   * hourly purge, like `TabQuestionsRepository.expireOrphans`.
   */
  async failOrphanPending(): Promise<Array<{ action: ChatAction; user_id: string }>> {
    const moved = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "chat_actions" AS a SET "status" = 'failed', "error_code" = 'TAB_GONE'
       WHERE a."status" = 'pending' AND a."tab_id" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "tabs" t WHERE t."id" = a."tab_id")
      RETURNING a."id"`;
    return this.withOwners(moved.map((r) => r.id));
  }

  /** The rows by id with their owners, oldest first. */
  private async withOwners(ids: string[]): Promise<Array<{ action: ChatAction; user_id: string }>> {
    if (ids.length === 0) return [];
    const rows = await this.db.chatAction.findMany({ where: { id: { in: ids } }, include: { conversation: { select: { userId: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => ({ action: mapAction(row), user_id: row.conversation.userId }));
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

  /**
   * Brings the conversation's pending cards back to the end of the chat (TER-477): `surfaced_at = now`
   * on each row still `pending` — all of them, or only `ids`. Resolves the rows it moved, oldest first.
   */
  async surfacePending(conversationId: string, ids?: string[], now = new Date()): Promise<ChatAction[]> {
    const where = { conversationId, status: 'pending' satisfies ChatActionStatus, ...(ids ? { id: { in: ids } } : {}) };
    const rows = await this.db.chatAction.findMany({ where, select: { id: true } });
    if (rows.length === 0) return [];
    await this.db.chatAction.updateMany({ where: { ...where, id: { in: rows.map((r) => r.id) } }, data: { surfacedAt: now } });
    const moved = await this.db.chatAction.findMany({ where: { id: { in: rows.map((r) => r.id) }, surfacedAt: now }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return moved.map(mapAction);
  }

  async countPendingByConversation(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.chatAction.groupBy({ by: ['conversationId'], where: { conversationId: { in: ids }, status: 'pending' satisfies ChatActionStatus }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.conversationId, r._count._all]));
  }
}
