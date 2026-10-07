import type { PrismaClient } from '../prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../lib/ids.js';
import { holdsAtSql, type DecisionPlace, type DecisionScope } from './decision-scope.js';

/** One option offered by a remembered `AskUserQuestion` question. */
export interface DecisionOption {
  label: string;
  description: string;
}
/** What the person answered: the option label(s) picked, plus free text for "Type something." */
export interface DecisionAnswer {
  labels: string[];
  text?: string;
}

/**
 * A past `choice` question and how it was answered from the chat, remembered to suggest the same
 * answer to a similar future question (spec 2026-09-26 §3). `project_name` is joined in for display;
 * it is null for an account-wide decision or an orphaned project.
 */
export interface ChatDecision {
  id: string;
  user_id: string;
  project_id: string | null;
  project_name: string | null;
  conversation_id: string | null;
  tab_question_id: string | null;
  question_index: number;
  header: string;
  question: string;
  options: DecisionOption[];
  multi_select: boolean;
  answer: DecisionAnswer;
  embed_model: string | null;
  suggested_count: number;
  accepted_count: number;
  /** Times this decision backed an automatic answer sent by the countdown (spec §D11). */
  auto_count: number;
  /** Where it holds (TER-1014); a card answer is `user`. */
  scope: DecisionScope;
  /** When it stops holding (TER-1014); null = never. */
  expires_at: string | null;
  created_at: string;
}

export interface NewDecision {
  user_id: string;
  project_id: string | null;
  conversation_id: string | null;
  tab_question_id: string | null;
  question_index: number;
  header: string;
  question: string;
  options: DecisionOption[];
  multi_select: boolean;
  answer: DecisionAnswer;
}

export interface DecisionNeighbour extends ChatDecision {
  similarity: number;
}

/** A `tab_questions` row the sweeper still owes a decision (spec §5): only ever a `choice`, `answered`. */
export interface AnsweredChoiceRow {
  id: string;
  project_id: string;
  conversation_id: string;
  answered_by: string;
  payload: unknown;
  answer: unknown;
}

/** Row shape shared by the raw queries below: every `chat_decisions` column but `embedding` itself
 *  (never selected — it is write-only from here, and never logged), plus the project name join. */
interface RawRow {
  id: string;
  user_id: string;
  project_id: string | null;
  project_name: string | null;
  conversation_id: string | null;
  tab_question_id: string | null;
  question_index: number;
  header: string;
  question: string;
  options: unknown;
  multi_select: boolean;
  answer: unknown;
  embed_model: string | null;
  suggested_count: number;
  accepted_count: number;
  auto_count: number;
  scope: string;
  expires_at: Date | null;
  created_at: Date;
}

const DECISION_COLUMNS = Prisma.raw(
  `id, user_id, project_id, conversation_id, tab_question_id, question_index, header, question, options, multi_select, answer, embed_model, suggested_count, accepted_count, auto_count, scope, expires_at, created_at`,
);

/** Shared column list for the raw SELECTs below, aliased through `d` and joined to `projects` for
 *  `project_name` — everything but `embedding` itself (never selected — write-only from here). */
const DECISION_SELECT = Prisma.raw(
  `d.id, d.user_id, d.project_id, p.name AS project_name, d.conversation_id, d.tab_question_id, d.question_index, d.header, d.question, d.options, d.multi_select, d.answer, d.embed_model, d.suggested_count, d.accepted_count, d.auto_count, d.scope, d.expires_at, d.created_at`,
);

/** The person's picked label(s) and free text, as one tsvector-able string — never the raw jsonb keys
 *  ("labels", "text"), which would match every row. Repeated between WHERE and ORDER BY on purpose:
 *  a CTE alias would need a LATERAL join for one extra clarity point that is not worth it here. */
