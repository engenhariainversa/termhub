import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { controlContextFor, type ControlContext } from '../control/context.js';
import type { ChatDecision } from '../db/repositories/chat-decisions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutoAnswer, AutoAnswerBy, TabQuestion } from '../db/repositories/tab-questions.js';
import { toTabQuestionView, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
import type { MemoryItem } from '../db/repositories/memory-items.js';
import { HttpError, notFound } from '../lib/errors.js';
import { autoAnswerBlocked } from '../memory/blocklist.js';
import { parseRef, type MemoryRefKind } from '../memory/refs.js';
import { automaticRunOfTab } from '../automation/pause.js';
import { bandOf, thresholdsFor, type AutoBand, type AutoThresholds } from './auto-thresholds.js';
import { recordAutoSamples } from './decision-memory.js';
import { labelKey, mapAnswer, mapNoteAnswer, sameAnswer, suggestionRef } from './decision-text.js';
import { failureLabel } from './service.js';
import { answerTabQuestion, codeOf, isQuestionRow } from './tab-question-answer.js';
import { checkChoiceAnswer, type ChoiceAnswer, type ChoicePayload } from './tab-question-payload.js';
import { publishTabQuestions, type TabQuestionEventType } from './tab-questions.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;
const silentLog: Log = { info() {}, warn() {} };

/** The memory path's reasons (spec §6, D9a; TER-642), shown on the card as they are: a precedent at or
 *  above the person's high threshold, and one in the band below it. */
export const REPEAT_REASON = 'Mesma pergunta respondida antes';
export const SIMILAR_REASON = 'Pergunta parecida respondida antes';
/** How often the sender sweeper ticks (spec §6). */
export const AUTO_ANSWER_SWEEP_MS = 5_000;
/** How long an answer in the high band waits before it is sent (TER-642): no undo window, only long
 *  enough for the tab to have drawn the question the hook announced. */
export const AUTO_SEND_GRACE_MS = 3_000;
/** A screen's focus heartbeat older than this no longer counts (TER-642): the browser was closed or the
 *  app killed without saying so. Clients beat every `FOCUS_BEAT_SECONDS`. */
export const FOCUS_TTL_MS = 45_000;
export const FOCUS_BEAT_SECONDS = 15;
/** Heartbeats this old are deleted: nothing reads them any more. */
const FOCUS_PURGE_AFTER_MS = 60 * 60_000;
/** How long after its claim a countdown still `sent` on an open card counts as lost (the sender died). */
export const SENDER_LOST_AFTER_MS = 2 * 60_000;
/** How many due countdowns one tick sends at most; the rest wait for the next tick. */
const SWEEP_BATCH = 20;

/**
 * Why `answer_tab_question`'s `mode: 'auto'` became a suggestion (spec 2026-09-26 concierge memory
 * §5.4): the person's switch is off (D8); the person already cancelled a countdown on this card; no
 * cited decision or note equals the proposed answer (D6, TER-642); the card names an irreversible act
 * (D7's blocklist); a multi-question card is backed for some of its questions but not all (D7); or the
 * backing precedents are about questions below the person's low threshold, or it could not be measured
 * (TER-642, fail closed). When several apply, the most decisive is reported:
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
  /** TER-642, an answer backed by memory: the similarity that decided it, the person's thresholds and
   *  the band — `high` is sent after `AUTO_SEND_GRACE_MS`, anything else after the usual countdown. */
  score?: number;
  thresholds?: AutoThresholds;
  band?: AutoBand;
  /** The countdown only runs while termhub is in focus on one of the person's screens. */
  focus?: boolean;
}

/**
 * Whether a note backs one question's proposed answer (TER-642): the note's decision is the label of
 * the one option proposed (`mapNoteAnswer`). Never a free text, never two options: a note is prose the
 * concierge wrote, and only an option the tab itself offered may come out of it.
 */
