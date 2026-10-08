import type { FastifyBaseLogger } from 'fastify';
import type { AnsweredChoiceRow, ChatDecision, DecisionTrust, NewDecision } from '../db/repositories/chat-decisions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { answerToDecision, embedTag, embedText, EMBED_TEXT_VERSION, mapAnswer, sameAnswer, type SuggestionItem, type TabQuestionSuggestion } from './decision-text.js';
import { defaultEmbedder, EMBED_TIMEOUT_MS, memoryCode, withTimeout, type Embedder } from './embeddings.js';
import { checkChoiceAnswer, choiceAnswerBody, choicePayload, type ChoiceAnswer, type ChoicePayload } from './tab-question-payload.js';

/** Neighbours asked per question of a `choice` payload (spec 2026-09-26 §4). */
export const SUGGEST_K = 5;

export interface MemoryDeps {
  embedder: Embedder | null;
  threshold: number;
  timeoutMs?: number;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

/**
 * A suggestion to pre-select on a freshly opened `choice` question, drawn from the person's own past
 * decisions (spec 2026-09-26 §4): suggest only, never sent — nothing here touches the tab. Best effort
 * throughout, and never throws: a slow or failing embeddings service, an unlucky query, the setting
 * being off, or a payload with nothing similar all resolve to `null` rather than delay or fail the
 * card. Never logs question or answer text, only ids, counts, codes and similarity numbers.
 */
export async function suggestFor(repos: Pick<Repositories, 'users' | 'chatDecisions'>, row: TabQuestion, deps: MemoryDeps): Promise<TabQuestionSuggestion | null> {
  if (row.kind !== 'choice' || !deps.embedder) return null;
  const embedder = deps.embedder;
  const items = (row.payload as ChoicePayload).questions;
  if (items.length === 0) return null;

  // Set once the caller has stopped waiting (the timeout fired): `work()` below keeps running past
  // that point (nothing here cancels an in-flight embed or query), and must not bump counters or log
  // a "found" line for a suggestion the card was already published without.
  let abandoned = false;

  const work = async (): Promise<TabQuestionSuggestion | null> => {
    if (!(await repos.users.chatSuggestions(row.user_id))) return null;
    const texts = items.map(embedText);
    const { model, vectors } = await embedder.embed(texts);
    const found: SuggestionItem[] = [];
    for (const [i, item] of items.entries()) {
      // A question that normalises to '' (e.g. only "?" or "...") would embed identically to every
      // other empty question and match them at similarity 1.0 — never a real match, so it never even
      // asks `nearest`.
      if (texts[i] === '') continue;
      const near = await repos.chatDecisions.nearest(row.user_id, vectors[i]!, { multiSelect: item.multi_select, k: SUGGEST_K, embedModel: embedTag(model) });
      // Newest first among the ones close enough: a fresher decision beats a stronger but stale match.
      const candidates = near.filter((n) => n.similarity >= deps.threshold).sort((a, b) => b.created_at.localeCompare(a.created_at));
      for (const c of candidates) {
        const mapped = mapAnswer(c.answer, item);
        if (!mapped) continue; // the past labels no longer match this question's options — try the next
        found.push({ question_index: i, decision_id: c.id, similarity: c.similarity, ...mapped, source: { question: c.question, project_name: c.project_name, answered_at: c.created_at } });
        break;
      }
    }
    if (found.length === 0 || abandoned) return null;
    await repos.chatDecisions.bumpSuggested(found.map((f) => f.decision_id));
    const best = Math.round(Math.max(...found.map((f) => f.similarity)) * 1000) / 1000;
    deps.log.info({ tabQuestionId: row.id, items: found.length, best }, 'decision suggestion found');
    return { items: found };
  };

  try {
    return await withTimeout(work(), deps.timeoutMs ?? EMBED_TIMEOUT_MS, () => {
      abandoned = true;
    });
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, code: memoryCode(err) }, 'decision suggestion skipped');
    return null;
  }
}

/**
 * One `NewDecision` per question of an answered `choice` row (spec 2026-09-26 §4.3): `options` drop
 * `recommended` (never stored — a suggestion is only ever ranked on similarity and recency, not on
 * what Claude Code recommended when it was asked). `userId` is the caller's to give: `answered_by` for
 * a live answer, the same column read straight off `AnsweredChoiceRow` for the sweeper's backfill.
 * `trust` is `person` for a click and `derived` for an answer the countdown sent (TER-1006). An
 * unanswered row (`answer` still null — should not happen, the caller only calls this once claimed)
 * gives no decisions rather than throwing.
 */
