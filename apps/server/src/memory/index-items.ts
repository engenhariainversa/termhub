import type { FastifyBaseLogger } from 'fastify';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import { describeActions } from '../db/repositories/chat-actions-view.js';
import type { Repositories } from '../db/repositories/index.js';
import type { DecisionScope } from '../db/repositories/decision-scope.js';
import type { MemoryItem, NewMemoryItem } from '../db/repositories/memory-items.js';
import { EMBED_TIMEOUT_MS, memoryCode, withTimeout, type Embedder } from '../chat/embeddings.js';
import { newId } from '../lib/ids.js';
import { cleanMemoryText, ITEM_TEXT_MAX, memoryText } from './text.js';

/** What every writer below needs: an embedder to fire an immediate embed with (best effort, `null` =
 *  none configured), and a logger — never the text, title or query, only ids, counts and codes (spec
 *  2026-09-26 concierge memory §4). */
export type MemoryDeps = { embedder: Embedder | null; log: Pick<FastifyBaseLogger, 'info' | 'warn'> };

/** Cuts cleaned text to the memory column's own limit (spec §3.1: `text` ≤ 1200 chars). */
const cut = (s: string): string => cleanMemoryText(s).slice(0, ITEM_TEXT_MAX);

/**
 * Embeds a freshly upserted batch of memory items right away, best effort: on failure the rows are
 * simply left without a vector for the sweeper (`embedPendingItems`) to pick up later. Never throws —
 * every writer below fires this without awaiting it, so an unhandled rejection here would otherwise
 * escape unnoticed. Never logs the embedded text or title, only the row count and a failure code.
 */
export async function embedInserted(repos: Pick<Repositories, 'memoryItems'>, embedder: Embedder, rows: MemoryItem[], log: Pick<FastifyBaseLogger, 'warn'>, timeoutMs?: number): Promise<void> {
  if (rows.length === 0) return;
  try {
    const { model, vectors } = await withTimeout(embedder.embed(rows.map(memoryText)), timeoutMs ?? EMBED_TIMEOUT_MS, () => {});
    await Promise.all(rows.map((r, i) => repos.memoryItems.setEmbedding(r.id, vectors[i]!, model)));
  } catch (err) {
    log.warn({ count: rows.length, code: memoryCode(err) }, 'memory embed failed');
  }
}

/**
 * Indexes the message a person typed in the chat (spec 2026-09-26 concierge memory D3/D4, §4): the
 * only chat text that is ever memory — an assistant turn, a re-injection or a wake quotes screens and
 * is never indexed (`ChatService.start` is the one caller that reaches this; `sendIn` never does).
 * Trust `person`: this is the user's own act. Longer than `ITEM_TEXT_MAX` chars, it becomes consecutive
 * chunks (`chunk_index` 0, 1, …) of the same message id, exactly like a doc's chunks. Never throws: a
 * db hiccup or a failing embed service must not turn a message that was already sent and stored into a
 * failed request — this always runs fire-and-forget from the caller. Never logs the message text.
 *
 * An attachment-only message (fix round 1) — files with no words, `text === ''` — cleans to nothing and
 * indexes nothing: an empty "Mensagem" item would be pure noise (nothing to match a future search
 * against) and would still cost a chunk 0 row forever, since nothing ever overwrites it.
 */
export async function indexMessage(
  repos: Pick<Repositories, 'memoryItems'>,
  m: { id: string; owner_id: string; project_id: string | null; text: string; created_at: string },
  deps: MemoryDeps,
): Promise<void> {
  try {
    const cleaned = cleanMemoryText(m.text);
    if (cleaned.length === 0) return;
    const pieces: string[] = [];
    for (let i = 0; i < cleaned.length; i += ITEM_TEXT_MAX) pieces.push(cleaned.slice(i, i + ITEM_TEXT_MAX));
    const items: NewMemoryItem[] = pieces.map((text, chunk_index) => ({
      owner_id: m.owner_id,
      project_id: m.project_id,
      kind: 'message',
      source_id: m.id,
      chunk_index,
      title: 'Mensagem',
      text,
      trust: 'person',
      source_at: new Date(m.created_at),
    }));
    const inserted = await repos.memoryItems.upsertMany(items);
    if (deps.embedder) void embedInserted(repos, deps.embedder, inserted, deps.log);
  } catch (err) {
    deps.log.warn({ code: memoryCode(err) }, 'memory index message failed');
  }
}

/** What a decided action reads as, once the model wrote it up (D3/§4): `describeActions`, the same
 *  sentence the card showed the user, quoted verbatim under the verdict. Trust `derived` — the sentence
 *  is the model's own proposal, not the person's words, even though the person is the one who decided. */