export function noteBacks(note: Pick<MemoryItem, 'kind' | 'text'>, item: ChoicePayload['questions'][number], a: ChoiceAnswer['answers'][number]): boolean {
  if (note.kind !== 'note' || a.text !== undefined) return false;
  const mapped = mapNoteAnswer(note.text, item);
  return mapped !== null && sameAnswer(mapped, { selected: a.selected });
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
 * Starts an automatic answer on a still-open `choice` card (spec §6, TER-642): `auto_answer` in
 * `scheduled`, then the card is republished so every open screen shows it. In the high band it is due
 * `AUTO_SEND_GRACE_MS` from `now` (sent at once, as far as the person can tell); otherwise
 * `AUTO_ANSWER_DELAY_SECONDS` (default 60 s) from `now`, with "Cancelar" and "Responder agora" on the
 * card. With `focus`, that countdown only runs while termhub is in focus: it starts paused when none of
 * the person's screens has it now (`syncFocusCountdowns` runs it once one does). `setAutoAnswer` is
 * conditional on the row still `open` with no countdown already running, so a card that moved on, or
 * one another caller scheduled first, resolves `null` with nothing published. Sending is the sweeper's
 * job, never this function's. Logs nothing: the reason and answer are the person's words.
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
  const delay = input.band === 'high' ? AUTO_SEND_GRACE_MS : config.autoAnswerDelayMs;
  const focus = input.focus === true && input.band !== 'high';
  // Fails closed: a focus that cannot be read is no focus, and the countdown waits.
  const paused = focus && !(await repos.chatAuto.focusedUsers([input.row.user_id], FOCUS_TTL_MS).catch(() => new Set<string>())).has(input.row.user_id);
  const auto: AutoAnswer = {
    answer: input.answer,
    by: input.by,
    reason: input.reason,
    sources: input.sources,
    due_at: new Date(now.getTime() + delay).toISOString(),
    status: 'scheduled',
    ...(input.score !== undefined ? { score: Math.round(input.score * 1000) / 1000 } : {}),
    ...(input.thresholds ? { thresholds: { high: input.thresholds.high, low: input.thresholds.low } } : {}),
    ...(input.band ? { band: input.band } : {}),
    ...(focus ? { focus: true } : {}),
    ...(paused ? { paused: true, remaining_ms: delay } : {}),
  };
  return (await repos.tabQuestions.setAutoAnswer(input.row.id, auto)) ?? null;
}

/**
 * The memory path (spec §6, D9a; TER-642): a fresh `choice` card whose suggestion already found a
 * precedent of the person's own — a past decision or a note — for every one of its questions starts an
 * automatic answer on that suggestion by itself, with no LLM call. The card's score is the lowest
 * similarity among its questions, read against the person's thresholds (`thresholdsFor`): from `high`
 * it is sent at once; from `low` it counts down, in focus only, and is sent unless the person picks
 * something else; below `low` there is no suggestion to begin with. Everything else is a plain suggested
 * card (`null`): the switch off (D8), a concierge item (it cites no precedent of its own), a card with a
 * question left unsuggested, an answer that no longer fits the payload, a card that already had a
 * countdown, a blocklist hit (D7) on any header, question, suggested label, its description or text, or
 * a cited precedent that no longer backs its question's answer (forgotten meanwhile, a decision whose
 * chosen option is described differently from this card's, a note whose decision is no longer one of
 * the options). In a tab with a live automatic run nobody is watching, so the countdown does not wait
 * for focus. The row is not published here (`openTabQuestion` does it, once). Logs nothing.
 */
