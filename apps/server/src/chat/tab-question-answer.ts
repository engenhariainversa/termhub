import type { FastifyBaseLogger } from 'fastify';
import { ControlError, type ControlContext } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import { sendInput, sendKey } from '../control/terminals.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { toTabQuestionView, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
import { forbidden, HttpError, notFound } from '../lib/errors.js';
import { recordDecisions } from './decision-memory.js';
import { defaultEmbedder, type Embedder } from './embeddings.js';
import { lastNonBlankLines, permissionToolOnScreen, promptVisible, rowDialogFooterVisible } from './permission-dialog.js';
import { findPermissionOption, parsePermissionMenu, type PermissionOption } from './permission-options.js';
import { answerKeyPlan, type KeyStep } from './tab-question-keys.js';
import { checkChoiceAnswer, choiceAnswerBody, permissionAnswerBody, type ChoiceAnswer, type ChoicePayload, type PermissionAnswer, type PermissionPayload, type TabQuestionKind } from './tab-question-payload.js';
import { publishTabQuestions } from './tab-questions.js';

/** Pause between two keys of one answer: Claude Code redraws its card after each key, and a burst of
 * bytes is read as a paste. The server had no such pause yet (spec §5.4 assumed one). */
export const KEY_STEP_PAUSE_MS = 150;
/** How much of the pane the live check and the excerpt read. */
export const SCREEN_CHECK_LINES = 60;
export { DIALOG_FOOTER, dialogFooterVisible, lastNonBlankLines, permissionDialogVisible, PROMPT_MARKER_LINES, promptVisible, SCREEN_EXCERPT_LINES } from './permission-dialog.js';

export type TabAnswer = ChoiceAnswer | PermissionAnswer;

/** A `tab_questions` row that is a question — not a suggestion (spec 2026-09-25 tab suggestions §6.1). */
export type QuestionRow = TabQuestion & { kind: TabQuestionKind };
export const isQuestionRow = (row: TabQuestion | undefined): row is QuestionRow => row !== undefined && row.kind !== 'suggestion';

export const promptChanged = () => new HttpError(409, 'A aba já não mostra esta pergunta: nada foi enviado.', 'TAB_PROMPT_CHANGED');
/** A dialog is on the tab's screen, but it could not be matched to this card (TER-542): nothing is typed
 * and the card stays open — closing it would lose the question over what may be a misread screen. */
/** The card named an option of the dialog (TER-995) that the screen no longer shows under that number:
 * nothing is typed and the card stays open, so the person can look at the screen again and choose. */
export const optionChanged = () => new HttpError(409, 'As opções na tela da aba mudaram, então nada foi enviado. Confira a tela e escolha de novo.', 'TAB_OPTION_CHANGED');
export const promptNotSeen = () => new HttpError(409, 'Não encontrei esta pergunta na tela da aba, então nada foi enviado. Responda direto na aba.', 'TAB_PROMPT_NOT_SEEN');

/** The body, validated against the row's own kind and question (spec §5.3). */
export function parseAnswer(row: TabQuestion, raw: unknown): TabAnswer {
  if (row.kind === 'permission') return permissionAnswerBody.parse(raw);
  const answer = choiceAnswerBody.parse(raw);
  const problem = checkChoiceAnswer(row.payload as ChoicePayload, answer);
  if (problem) throw new HttpError(400, 'A resposta não combina com a pergunta', problem);
  return answer;
}

/**
 * Whether this answer needs the phone's PIN proof. None does for now (spec §2): the app's access is
 * already restrictive and the chat must stay fluid. Turning it on for `permission` + `allow` is this
 * function plus the app's proof flow (the `decisionProofMessage` pattern of action decisions).
 */
export function requirePinFor(_kind: TabQuestionKind, _answer: TabAnswer): boolean {
  return false;
}

export const asHttp = (err: unknown): unknown => (err instanceof ControlError ? new HttpError(409, err.localized, err.code) : err);
export const codeOf = (err: unknown, fallback = 'SEND_FAILED'): string => (err instanceof ControlError || err instanceof HttpError ? (err.code ?? fallback) : fallback);
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/**
 * The row's tab through the scope (spec 2026-09-26 §4.7). A 404 means the card is dead — its tab was
 * removed by another process (the other color, a crash) or left the person's scope: the row closes as
 * `expired` (only while still on screen) and every screen hears it, then the 404 answers as before.
 * Closing is best effort: the 404 is the answer either way. Any other failure leaves the row alone.
 */