const verdictText = (status: ChatAction['status'], summary: string): string => `${status === 'approved' ? 'Usuário aprovou' : 'Usuário negou'}: ${summary}`;

/**
 * Indexes a batch of gate decisions right after `decide`/`decideMany` records them (spec §4): only
 * `approved`/`denied` rows (a `pending` or `expired` row was never decided and carries nothing to
 * remember). `describeActions` resolves each row's sentence exactly as the card showed it, scoped to
 * `userId` — the deciding user, never the action's own `decided_by` in case a caller ever passes a
 * batch from someone else's card by mistake. Fire-and-forget from every caller; never throws.
 */
export async function indexActions(repos: Repositories, userId: string, actions: ChatAction[], deps: MemoryDeps): Promise<void> {
  try {
    const decided = actions.filter((a) => a.status === 'approved' || a.status === 'denied');
    if (decided.length === 0) return;
    const cards = await describeActions(repos, decided, userId);
    const summaryById = new Map(cards.map((c) => [c.id, c.summary]));
    const items: NewMemoryItem[] = decided.map((a) => {
      const summary = summaryById.get(a.id) ?? a.tool;
      return {
        owner_id: userId,
        project_id: a.project_id,
        kind: 'action',
        source_id: a.id,
        chunk_index: 0,
        title: cleanMemoryText(summary),
        text: cut(verdictText(a.status, summary)),
        trust: 'derived',
        source_at: new Date(a.decided_at ?? a.created_at),
      };
    });
    const inserted = await repos.memoryItems.upsertMany(items);
    if (deps.embedder) void embedInserted(repos, deps.embedder, inserted, deps.log);
  } catch (err) {
    deps.log.warn({ code: memoryCode(err) }, 'memory index actions failed');
  }
}

/** One page of `listChangedForOwner` (spec §4, fix round 1): kept as its own constant so the per-tick
 *  cap below is stated in the same unit. */
const TASK_PAGE_LIMIT = 200;

/** How many pages one `indexTasks` call (one owner, one tick of the sweeper) will walk at most: bounds
 *  a single sweep's own work even for a very large backlog, while still making forward, monotonic
 *  progress every tick — a backlog bigger than this converges over the next tick(s) instead of never
 *  reaching past the first page at all (the fix round 1 bug: see below). */
const TASK_MAX_PAGES_PER_TICK = 25;

/**
 * Indexes this owner's changed cards and drops the ones whose task is gone (spec §4): a task whose
 * `updated_at` moved past its item's stored `source_at` (or that has no item yet) is upserted; one
 * whose `updated_at` did not move is left alone.
 *
 * The cursor is the **latest** `source_at` this owner's task items already carry (the epoch, the first
 * time) — never the earliest. Fix round 1: starting from the earliest known `source_at` re-asks for
 * "everything at or after the oldest thing I've already indexed", which for an owner with more cards
 * than one page is the *same* oldest page every single tick (that query's own `ORDER BY updated_at ASC
 * LIMIT` always lands on the same rows, since nothing about the query changed), so cards past the first
 * page were never indexed, however many times the sweeper ran. Starting from the latest known
 * `source_at` instead means a fresh tick only ever asks for cards this owner has not fully accounted
 * for yet — a brand new card, or an edited one (`updated_at` always jumps to "now", past any previous
 * watermark) — so the watermark only ever advances, and it advances *because the table itself changed*,
 * not because of anything this function remembers between calls: a restart loses nothing. Ties at the
 * exact watermark millisecond (several cards touched together, e.g. `add_subtasks`) are broken by the
 * largest id already recorded at that instant, so a page starting there does not re-read a sibling row
 * stamped the same millisecond — only the rare case of such a tie itself spanning more than one page
 * (over `TASK_PAGE_LIMIT` cards touched in the very same millisecond) is left as a known, narrow gap.
 *
 * A backlog bigger than one page is walked across as many pages as `TASK_MAX_PAGES_PER_TICK` allows,
 * in this same call: each page's cursor comes from the *last row that page actually returned*, never
 * recomputed independently, so pages never overlap and never skip. A backlog bigger than the whole
 * per-tick cap converges over the following tick(s) instead, since the watermark it leaves behind is
 * exactly where this call stopped.
 *
 * Deletion is a separate, exact check — every item's task id this owner still has, checked for
 * existence with the same owner-scoped `findByIdsForOwner` every other card lookup uses — so a card
 * merely not reached by this call's watermark yet is never mistaken for one that is gone. Called by the
 * sweeper, once per owner; propagates its own failures so the sweeper's own try/catch can log them and
 * move on to the next owner without this one silently doing nothing. Returns how many cards were
 * (re-)indexed.
 */