export function decisionsOf(row: Pick<TabQuestion, 'id' | 'project_id' | 'conversation_id' | 'payload' | 'answer'>, userId: string, trust: DecisionTrust = 'person'): NewDecision[] {
  if (!row.answer) return [];
  const payload = row.payload as ChoicePayload;
  const answer = row.answer as ChoiceAnswer;
  const decisions: NewDecision[] = [];
  for (const [i, item] of payload.questions.entries()) {
    const a = answer.answers[i];
    if (!a) continue; // shape already checked at answer time (checkChoiceAnswer); guard anyway
    decisions.push({
      user_id: userId,
      project_id: row.project_id,
      conversation_id: row.conversation_id,
      tab_question_id: row.id,
      question_index: i,
      header: item.header,
      question: item.question,
      options: item.options.map((o) => ({ label: o.label, description: o.description })),
      multi_select: item.multi_select,
      answer: answerToDecision(item, { selected: a.selected, text: a.text }),
      trust,
    });
  }
  return decisions;
}

/**
 * Embeds a freshly inserted batch of decisions right away, best effort: on failure the row is simply
 * left without a vector for the sweeper (`embedPending`) to pick up later. Never throws — the caller
 * fires this without awaiting it, so an unhandled rejection here would otherwise escape unnoticed.
 */
async function embedInserted(repos: Pick<Repositories, 'chatDecisions'>, embedder: Embedder, rows: ChatDecision[], log: Pick<FastifyBaseLogger, 'warn'>, timeoutMs?: number): Promise<void> {
  try {
    const { model, vectors } = await withTimeout(embedder.embed(rows.map(embedText)), timeoutMs ?? EMBED_TIMEOUT_MS, () => {});
    await Promise.all(rows.map((r, i) => repos.chatDecisions.setEmbedding(r.id, vectors[i]!, embedTag(model))));
  } catch (err) {
    log.warn({ count: rows.length, code: memoryCode(err) }, 'decision embed failed');
  }
}

/**
 * Remembers an answered `choice` question (spec 2026-09-26 §4.3), right after its keys reached the
 * tab: never throws, so a db hiccup here must not turn an already-sent answer into a failed request.
 * `insertMany` is idempotent (unique on `tab_question_id, question_index`), so a retried call inserts
 * nothing twice. Accepted counting compares the suggestion this card was opened with, if any, against
 * what was actually sent (`sameAnswer`): a suggestion item whose selection the person kept counts as
 * accepted, one they changed does not. Embedding the freshly inserted rows is fire-and-forget — it
 * must not hold up the response for up to `EMBED_TIMEOUT_MS`, and a row left unembedded here is
 * finished later by the sweeper (`embedPending`). With no embedder at all, embedding is skipped
 * entirely and left for the sweeper. Never logs the question or the answer, only ids and codes.
 */
export async function recordDecisions(repos: Pick<Repositories, 'chatDecisions'>, row: TabQuestion, deps: Omit<MemoryDeps, 'threshold'>): Promise<void> {
  if (row.kind !== 'choice') return;
  try {
    const userId = row.answered_by ?? row.user_id;
    const decisions = decisionsOf(row, userId);
    if (decisions.length === 0) return;
    const inserted = await repos.chatDecisions.insertMany(decisions);
    if (inserted.length === 0) return;

    const suggestion = row.suggestion;
    if (suggestion) {
      const answer = row.answer as ChoiceAnswer;
      const acceptedIds = suggestion.items
        .filter((item) => {
          const a = answer.answers[item.question_index];
          return a !== undefined && sameAnswer({ selected: item.selected, text: item.text }, { selected: a.selected, text: a.text });
        })
        // A concierge suggestion that cited no decision carries an empty id (spec 2026-09-26 concierge memory §5.4).
        .flatMap((item) => (item.decision_id ? [item.decision_id] : []));
      if (acceptedIds.length > 0) await repos.chatDecisions.bumpAccepted(acceptedIds);
    }

    if (deps.embedder) void embedInserted(repos, deps.embedder, inserted, deps.log, deps.timeoutMs);
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, code: memoryCode(err) }, 'decision record failed');
  }
}

/** `backfillDecisions`'s outcome for one sweep: `skipped` is every row's id the sweeper could not use
 *  this run (bad shape, an answer that does not fit its payload, or an unexpected error inserting it) —
 *  the caller (`startDecisionSweeper`) feeds these back as `excludeIds` so they stop sitting at the head
 *  of the next `ORDER BY answered_at` and blocking whatever comes after them. */
export interface BackfillResult {
  inserted: number;
  skipped: string[];
}

/**
 * Turns already-answered `choice` questions that predate this feature (or were answered while the
 * embeddings service was down) into decisions (spec §5): one batch of `listAnsweredChoicesWithoutDecision`
 * (`excludeIds` skips rows a previous run in this process already gave up on), each row validated
 * against the stored shapes — `choicePayload` for the payload, `choiceAnswerBody` for the answer — and
 * cross-checked with `checkChoiceAnswer` (an answer whose selected index no longer fits its own payload
 * parses fine on its own but would otherwise throw inside `answerToDecision`). A row that fails any of
 * that, or whose insert itself throws, is skipped rather than aborting the batch — one bad row must
 * never stop every row behind it from being recorded. Returns the number of decisions inserted (not
 * rows visited: a multi-question row gives several) and the skipped row ids.
 *
 * Only a click (`answered_via` `'card'`, or null on a row from before the column) is the person's
 * decision. An answer the countdown sent — a precedent repeated (`'auto'`) or the option a run picked
 * as "(Recomendado)" (`'automation'`) — is recorded `derived` (TER-1006): kept for `search_memory` and
 * the "Memória do chat" list, never a precedent for the next automatic answer (spec D2/D11), so the
 * memory cannot feed on itself.
 */