const answerTextExpr = Prisma.raw(
  `coalesce((SELECT string_agg(l, ' ') FROM jsonb_array_elements_text(d.answer->'labels') l), '') || ' ' || coalesce(d.answer->>'text', '')`,
);

/** pgvector's text input format: `[x,y,z]`. Never-finite components (NaN, Infinity) are zeroed rather
 *  than sent malformed, since a bad embedding would otherwise fail the whole write. */
const toVector = (v: number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

const mapRaw = (r: RawRow): ChatDecision => ({
  id: r.id,
  user_id: r.user_id,
  project_id: r.project_id,
  project_name: r.project_name,
  conversation_id: r.conversation_id,
  tab_question_id: r.tab_question_id,
  question_index: r.question_index,
  header: r.header,
  question: r.question,
  options: r.options as DecisionOption[],
  multi_select: r.multi_select,
  answer: r.answer as DecisionAnswer,
  embed_model: r.embed_model,
  suggested_count: r.suggested_count,
  accepted_count: r.accepted_count,
  auto_count: r.auto_count,
  scope: r.scope as DecisionScope,
  expires_at: r.expires_at ? r.expires_at.toISOString() : null,
  created_at: r.created_at.toISOString(),
});

/** ` AND d.project_id = …` when a search is held to one project, nothing otherwise. */
const projectFilter = (projectId: string | undefined) => (projectId ? Prisma.sql` AND d.project_id = ${projectId}` : Prisma.empty);

/** ` AND <the decision holds at place>` (TER-1014): in scope there and, unless asked, not expired. */
const holdsFilter = (place: DecisionPlace, includeExpired = false) =>
  Prisma.sql` AND ${holdsAtSql({ scope: Prisma.raw('d.scope'), projectId: Prisma.raw('d.project_id'), conversationId: Prisma.raw('d.conversation_id'), expiresAt: Prisma.raw('d.expires_at') }, place, includeExpired)}`;

/** Where a search reads decisions (TER-1014): `place` and whether expired ones count. */
export interface DecisionSearchPlace extends DecisionPlace {
  includeExpired?: boolean;
}

/** Escapes a person's search text for a LIKE/ILIKE pattern: `%`/`_` are wildcards and `\` is the
 *  escape character itself, so all three must be escaped before wrapping in `%…%`. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Keyset cursor over `(created_at, id)`, newest first: opaque to the caller, defensively decoded — an
 *  old, foreign or tampered cursor is treated as "no cursor" (first page) rather than an error. */
const encodeCursor = (createdAt: Date, id: string): string => Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
const decodeCursor = (cursor: string): { createdAt: Date; id: string } | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    const createdAt = new Date(parsed[0]);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed[1] };
  } catch {
    return null;
  }
};

/**
 * Chat decision memory (spec 2026-09-26): the `choice` questions a person already answered from the
 * chat, embedded for similarity search (pgvector, raw SQL throughout — `embedding` is an
 * `Unsupported` Prisma type) so a near-identical future question can suggest the same answer.
 */
export class ChatDecisionsRepository {
  constructor(private db: PrismaClient) {}

  /**
   * One row per question of an answered `AskUserQuestion` payload (a payload can hold up to 4). The
   * unique `(tab_question_id, question_index)` index makes recording idempotent: replaying the same
   * tab question's decisions (the backfill sweep, a retried write) inserts nothing the second time and
   * returns `[]` for it, never a duplicate row.
   */
  async insertMany(rows: NewDecision[]): Promise<ChatDecision[]> {
    if (rows.length === 0) return [];
    return this.db.$transaction(async (tx) => {
      const out: ChatDecision[] = [];
      for (const r of rows) {
        const [row] = await tx.$queryRaw<RawRow[]>`
          WITH ins AS (
            INSERT INTO "chat_decisions" ("id", "user_id", "project_id", "conversation_id", "tab_question_id", "question_index", "header", "question", "options", "multi_select", "answer")
            VALUES (${newId()}, ${r.user_id}, ${r.project_id}, ${r.conversation_id}, ${r.tab_question_id}, ${r.question_index}, ${r.header}, ${r.question}, ${JSON.stringify(r.options)}::jsonb, ${r.multi_select}, ${JSON.stringify(r.answer)}::jsonb)
            ON CONFLICT ("tab_question_id", "question_index") WHERE "tab_question_id" IS NOT NULL DO NOTHING
            RETURNING ${DECISION_COLUMNS}
          )
          SELECT ins.*, p.name AS project_name FROM ins LEFT JOIN "projects" p ON p.id = ins.project_id`;
        if (row) out.push(mapRaw(row));
      }
      return out;
    });
  }