export async function maybeScheduleRepeat(repos: Repositories, row: TabQuestion, now = new Date()): Promise<TabQuestion | null> {
  if (row.kind !== 'choice' || row.status !== 'open' || row.auto_answer || !row.suggestion) return null;
  const payload = row.payload as ChoicePayload;
  const items = payload.questions.map((_q, i) => row.suggestion!.items.find((it) => it.question_index === i && suggestionRef(it) !== null));
  if (items.some((it) => it === undefined)) return null;
  const answer: ChoiceAnswer = { answers: items.map((it) => ({ selected: it!.selected, ...(it!.text !== undefined ? { text: it!.text } : {}) })) };
  if (checkChoiceAnswer(payload, answer)) return null;
  if (autoAnswerBlocked(blocklistParts(payload, answer))) return null;
  if (!(await autoAnswerAllowed(repos, row))) return null;
  const thresholds = await thresholdsFor(repos, row.user_id);
  const score = Math.min(...items.map((it) => it!.similarity));
  const band = bandOf(score, thresholds);
  if (!band) return null;
  const refs = items.map((it) => parseRef(suggestionRef(it!)!));
  if (refs.some((r) => r === null || (r.kind !== 'decision' && r.kind !== 'note'))) return null;
  const idsOf = (kind: 'decision' | 'note') => [...new Set(refs.flatMap((r) => (r!.kind === kind ? [r!.id] : [])))];
  // The suggestion only says a precedent was similar: re-read the ones it cites (the person's own,
  // still there) and check each still backs its own question's answer, option descriptions included.
  const [decisions, notes] = await Promise.all([repos.chatDecisions.findManyForUser(idsOf('decision'), row.user_id), idsOf('note').length ? repos.memoryItems.findManyForOwner(idsOf('note'), row.user_id) : Promise.resolve([] as MemoryItem[])]);
  const backed = payload.questions.every((item, i) => {
    const ref = refs[i]!;
    const a = answer.answers[i]!;
    if (ref.kind === 'decision') return decisions.some((d) => d.id === ref.id && decisionBacks(d, item, a));
    return notes.some((n) => n.id === ref.id && noteBacks(n, item, a));
  });
  if (!backed) return null;
  // fails open to "watched": a run that cannot be read leaves the countdown waiting for the person
  const unattended = band === 'mid' && (await automaticRunOfTab(repos, row.tab_id).catch(() => null)) !== null;
  const sources = [...idsOf('decision').map((id) => ({ kind: 'decision' as const, id })), ...idsOf('note').map((id) => ({ kind: 'note' as const, id }))];
  return storeAutoAnswer(repos, { row, answer, by: 'memory', reason: band === 'high' ? REPEAT_REASON : SIMILAR_REASON, sources, score, thresholds, band, focus: band === 'mid' && !unattended }, now);
}

/**
 * Keeps every in-focus countdown in step with the person's focus (TER-642), for one user (a screen just
 * said it gained or lost focus) or for all (the sweeper's tick, which also catches a heartbeat that
 * went stale): with a fresh heartbeat on any of the person's screens a paused countdown resumes, due
 * now plus what was left; with none a running one pauses, keeping what is left. Both are conditional
 * writes, so a cancel, an answer or the sender racing this changes nothing. Every card that changed is
 * republished. Resolves how many changed. Logs nothing.
 */
export async function syncFocusCountdowns(repos: Repositories, userId?: string, now = new Date()): Promise<number> {
  const rows = await repos.tabQuestions.listFocusCountdowns(userId);
  if (rows.length === 0) return 0;
  const focused = await repos.chatAuto.focusedUsers([...new Set(rows.map((r) => r.user_id))], FOCUS_TTL_MS);
  const changed: TabQuestion[] = [];
  for (const row of rows) {
    const auto = row.auto_answer!;
    const inFocus = focused.has(row.user_id);
    let next: TabQuestion | undefined;
    if (inFocus && auto.paused) next = await repos.tabQuestions.resumeAutoAnswer(row.id, new Date(now.getTime() + Math.max(0, auto.remaining_ms ?? config.autoAnswerDelayMs)).toISOString());
    else if (!inFocus && !auto.paused) next = await repos.tabQuestions.pauseAutoAnswer(row.id, auto.due_at, Math.max(0, new Date(auto.due_at).getTime() - now.getTime()));
    if (next) changed.push(next);
  }
  if (changed.length > 0) await publishTabQuestions(repos, 'tab_question', changed, { update: true });
  return changed.length;
}

/**
 * A screen of this person reports its focus (TER-642): `focused` is a heartbeat (web: the page visible
 * and focused; app: in the foreground), anything else takes that screen out. The person's in-focus
 * countdowns follow at once.
 */
export async function reportFocus(repos: Repositories, userId: string, clientId: string, focused: boolean): Promise<void> {
  if (focused) await repos.chatAuto.touchFocus(userId, clientId);
  else await repos.chatAuto.clearFocus(userId, clientId);
  await syncFocusCountdowns(repos, userId);
}