export async function scopedTabOfRow(ctx: ControlContext, row: TabQuestion, log?: Log): Promise<Awaited<ReturnType<ControlContext['scoped']['tab']>>> {
  try {
    return await ctx.scoped.tab(row.tab_id);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) {
      try {
        const expired = await ctx.repos.tabQuestions.expireOne(row.id);
        if (expired) await publishTabQuestions(ctx.repos, 'tab_question_closed', [expired]);
      } catch (closeErr) {
        log?.warn({ tabQuestionId: row.id, tabId: row.tab_id, code: codeOf(closeErr, 'CLOSE_FAILED') }, 'dead tab question not closed');
      }
    }
    throw err;
  }
}

async function runKeyPlan(ctx: ControlContext, tabId: string, steps: KeyStep[], sleep: (ms: number) => Promise<void>): Promise<void> {
  for (const [i, step] of steps.entries()) {
    if (i > 0) await sleep(KEY_STEP_PAUSE_MS);
    if ('key' in step) await sendKey(ctx, { tab_id: tabId, key: step.key });
    // This *is* the answer to the prompt the tab is waiting on: past sendInput's WAITING_PERMISSION guard on purpose.
    else await sendInput(ctx, { tab_id: tabId, text: step.text, enter: false, answering_permission: true }, null);
  }
}

export interface AnswerDeps {
  log: Log;
  /** Test seam for the pause between keys. */
  sleep?: (ms: number) => Promise<void>;
  /** The mobile route's PIN hook (`requirePinFor`): runs after every check, before the claim. */
  beforeSend?: (row: QuestionRow, answer: TabAnswer) => void;
  /** Left out resolves `defaultEmbedder()`; `null` turns off embedding for the decision this answer
   *  records (a test seam — recording itself still happens, only unembedded). */
  embedder?: Embedder | null;
  /** How this answer is sent (spec 2026-09-26 concierge memory §6): a click (`'card'`, the default),
   *  or the countdown's sender (`'auto'`, `sendDueAutoAnswers` only) — stored as `answered_via`, and
   *  never recorded as a decision (D11): the memory must not feed on itself. */
  via?: 'card' | 'auto' | 'automation';
}

/**
 * Answers a tab's question from its card (spec §5.3). In order: the row through its owner, the body
 * against it, the tab through the scope (404), still open and still the tab's latest (409), still on
 * the live screen (409), the claim (409 for the loser of a double click), then the keys. A failure
 * after the claim leaves the row `failed` with the code and answers 502. Logs ids, kind and counts.
 * A click on a card with a running countdown cancels the countdown just before the claim.
 */