  async setEmbedding(id: string, vector: number[], model: string): Promise<void> {
    const v = toVector(vector);
    await this.db.$executeRaw`UPDATE "chat_decisions" SET "embedding" = ${v}::vector, "embed_model" = ${model} WHERE "id" = ${id}`;
  }

  /** The sweeper's backlog, at most `limit` rows: never embedded (first, oldest first), then embedded
   *  under another text version — `embed_model` not ending with `tag` (`'#q1'`), e.g. a row the previous
   *  release wrote untagged during a blue/green overlap (TER-204). `embedding` is `Unsupported` in
   *  Prisma, so this and every other read that touches it goes through raw SQL. */
  async listToEmbed(limit: number, tag: string): Promise<Pick<ChatDecision, 'id' | 'header' | 'question' | 'options'>[]> {
    const rows = await this.db.$queryRaw<{ id: string; header: string; question: string; options: unknown }[]>`
      SELECT id, header, question, options FROM "chat_decisions"
      WHERE embedding IS NULL OR embed_model IS NULL OR right(embed_model, length(${tag})) <> ${tag}
      ORDER BY (embedding IS NULL) DESC, created_at ASC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, header: r.header, question: r.question, options: r.options as DecisionOption[] }));
  }

  /** The `k` nearest decisions of this user, same `multi_select` shape, best (highest cosine similarity)
   *  first. Never another user's rows, never the other `multi_select` shape, never an unembedded row.
   *  Only rows embedded with exactly `embedModel` (model + text version, `embedTag`): a vector of another
   *  model or text version is not comparable. An exact scan over the user's rows, on purpose: no ANN
   *  index, so no row of this user is ever lost to an approximate index's post-filtering, and one
   *  person's decisions are few enough to scan. Only decisions that hold at `opts.place` (TER-1014): never
   *  an expired one, never one scoped to another project or conversation — this is the precedent read. */
  async nearest(userId: string, vector: number[], opts: { multiSelect: boolean; k: number; embedModel: string; place: DecisionPlace }): Promise<DecisionNeighbour[]> {
    const v = toVector(vector);
    const rows = await this.db.$queryRaw<(RawRow & { similarity: number | string })[]>`
      SELECT ${DECISION_SELECT}, 1 - (d.embedding <=> ${v}::vector) AS similarity
      FROM "chat_decisions" d LEFT JOIN "projects" p ON p.id = d.project_id
      WHERE d.user_id = ${userId} AND d.embedding IS NOT NULL AND d.multi_select = ${opts.multiSelect} AND d.embed_model = ${opts.embedModel}${holdsFilter(opts.place)}
      ORDER BY d.embedding <=> ${v}::vector
      LIMIT ${opts.k}`;
    return rows.map((r) => ({ ...mapRaw(r), similarity: Number(r.similarity) }));
  }

  /** Same as `nearest`, but across both `multi_select` shapes (a `search_memory` caller has no
   *  question payload to match a shape against — only `answer_tab_question`'s own precedent check
   *  does, and it re-verifies the shape itself with `mapAnswer`). `projectId` keeps only that
   *  project's rows (a tab token's search, TER-212 D3); `place` keeps the ones that hold there (TER-1014). */
  async nearestAny(userId: string, vector: number[], k: number, projectId?: string, place: DecisionSearchPlace = {}): Promise<DecisionNeighbour[]> {
    const v = toVector(vector);
    const rows = await this.db.$queryRaw<(RawRow & { similarity: number | string })[]>`
      SELECT ${DECISION_SELECT}, 1 - (d.embedding <=> ${v}::vector) AS similarity
      FROM "chat_decisions" d LEFT JOIN "projects" p ON p.id = d.project_id
      WHERE d.user_id = ${userId} AND d.embedding IS NOT NULL${projectFilter(projectId)}${holdsFilter(place, place.includeExpired)}
      ORDER BY d.embedding <=> ${v}::vector
      LIMIT ${k}`;
    return rows.map((r) => ({ ...mapRaw(r), similarity: Number(r.similarity) }));
  }

  /**
   * Cosine similarity (`1 - (embedding <=> v)`) of each named row to `vector`, for `answer_tab_question`'s
   * similarity floor (spec 2026-09-26 concierge memory D6): the cited decision must be about a question
   * like this one, not just share its answer. Owner-scoped; a row that is another user's, missing, or
   * not embedded yet, or embedded under another model or text version (`embedModel`, the `embedTag` of
   * the query vector — TER-204), is simply absent from the map (the caller treats absent as "not similar").
   */
  async similarityTo(ids: string[], userId: string, vector: number[], embedModel: string): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const v = toVector(vector);
    const rows = await this.db.$queryRaw<{ id: string; similarity: number | string }[]>`
      SELECT d.id, 1 - (d.embedding <=> ${v}::vector) AS similarity
      FROM "chat_decisions" d
      WHERE d.user_id = ${userId} AND d.embedding IS NOT NULL AND d.embed_model = ${embedModel} AND d.id IN (${Prisma.join(ids)})`;
    return new Map(rows.map((r) => [r.id, Number(r.similarity)]));
  }

  /** Postgres full-text over header, question and the answer's labels/text (never the raw jsonb keys),
   *  best `ts_rank` first — same no-index trade-off as `MemoryItemsRepository.textSearch` (D5). A
   *  query with no lexeme (only punctuation) matches nothing rather than throwing. `projectId` keeps
   *  only that project's rows (a tab token's search, TER-212 D3), as it does for `nearestAny`, and so
   *  does `place` (TER-1014). */
  async textSearch(userId: string, query: string, k: number, projectId?: string, place: DecisionSearchPlace = {}): Promise<(ChatDecision & { rank: number })[]> {
    const rows = await this.db.$queryRaw<RawRow[]>`
      WITH q AS (SELECT websearch_to_tsquery('simple', ${query}) AS tsq)
      SELECT ${DECISION_SELECT}
      FROM "chat_decisions" d CROSS JOIN q LEFT JOIN "projects" p ON p.id = d.project_id
      WHERE d.user_id = ${userId}${projectFilter(projectId)}${holdsFilter(place, place.includeExpired)}
        AND numnode(q.tsq) > 0
        AND to_tsvector('simple', d.header || ' ' || d.question || ' ' || ${answerTextExpr}) @@ q.tsq
      ORDER BY ts_rank(to_tsvector('simple', d.header || ' ' || d.question || ' ' || ${answerTextExpr}), q.tsq) DESC, d.created_at DESC
      LIMIT ${k}`;
    return rows.map((r, i) => ({ ...mapRaw(r), rank: i + 1 }));
  }

  /** Only the ids this user owns — `search_memory`'s citations are re-checked against the caller
   *  before being shown, never trusted as-is. */
  async findManyForUser(ids: string[], userId: string): Promise<ChatDecision[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.$queryRaw<RawRow[]>`
      SELECT ${DECISION_SELECT}
      FROM "chat_decisions" d LEFT JOIN "projects" p ON p.id = d.project_id
      WHERE d.user_id = ${userId} AND d.id IN (${Prisma.join(ids)})`;
    return rows.map(mapRaw);
  }

  /** An automatic answer backed this decision (spec D11): counted, never recorded as a new row. */
  async bumpAuto(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.chatDecision.updateMany({ where: { id: { in: ids } }, data: { autoCount: { increment: 1 } } });
  }

  async bumpSuggested(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.chatDecision.updateMany({ where: { id: { in: ids } }, data: { suggestedCount: { increment: 1 } } });
  }

  async bumpAccepted(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.chatDecision.updateMany({ where: { id: { in: ids } }, data: { acceptedCount: { increment: 1 } } });
  }

  /** Newest first, for the "Memória do chat" list: `q` searches header, question, project name and the
   *  answer's label/text values — never the raw jsonb, whose keys ("labels", "text") would match every
   *  row — case-insensitive, substring; the cursor is a keyset over `(created_at, id)`. */
  async listForUser(userId: string, opts: { q?: string; cursor?: string; limit: number }): Promise<{ items: ChatDecision[]; next_cursor: string | null }> {
    const q = opts.q?.trim();
    const like = q ? `%${escapeLike(q)}%` : null;
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const rows = await this.db.$queryRaw<RawRow[]>`
      SELECT ${DECISION_SELECT}
      FROM "chat_decisions" d LEFT JOIN "projects" p ON p.id = d.project_id
      WHERE d.user_id = ${userId}
        AND (${like}::text IS NULL
          OR d.header ILIKE ${like} ESCAPE '\\' OR d.question ILIKE ${like} ESCAPE '\\' OR p.name ILIKE ${like} ESCAPE '\\'
          OR d.answer->>'text' ILIKE ${like} ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(d.answer->'labels') = 'array' THEN d.answer->'labels' ELSE '[]'::jsonb END) AS l(label) WHERE l.label ILIKE ${like} ESCAPE '\\'))
        AND (${cur === null}::boolean OR (d.created_at, d.id) < (${cur?.createdAt ?? new Date(0)}, ${cur?.id ?? ''}))
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${opts.limit + 1}`;
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const next_cursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
    return { items: page.map(mapRaw), next_cursor };
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    const { count } = await this.db.chatDecision.deleteMany({ where: { id, userId } });
    return count > 0;
  }

  countForUser(userId: string): Promise<number> {
    return this.db.chatDecision.count({ where: { userId } });
  }

  /**
   * A `choice` question the chat answered but the sweeper has not yet turned into decisions (spec §5):
   * never a `permission` row, never one still `open` (only `answered` questions are remembered), and
   * never one answered in the last minute — `claim` sets `status: 'answered'` before the keys are sent
   * to the tab, so a row this fresh may still fail to send and never truly count as answered. `excludeIds`
   * lets the sweeper skip rows it already found unparseable this run (or a recent one) without them
   * blocking every row behind them at the head of the `ORDER BY`.
   */
  async listAnsweredChoicesWithoutDecision(limit: number, excludeIds: string[] = []): Promise<AnsweredChoiceRow[]> {
    const exclude = excludeIds.length > 0 ? Prisma.sql`AND q.id NOT IN (${Prisma.join(excludeIds)})` : Prisma.empty;
    return this.db.$queryRaw<AnsweredChoiceRow[]>`
      SELECT q.id, q.project_id, q.conversation_id, q.answered_by, q.payload, q.answer
      FROM "tab_questions" q
      WHERE q.kind = 'choice' AND q.status = 'answered' AND q.answered_by IS NOT NULL AND q.answer IS NOT NULL
        AND q.answered_at < now() - interval '1 minute'
        AND NOT EXISTS (SELECT 1 FROM "chat_decisions" d WHERE d.tab_question_id = q.id)
        ${exclude}
      ORDER BY q.answered_at ASC LIMIT ${limit}`;
  }
}