/**
 * Automatic board work's say over a countdown it did not schedule itself (TER-974): the chat woken for a
 * question of an automatic tab schedules its answer like any other (`by: 'concierge'`), and that answer
 * must meet the run's caps and cycle detector as the run's own do. `before` runs right before the send:
 * a code stops it (the countdown fails with it; the run was handed to the person). `sent` counts it for
 * the run. Given by app.ts (`automation/answers.ts`), so this module stays free of the automation's.
 */
export interface WokenAnswerGuard {
  before(row: TabQuestion, auto: AutoAnswer): Promise<string | null>;
  sent(row: TabQuestion, auto: AutoAnswer): Promise<void>;
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
export async function sendDueAutoAnswers(repos: Repositories, log: Log, deps: { now?: () => Date; answer?: typeof answerTabQuestion; shouldStop?: () => boolean; woken?: WokenAnswerGuard } = {}): Promise<number> {
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
      if (cited.length && (await repos.chatDecisions.findManyForUser(cited, user.id)).length < cited.length) throw new HttpError(409, 'A decisão usada foi esquecida', 'PRECEDENT_FORGOTTEN');
      // A note that backed it (TER-642) must still be there too.
      const notes = [...new Set(auto.sources.filter((s) => s.kind === 'note').map((s) => s.id))];
      if (notes.length && (await repos.memoryItems.findManyForOwner(notes, user.id)).length < notes.length) throw new HttpError(409, 'A anotação usada foi esquecida', 'PRECEDENT_FORGOTTEN');
      const stopped = deps.woken ? await deps.woken.before(claimed, auto) : null;
      if (stopped) throw new HttpError(409, 'Respostas automáticas demais nesta execução', stopped);
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
    // What led to the send (TER-642): who, the similarity, the band and the thresholds in force. The
    // refs are on the row (`auto_answer.sources`); never the answer nor the reason.
    log.info({ tabQuestionId: claimed.id, by: auto.by, ...(auto.score !== undefined ? { score: auto.score, band: auto.band, high: auto.thresholds?.high, low: auto.thresholds?.low } : {}) }, 'auto answer sent');
    // The countdown ran out in front of the person and they let it: the precedent was right for them.
    if (auto.focus) await recordAutoSamples(repos, claimed, 'accepted', log);
    log.info({ tabQuestionId: claimed.id, by: auto.by }, 'auto answer sent');
    if (deps.woken) await deps.woken.sent(claimed, auto).catch((err: unknown) => log.warn({ tabQuestionId: claimed.id, code: codeOf(err, 'RECORD_FAILED') }, 'auto answer not counted for the run'));
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
export function startAutoAnswerSweeper(repos: Repositories, log: Log, intervalMs = AUTO_ANSWER_SWEEP_MS, woken?: WokenAnswerGuard): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let stopping = false;
  const run = async () => {
    try {
      await recoverLostAutoAnswers(repos, log);
    } catch (err) {
      log.warn({ code: failureLabel(err) }, 'auto answer recovery failed');
    }
    // Before anything is sent: a countdown whose person looked away (or whose screen stopped beating)
    // pauses, and one whose person is back resumes (TER-642).
    try {
      await syncFocusCountdowns(repos);
      await repos.chatAuto.purgeFocus(FOCUS_PURGE_AFTER_MS);
    } catch (err) {
      log.warn({ code: failureLabel(err) }, 'auto answer focus sync failed');
    }
    try {
      await sendDueAutoAnswers(repos, log, { shouldStop: () => stopping, woken });
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
  // The person stopped it: for calibration the precedent was wrong, unless they then answer the same
  // on the card (that answer replaces this sample). TER-642.
  if (cancelled.auto_answer?.by !== 'automation') await recordAutoSamples(ctx.repos, cancelled, 'cancelled', silentLog);
  const [view] = await publishTabQuestions(ctx.repos, 'tab_question', [cancelled], { update: true });
  return view ?? toTabQuestionView(cancelled, null);
}