export async function answerTabQuestion(ctx: ControlContext, id: string, raw: unknown, deps: AnswerDeps): Promise<TabQuestionView> {
  // Answering types into a terminal: the same grant as the MCP write tools (send_input, send_key).
  if (!(await ctx.can('terminals', 'write'))) throw forbidden('Responder na aba precisa da permissão terminals:write na sua role');
  const userId = ctx.scope.user.id;
  const found = await ctx.repos.tabQuestions.findByIdForUser(id, userId);
  // A suggestion has its own routes (tab-suggestion-send.ts): here it is no question at all.
  if (!isQuestionRow(found)) throw notFound('Pergunta não encontrada');
  const row = found;
  let answer = parseAnswer(row, raw);
  const { tab } = await scopedTabOfRow(ctx, row, deps.log);
  if (row.status !== 'open') throw promptChanged();
  const latest = await ctx.repos.tabQuestions.findOpenForTab(tab.id);
  if (latest?.id !== row.id) throw promptChanged();

  let screen: string;
  try {
    screen = (await readScreen(ctx, { tab_id: tab.id, lines: SCREEN_CHECK_LINES }, { plain: true })).text;
  } catch (err) {
    throw asHttp(err);
  }
  const via = deps.via ?? 'card';
  if (!promptVisible(screen, row)) {
    // A dialog of the card's agent is still up, just not one this card recognises: say so and leave the
    // card alone.
    if (rowDialogFooterVisible(screen, row)) {
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, kind: row.kind }, 'tab question not recognised on screen');
      throw promptNotSeen();
    }
    // The tab moved on without telling us: this card is stale, so it leaves the screens now (only this
    // row, only while still open). Best effort: the 409 is the answer either way.
    try {
      const closed = await ctx.repos.tabQuestions.closeOne(row.id, 'answered_in_tab');
      if (closed) await publishTabQuestions(ctx.repos, 'tab_question_closed', [closed]);
    } catch (err) {
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, code: codeOf(err, 'CLOSE_FAILED') }, 'stale tab question not closed');
    }
    throw promptChanged();
  }

  // An automatic allow (agentic board spec §9.2, review I1) goes only into the very dialog the card names,
  // identified on this screen read: never into an unknown-title one (another tool's, a subagent's, one
  // swapped in since the card opened, or one behind a forged hook). The card stays open for the person.
  if (via === 'automation') {
    if (row.kind !== 'permission' || (answer as PermissionAnswer).allow !== true) throw promptNotSeen();
    if (!permissionToolOnScreen(screen, row)) {
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, kind: row.kind }, 'automatic answer: dialog tool not identified on screen');
      throw promptNotSeen();
    }
  }
  // An option of the dialog (TER-995): the same number must still show the same text on this very read.
  // What is stored is the screen's own option, so `allow` follows it, not the request.
  let cursor: number | undefined;
  const choice = row.kind === 'permission' ? (answer as PermissionAnswer).option : undefined;
  if (choice) {
    const menu = parsePermissionMenu(screen);
    const option = findPermissionOption(menu, choice);
    if (!menu || !option) {
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, kind: row.kind }, 'tab question option not on screen');
      throw optionChanged();
    }
    cursor = menu.cursor;
    answer = { allow: option.allow, option: { number: option.number, label: option.label, summary: option.summary } };
  }
  deps.beforeSend?.(row, answer);
  // The person answered while a countdown runs: it ends first, so the card never shows a countdown for
  // an answered question. The claim below would stop a second send anyway (it needs the row `open`).
  if (via === 'card' && row.auto_answer?.status === 'scheduled') await ctx.repos.tabQuestions.cancelAutoAnswer(row.id, userId);
  const claimed = await ctx.repos.tabQuestions.claim(row.id, userId, answer, undefined, via);
  if (!claimed) throw promptChanged();

  const steps = row.kind === 'choice' ? answerKeyPlan('choice', row.payload as ChoicePayload, answer as ChoiceAnswer) : answerKeyPlan('permission', row.payload as PermissionPayload, answer as PermissionAnswer, cursor);
  try {
    await runKeyPlan(ctx, tab.id, steps, deps.sleep ?? pause);
  } catch (err) {
    const code = codeOf(err);
    deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, kind: row.kind, code }, 'tab question answer failed');
    // Recording the failure is best effort: a db or bus error here must not replace the send's own error.
    try {
      const failed = await ctx.repos.tabQuestions.markFailed(row.id, code);
      if (failed) await publishTabQuestions(ctx.repos, 'tab_question_answered', [failed]);
    } catch (recordErr) {
      deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, code: codeOf(recordErr, 'RECORD_FAILED') }, 'tab question failure not recorded');
    }
    throw new HttpError(502, 'Não foi possível responder na aba', code);
  }
  deps.log.info({ tabQuestionId: row.id, tabId: tab.id, kind: row.kind, steps: steps.length }, 'tab question answered');
  // Remembering the decision is best effort (spec 2026-09-26 §4.3): the keys are already in the tab. An
  // automatic answer is not the person's decision (D11): its sources are counted by the sender instead.
  if (claimed.kind === 'choice' && via === 'card') await recordDecisions(ctx.repos, claimed, { embedder: deps.embedder !== undefined ? deps.embedder : defaultEmbedder(), log: deps.log });
  // The keys are in the tab: announcing it is best effort and can no longer turn the answer into an error.
  try {
    const [view] = await publishTabQuestions(ctx.repos, 'tab_question_answered', [claimed]);
    if (view) return view;
  } catch (err) {
    deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, code: codeOf(err, 'PUBLISH_FAILED') }, 'tab question answer not announced');
  }
  return toTabQuestionView(claimed, tab.name);
}

/** The permission card's live excerpt (spec §6.1): read on demand, never stored nor logged. With it, the
 * options of the dialog on screen (TER-995) — only while that dialog is this card's, else `[]`. */
export async function tabQuestionScreen(ctx: ControlContext, id: string, deps: { log?: Log } = {}): Promise<{ text: string; options: PermissionOption[] }> {
  // Terminal content: the same grant as the MCP read_screen tool.
  if (!(await ctx.can('terminals', 'read'))) throw forbidden('Ver a tela da aba precisa da permissão terminals:read na sua role');
  const row = await ctx.repos.tabQuestions.findByIdForUser(id, ctx.scope.user.id);
  if (!isQuestionRow(row)) throw notFound('Pergunta não encontrada');
  if (row.status !== 'open') throw promptChanged();
  const { tab } = await scopedTabOfRow(ctx, row, deps.log);
  try {
    const { text } = await readScreen(ctx, { tab_id: tab.id, lines: SCREEN_CHECK_LINES }, { plain: true });
    const options = row.kind === 'permission' && promptVisible(text, row) ? (parsePermissionMenu(text)?.options ?? []) : [];
    return { text: lastNonBlankLines(text), options };
  } catch (err) {
    throw asHttp(err);
  }
}