export async function indexTasks(repos: Repositories, ownerId: string, deps: MemoryDeps): Promise<number> {
  const sourceAt = await repos.memoryItems.listSourceAt('task', ownerId);
  let since = new Date(0);
  let afterId: string | undefined;
  if (sourceAt.size > 0) {
    const maxAt = Math.max(...[...sourceAt.values()].map((s) => Date.parse(s)));
    since = new Date(maxAt);
    for (const [id, at] of sourceAt) if (Date.parse(at) === maxAt && (afterId === undefined || id > afterId)) afterId = id;
  }

  let changed = 0;
  for (let page = 0; page < TASK_MAX_PAGES_PER_TICK; page++) {
    const tasks = await repos.tasks.listChangedForOwner(ownerId, since, TASK_PAGE_LIMIT, afterId);
    if (tasks.length === 0) break;
    const toWrite = tasks.filter((t) => {
      const known = sourceAt.get(t.id);
      return known === undefined || Date.parse(t.updated_at) > Date.parse(known);
    });
    if (toWrite.length > 0) {
      const items: NewMemoryItem[] = toWrite.map((t) => ({
        owner_id: ownerId,
        project_id: t.project_id,
        kind: 'task',
        source_id: t.id,
        chunk_index: 0,
        title: cleanMemoryText(`${t.ref} · ${t.title}`),
        text: cut(t.description ?? ''),
        trust: 'derived',
        source_at: new Date(t.updated_at),
      }));
      const inserted = await repos.memoryItems.upsertMany(items);
      if (deps.embedder) void embedInserted(repos, deps.embedder, inserted, deps.log);
      changed += toWrite.length;
    }
    const last = tasks[tasks.length - 1]!;
    since = new Date(last.updated_at);
    afterId = last.id;
    if (tasks.length < TASK_PAGE_LIMIT) break; // caught up: nothing newer left to see this tick
  }

  const knownIds = [...sourceAt.keys()];
  if (knownIds.length > 0) {
    const existing = await repos.tasks.findByIdsForOwner(knownIds, ownerId);
    const existingIds = new Set(existing.map((t) => t.id));
    const goneIds = knownIds.filter((id) => !existingIds.has(id));
    if (goneIds.length > 0) await repos.memoryItems.deleteBySource('task', goneIds);
  }

  return changed;
}

/**
 * Writes a `record_decision` note (spec D12/§5.2): `source_id` is the row's own id, since a note has
 * no other source to point at — minted here, before the insert, and threaded through as both `id` and
 * `source_id` (the repository's `NewMemoryItem.id` exists for exactly this). Unlike every other writer
 * here, this one throws: `record_decision` is a tool call, and the tool reports a failed write instead
 * of pretending the note was saved. The immediate embed, as always, is still best effort and fire-and-
 * forget — a failed embed never fails the note itself.
 */
export async function indexNote(
  repos: Pick<Repositories, 'memoryItems'>,
  note: {
    owner_id: string;
    project_id: string | null;
    question: string;
    decision: string;
    reason: string;
    sources: string[];
    /** TER-1014: where it holds, the conversation it was taken in, and when it stops holding. */
    scope?: DecisionScope;
    conversation_id?: string | null;
    expires_at?: Date | null;
  },
  deps: MemoryDeps,
): Promise<MemoryItem> {
  const id = newId();
  const item: NewMemoryItem = {
    id,
    owner_id: note.owner_id,
    project_id: note.project_id,
    kind: 'note',
    source_id: id,
    chunk_index: 0,
    title: cleanMemoryText(note.question),
    text: cut(`Decisão: ${note.decision}\nMotivo: ${note.reason}\nFontes: ${note.sources.join(', ')}`),
    trust: 'derived',
    scope: note.scope ?? null,
    conversation_id: note.conversation_id ?? null,
    expires_at: note.expires_at ?? null,
    source_at: new Date(),
  };
  const [inserted] = await repos.memoryItems.upsertMany([item]);
  const row = inserted!;
  if (deps.embedder) void embedInserted(repos, deps.embedder, [row], deps.log);
  return row;
}

/**
 * Embeds the sweeper's backlog (spec §4): rows a writer inserted with no embedder configured, or whose
 * fire-and-forget embed failed. One request for the whole batch, one `setEmbedding` per row. Errors
 * propagate to the caller (`startMemorySweeper`), which logs them — this function does not.
 */
export async function embedPendingItems(repos: Pick<Repositories, 'memoryItems'>, embedder: Embedder, limit = 32): Promise<number> {
  const rows = await repos.memoryItems.listToEmbed(limit);
  if (rows.length === 0) return 0;
  const { model, vectors } = await embedder.embed(rows.map(memoryText));
  await Promise.all(rows.map((r, i) => repos.memoryItems.setEmbedding(r.id, vectors[i]!, model)));
  return rows.length;
}
