import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { controlContextFor, type ControlContext } from '../control/context.js';
import type { ChatDecision } from '../db/repositories/chat-decisions.js';
import { holdsAt } from '../db/repositories/decision-scope.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutoAnswer, AutoAnswerBy, TabQuestion } from '../db/repositories/tab-questions.js';
import { toTabQuestionView, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
import type { MemoryRefKind } from '../control/memory.js';
import { HttpError, notFound } from '../lib/errors.js';
import { autoAnswerBlocked } from '../memory/blocklist.js';
import { automaticRunOfTab } from '../automation/pause.js';
import { labelKey, mapAnswer, sameAnswer } from './decision-text.js';
import { failureLabel } from './service.js';
import { answerTabQuestion, codeOf, isQuestionRow } from './tab-question-answer.js';
import { checkChoiceAnswer, type ChoiceAnswer, type ChoicePayload } from './tab-question-payload.js';
import { publishTabQuestions, type TabQuestionEventType } from './tab-questions.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** The repeat path's reason (spec §6, D9a): shown on the card and told to the concierge as is. */
export const REPEAT_REASON = 'Mesma pergunta respondida antes';
/** How often the sender sweeper ticks (spec §6). */
export const AUTO_ANSWER_SWEEP_MS = 5_000;
/** The repeat path's own similarity floor (spec §6, D9a "near-verbatim"): independent of
 * `DECISION_SUGGEST_THRESHOLD`, which an operator may lower for suggestions without making them automatic. */
export const REPEAT_MIN_SIMILARITY = 0.98;
/** How long after its claim a countdown still `sent` on an open card counts as lost (the sender died). */
export const SENDER_LOST_AFTER_MS = 2 * 60_000;
/** How many due countdowns one tick sends at most; the rest wait for the next tick. */
const SWEEP_BATCH = 20;

/**
 * Why `answer_tab_question`'s `mode: 'auto'` became a suggestion (spec 2026-09-26 concierge memory
 * §5.4): the person's switch is off (D8); the person already cancelled a countdown on this card; no
 * cited person decision equals the proposed answer (D6); the card names an irreversible act (D7's
 * blocklist); a multi-question card is backed for some of its questions but not all (D7); or the
 * backing decisions are about questions below the similarity floor, or it could not be measured (D6,
 * `AUTO_ANSWER_MIN_SIMILARITY`, fail closed). When several apply, the most decisive is reported:
 * `switch_off` > `cancelled_by_person` > `blocked` > `multi_question_partial` > `no_person_precedent`
 * > `not_similar`.
 */
export type Downgrade = 'switch_off' | 'cancelled_by_person' | 'no_person_precedent' | 'blocked' | 'multi_question_partial' | 'not_similar';

export interface ScheduleInput {
  row: TabQuestion;
  answer: ChoiceAnswer;
  by: AutoAnswerBy;
  reason: string;
  sources: { kind: MemoryRefKind; id: string }[];
  /** The precedent's similarity the concierge's check measured (TER-1011): the feed's score. */
  score?: number | null;
}

/**
 * Whether one question's proposed answer is exactly what one of `decisions` answered, once that past
 * answer is mapped onto this question's own options (`mapAnswer`: labels compared by `labelKey`, so
 * case and accents do not matter; a free-text past answer compares as text, trimmed). A label is not
 * the whole option: Claude Code's options often carry their meaning in `description` ("Opção 1" —
 * "faz merge e push para main"), so every chosen option's description must also equal the one the
 * precedent stored for that label (`labelKey` on both sides): the same label meaning something else
 * this time is not a precedent.
 */
export function decisionBacks(d: ChatDecision, item: ChoicePayload['questions'][number], a: ChoiceAnswer['answers'][number]): boolean {
  const mapped = mapAnswer(d.answer, item);
  if (mapped === null || !sameAnswer(mapped, { selected: a.selected, text: a.text })) return false;
  return a.selected.every((s) => {
    const option = item.options[s];
    if (!option) return false;
    const key = labelKey(option.label);
    const past = d.options.find((o) => labelKey(o.label) === key);
    return past !== undefined && labelKey(past.description ?? '') === labelKey(option.description ?? '');
  });
}

/**
 * The texts D7's blocklist reads for one card and its proposed answer: every question's header and
 * text, and the chosen options' labels and descriptions (or the free text). Shared by both paths —
 * the repeat path (`maybeScheduleRepeat`) and `answer_tab_question` — so neither can miss a field.
 */
export function blocklistParts(payload: ChoicePayload, answer: ChoiceAnswer): string[] {
  return payload.questions.flatMap((q, i) => {
    const a = answer.answers[i];
    if (!a) return [q.header, q.question];
    const chosen = a.selected.flatMap((s) => {
      const o = q.options[s];
      return o ? [o.label, o.description ?? ''] : [];
    });
    return [q.header, q.question, ...chosen, ...(a.text !== undefined ? [a.text] : [])];
  });
}

/**
 * The server's own check behind D6 — the model never decides this: every question of the card must
 * have at least one of the cited decisions (already verified as the caller's own `chat_decisions`
 * rows, trust `person`) whose past answer maps onto that question and equals the proposed answer,
 * descriptions included (`decisionBacks`). A card with two questions and a precedent for only one is
 * not backed. The repeat path's check (`maybeScheduleRepeat`).
 */
export function precedentBacks(decisions: ChatDecision[], payload: ChoicePayload, answer: ChoiceAnswer): boolean {
  if (answer.answers.length !== payload.questions.length) return false;
  return payload.questions.every((item, i) => decisions.some((d) => decisionBacks(d, item, answer.answers[i]!)));
}

/**
 * Whether an automatic answer may be scheduled or sent on this card: the person's "Responder sozinho"
 * switch (D8) is on, or the card's tab has an automatic run whose project is on and not paused — there
 * `automation.enabled` is the opt-in (agentic board spec D18, preflight F-17). Read again at send time.
 */
export async function autoAnswerAllowed(repos: Repositories, row: Pick<TabQuestion, 'user_id' | 'tab_id'>): Promise<boolean> {
  if (await repos.users.chatAutodecide(row.user_id)) return true;
  // fails closed: a run that cannot be read is no automatic run
  return (await automaticRunOfTab(repos, row.tab_id).catch(() => null)) !== null;
}

/**
 * Starts a countdown on a still-open `choice` card (spec §6): `auto_answer` in `scheduled`, due
 * `AUTO_ANSWER_DELAY_SECONDS` (default 60 s) from `now`, then the card is republished so every open
 * screen shows the countdown with "Cancelar" and "Responder agora". `setAutoAnswer` is conditional on
 * the row still `open` with no countdown already running, so a card that moved on, or one another
 * caller scheduled first, resolves `null` with nothing published. Sending is the sweeper's job, never
 * this function's. Logs nothing: the reason and answer are the person's words.
 */
export async function scheduleAutoAnswer(repos: Repositories, input: ScheduleInput, now = new Date()): Promise<TabQuestion | null> {
  const row = await storeAutoAnswer(repos, input, now);
  if (!row) return null;
  await publishTabQuestions(repos, 'tab_question', [row], { update: true });
  return row;
}

/** `scheduleAutoAnswer` without the publish: the repeat path runs inside `openTabQuestion`, which
 * announces the card itself, once, countdown included. */
async function storeAutoAnswer(repos: Repositories, input: ScheduleInput, now: Date): Promise<TabQuestion | null> {
  const auto: AutoAnswer = {
    answer: input.answer,
    by: input.by,
    reason: input.reason,
    sources: input.sources,
    ...(typeof input.score === 'number' ? { score: input.score } : {}),
    due_at: new Date(now.getTime() + config.autoAnswerDelayMs).toISOString(),
    status: 'scheduled',
  };
  return (await repos.tabQuestions.setAutoAnswer(input.row.id, auto)) ?? null;
}

/**
 * The repeat path (spec §6, D9a): a fresh `choice` card whose TER-57 suggestion already found a person
 * precedent for every one of its questions — an item with a non-empty `decision_id` and a similarity of
 * at least `REPEAT_MIN_SIMILARITY` (0.98, near-verbatim; its own floor, whatever the suggestion threshold
 * is set to) — starts a countdown on that suggestion by itself, with no LLM call. Everything else is a plain
 * suggested card (`null`): the switch off (D8), a concierge item (it cites no decision of its own), a
 * card with a question left unsuggested, an answer that no longer fits the payload, a card that already
 * had a countdown, a blocklist hit (D7) on any header, question, suggested label, its description or
 * text, or a cited decision that no longer backs the answer (`precedentBacks`: forgotten meanwhile, or
 * its chosen option described differently from this card's). The row is not published here
 * (`openTabQuestion` does it, once). Logs nothing.
 */
export async function maybeScheduleRepeat(repos: Repositories, row: TabQuestion, now = new Date()): Promise<TabQuestion | null> {
  if (row.kind !== 'choice' || row.status !== 'open' || row.auto_answer || !row.suggestion) return null;
  const payload = row.payload as ChoicePayload;
  const items = payload.questions.map((_q, i) => row.suggestion!.items.find((it) => it.question_index === i && it.decision_id !== '' && it.by !== 'concierge' && it.similarity >= REPEAT_MIN_SIMILARITY));
  if (items.some((it) => it === undefined)) return null;
  const answer: ChoiceAnswer = { answers: items.map((it) => ({ selected: it!.selected, ...(it!.text !== undefined ? { text: it!.text } : {}) })) };
  if (checkChoiceAnswer(payload, answer)) return null;
  if (autoAnswerBlocked(blocklistParts(payload, answer))) return null;
  if (!(await autoAnswerAllowed(repos, row))) return null;
  const ids = [...new Set(items.map((it) => it!.decision_id))];
  // The suggestion only says a decision was similar: re-read the ones it cites (the person's own,
  // still there) and check each still backs its answer, option descriptions included.
  // A decision a newer one replaced (TER-1015) is history, never a precedent: drop it before the check.
  const decisions = (await repos.chatDecisions.findManyForUser(ids, row.user_id)).filter((d) => !d.superseded_at);
  // TER-1014: a decision that expired or does not hold on this card's project/conversation is no precedent.
  const place = { projectId: row.project_id, conversationId: row.conversation_id };
  if (decisions.some((d) => !holdsAt(d, place, now))) return null;
  if (!precedentBacks(decisions, payload, answer)) return null;
  return storeAutoAnswer(repos, { row, answer, by: 'memory', reason: REPEAT_REASON, sources: ids.map((id) => ({ kind: 'decision' as const, id })) }, now);
}

/** Which event a card that changed goes out on, by where the row stands now. */
const eventFor = (row: TabQuestion): TabQuestionEventType => (row.status === 'open' ? 'tab_question' : row.status === 'answered' || row.status === 'failed' ? 'tab_question_answered' : 'tab_question_closed');

/**
 * One tick of the sender (spec §6): every due countdown, oldest first, at most `SWEEP_BATCH`. For each,
 * `claimAutoAnswer` (`scheduled → sent`, conditional) is the only thing that makes one process — one of
 * the two blue/green colors, or one of two overlapping ticks — the sender; a loser skips the row. The
 * winner sends through the ordinary answer path (`answerTabQuestion`) as the conversation's user with no
 * token — so the gate is not involved and the person's own grants, re-read now, apply — with `via:
 * 'auto'` (stored as `answered_via`, no decision recorded: D11) and no embedder. The live screen check,
 * the row's own `open` claim and every other check run as for a click. Then the cited decisions get
 * `auto_count + 1` (best effort: the keys are in the tab). Before sending, the switch (D8) and the cited
 * decisions are re-read: the switch off is `AUTODECIDE_OFF` (unless the tab has a live automatic run,
 * `autoAnswerAllowed`); a `by: 'automation'` countdown on a paused or disabled project is `AUTOMATION_OFF`; a cited decision forgotten meanwhile (by a
 * memory or concierge countdown alike) is `PRECEDENT_FORGOTTEN`. Any failure — the user gone, a lost grant
 * (403), the prompt moved (409), the send itself (502) — closes the countdown as `failed` with the code
 * and republishes the card; nothing else is typed. Resolves how many were sent. Logs ids, `by` and codes
 * only — never the answer nor the reason.
 */
export async function sendDueAutoAnswers(repos: Repositories, log: Log, deps: { now?: () => Date; answer?: typeof answerTabQuestion; shouldStop?: () => boolean } = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await repos.tabQuestions.listDueAutoAnswers(now, SWEEP_BATCH);
  let sent = 0;
  for (const row of due) {
    // Shutting down: what is not claimed yet stays `scheduled` for the other color (or the next start).
    if (deps.shouldStop?.()) break;
    const claimed = await repos.tabQuestions.claimAutoAnswer(row.id, now);
    if (!claimed?.auto_answer) continue;
    const auto = claimed.auto_answer;
    try {
      const user = await repos.users.findById(claimed.user_id);
      if (!user) throw new HttpError(404, 'Usuário não encontrado', 'USER_GONE');
      // Re-read now, not trusted from when it was scheduled: the switch (D8) — or, in a tab with an
      // automatic run, the project on and not paused (D18, D24) — and the precedents cited. The option
      // the agent recommended (`by: 'automation'`) goes out only while the run's project is live, whatever
      // the person's switch says.
      if (auto.by === 'automation') {
        if (!(await automaticRunOfTab(repos, claimed.tab_id))) throw new HttpError(409, 'Trabalho automático pausado ou desligado', 'AUTOMATION_OFF');
      } else if (!(await autoAnswerAllowed(repos, claimed))) throw new HttpError(409, 'Resposta automática desligada', 'AUTODECIDE_OFF');
      const cited = [...new Set(auto.sources.filter((s) => s.kind === 'decision').map((s) => s.id))];
      const precedents = cited.length ? await repos.chatDecisions.findManyForUser(cited, user.id) : [];
      if (precedents.length < cited.length) throw new HttpError(409, 'A decisão usada foi esquecida', 'PRECEDENT_FORGOTTEN');
      if (precedents.some((d) => d.superseded_at)) throw new HttpError(409, 'A decisão usada foi substituída', 'PRECEDENT_SUPERSEDED');
      // TER-1014: a precedent that expired during the countdown (or never held here) sends nothing.
      if (precedents.some((d) => !holdsAt(d, { projectId: claimed.project_id, conversationId: claimed.conversation_id }, now))) {
        throw new HttpError(409, 'A decisão usada expirou ou não vale aqui', 'PRECEDENT_EXPIRED');
      }
      await (deps.answer ?? answerTabQuestion)(controlContextFor(repos, user), claimed.id, auto.answer, { log, via: 'auto', embedder: null });
    } catch (err) {
      const code = codeOf(err, 'AUTO_ANSWER_FAILED');
      log.warn({ tabQuestionId: claimed.id, code }, 'auto answer failed');
      try {
        const failed = await repos.tabQuestions.finishAutoAnswer(claimed.id, 'failed', code);
        if (failed) await publishTabQuestions(repos, eventFor(failed), [failed], { update: true });
      } catch (recordErr) {
        // Best effort: the card still shows the question, and the countdown can no longer send.
        log.warn({ tabQuestionId: claimed.id, code: codeOf(recordErr, 'RECORD_FAILED') }, 'auto answer failure not recorded');
      }
      continue;
    }
    sent++;
    log.info({ tabQuestionId: claimed.id, by: auto.by }, 'auto answer sent');
    const ids = auto.sources.filter((s) => s.kind === 'decision').map((s) => s.id);
    try {
      if (ids.length) await repos.chatDecisions.bumpAuto(ids);
    } catch (err) {
      log.warn({ tabQuestionId: claimed.id, code: codeOf(err, 'BUMP_FAILED') }, 'auto answer count not bumped');
    }
  }
  return sent;
}

/**
 * Crash recovery (spec §6): every countdown claimed over `SENDER_LOST_AFTER_MS` ago and still `sent` on
 * an open card — its sender died (a stopped color, a crash) before typing or recording a failure — is
 * closed as `failed` `SENDER_LOST` and republished, so the card stops saying "sent" and is answered by
 * hand. Resolves how many. Logs ids and the code only.
 */
export async function recoverLostAutoAnswers(repos: Repositories, log: Log): Promise<number> {
  // Measured on the database's clock, the one that stamped `claimed_at`: two colors never disagree.
  const lost = await repos.tabQuestions.failLostAutoAnswers('SENDER_LOST', SENDER_LOST_AFTER_MS);
  for (const row of lost) log.warn({ tabQuestionId: row.id, code: 'SENDER_LOST' }, 'auto answer sender lost');
  if (lost.length) await publishTabQuestions(repos, 'tab_question', lost, { update: true });
  return lost.length;
}

/**
 * Runs a tick right away and every `intervalMs` (5 s): `recoverLostAutoAnswers`, then
 * `sendDueAutoAnswers`. A `running` guard skips a tick that overlaps the previous one in this process;
 * across processes the claim decides. The timer is `unref`'d, and a tick never throws: each step logs
 * its own code. The returned `stop` clears the timer, stops the batch in flight before its next claim
 * (so shutdown fits in the container's grace period) and resolves once the send already claimed is done
 * — the app awaits it before closing the database, so a claimed send is never cut in half.
 */
export function startAutoAnswerSweeper(repos: Repositories, log: Log, intervalMs = AUTO_ANSWER_SWEEP_MS): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let stopping = false;
  const run = async () => {
    try {
      await recoverLostAutoAnswers(repos, log);
    } catch (err) {
      log.warn({ code: failureLabel(err) }, 'auto answer recovery failed');
    }
    try {
      await sendDueAutoAnswers(repos, log, { shouldStop: () => stopping });
    } catch (err) {
      log.warn({ code: failureLabel(err) }, 'auto answer sweep failed');
    }
  };
  const tick = () => {
    if (inFlight || stopping) return;
    inFlight = run().finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await inFlight;
  };
}

/**
 * "Cancelar" on a countdown (spec §6): `scheduled → cancelled`, only on the caller's own card. The
 * proposed answer stays on the card as its pre-selection and the row stays `open`; every screen hears
 * it. 404 for a row that is not the caller's (or not a question), 409 `NOT_SCHEDULED` when no countdown
 * is running — already sent, failed, cancelled, or never there.
 */
export async function cancelAutoAnswer(ctx: ControlContext, id: string): Promise<TabQuestionView> {
  const userId = ctx.scope.user.id;
  const row = await ctx.repos.tabQuestions.findByIdForUser(id, userId);
  if (!isQuestionRow(row)) throw notFound('Pergunta não encontrada');
  const cancelled = await ctx.repos.tabQuestions.cancelAutoAnswer(id, userId);
  if (!cancelled) throw new HttpError(409, 'Não há resposta automática em contagem nesta pergunta', 'NOT_SCHEDULED');
  const [view] = await publishTabQuestions(ctx.repos, 'tab_question', [cancelled], { update: true });
  return view ?? toTabQuestionView(cancelled, null);
}