export async function backfillDecisions(repos: Pick<Repositories, 'chatDecisions'>, limit = 32, excludeIds: string[] = []): Promise<BackfillResult> {
  const rows: AnsweredChoiceRow[] = await repos.chatDecisions.listAnsweredChoicesWithoutDecision(limit, excludeIds);
  let inserted = 0;
  const skipped: string[] = [];
  for (const row of rows) {
    try {
      const payload = choicePayload.safeParse(row.payload);
      const answer = choiceAnswerBody.safeParse(row.answer);
      if (!payload.success || !answer.success || checkChoiceAnswer(payload.data, answer.data)) {
        skipped.push(row.id);
        continue;
      }
      const trust: DecisionTrust = (row.answered_via ?? 'card') === 'card' ? 'person' : 'derived';
      const decisions = decisionsOf({ id: row.id, project_id: row.project_id, conversation_id: row.conversation_id, payload: payload.data, answer: answer.data }, row.answered_by, trust);
      if (decisions.length === 0) {
        skipped.push(row.id);
        continue;
      }
      const rowsInserted = await repos.chatDecisions.insertMany(decisions);
      inserted += rowsInserted.length;
    } catch {
      skipped.push(row.id);
    }
  }
  return { inserted, skipped };
}

/**
 * Embeds the sweeper's backlog (spec §5): rows `recordDecisions` inserted with no embedder configured,
 * or whose fire-and-forget embed failed, and rows embedded under another text version (TER-204), which
 * is how a deploy re-embeds the old ones. One request for the whole batch, one `setEmbedding` per row.
 * Errors propagate to the caller (`startDecisionSweeper`), which logs them — this function does not.
 */
export async function embedPending(repos: Pick<Repositories, 'chatDecisions'>, embedder: Embedder, limit = 32): Promise<number> {
  const rows = await repos.chatDecisions.listToEmbed(limit, '#' + EMBED_TEXT_VERSION);
  if (rows.length === 0) return 0;
  const { model, vectors } = await embedder.embed(rows.map(embedText));
  await Promise.all(rows.map((r, i) => repos.chatDecisions.setEmbedding(r.id, vectors[i]!, embedTag(model))));
  return rows.length;
}

/** How often the sweeper ticks (spec §5): backfill first, embed second. */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** How many skipped-row ids the sweeper remembers across ticks (in-memory, this process only): enough
 *  to keep a batch of unparseable rows from ever blocking the ones behind them, without growing without
 *  bound if the backlog of bad rows is itself unbounded. */
const MAX_SKIPPED_IDS = 1000;

/**
 * Keeps the memory complete without holding up anything else (spec §5): backfills decisions from
 * questions answered before this feature shipped (or while the embeddings service was down), then
 * embeds whatever that backfill or a live answer left without a vector — this still runs with no
 * embedder configured (spec §4.5: decisions are recorded even when suggestions/embedding are off), only
 * the embed step itself is then skipped. Runs once right away and then every `intervalMs`; the timer is
 * `unref`'d so it never keeps the process (or a test run) alive, and the caller must not `await` this
 * function — its first run must not block app startup. `embedder` left out entirely resolves
 * `defaultEmbedder()` (the configured service, if any); passing `null` explicitly (as opposed to
 * leaving it out) turns embedding off on purpose. A `running` guard skips a tick that overlaps the
 * previous one still in flight (a slow backfill or embed call outliving `intervalMs`). Never throws out
 * of a tick: each step logs its own outcome, counts and codes only.
 */
export function startDecisionSweeper(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, embedder?: Embedder | null, intervalMs = SWEEP_INTERVAL_MS): () => void {
  const embed = embedder !== undefined ? embedder : defaultEmbedder();
  // Rows this process already gave up on: fed back as `excludeIds` so they stop sitting at the head of
  // every `ORDER BY answered_at` and blocking whatever comes after them (spec §5).
  const skippedIds = new Set<string>();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      try {
        const { inserted, skipped } = await backfillDecisions(repos, 32, [...skippedIds]);
        for (const id of skipped) {
          skippedIds.add(id);
          if (skippedIds.size > MAX_SKIPPED_IDS) skippedIds.delete(skippedIds.values().next().value!);
        }
        if (inserted > 0) log.info({ backfilled: inserted }, 'chat decisions backfilled');
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'chat decision backfill failed');
      }
      if (!embed) return;
      try {
        const embedded = await embedPending(repos, embed);
        if (embedded > 0) log.info({ embedded }, 'chat decisions embedded');
      } catch (err) {
        log.warn({ code: memoryCode(err) }, 'chat decision embed sweep failed');
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
