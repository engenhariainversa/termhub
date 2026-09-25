import type { FastifyBaseLogger } from 'fastify';
import { ControlError, type ControlContext } from '../control/context.js';
import { readScreen } from '../control/screen.js';
import { sendInput, sendKey } from '../control/terminals.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';
import { HttpError, notFound } from '../lib/errors.js';
import { choiceKeyPlan, permissionKeyPlan, type KeyStep } from './tab-question-keys.js';
import { checkChoiceAnswer, choiceAnswerBody, permissionAnswerBody, type ChoiceAnswer, type ChoicePayload, type PermissionAnswer, type PermissionPayload, type TabQuestionKind } from './tab-question-payload.js';
import { publishTabQuestions } from './tab-questions.js';

/** Pause between two keys of one answer: Claude Code redraws its card after each key, and a burst of
 * bytes is read as a paste. The server had no such pause yet (spec §5.4 assumed one). */
export const KEY_STEP_PAUSE_MS = 150;
/** How much of the pane the live check and the excerpt read. */
export const SCREEN_CHECK_LINES = 60;
export const SCREEN_EXCERPT_LINES = 20;

export type TabAnswer = ChoiceAnswer | PermissionAnswer;

export const promptChanged = () => new HttpError(409, 'A pergunta mudou na aba', 'TAB_PROMPT_CHANGED');

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

const squash = (s: string) => s.replace(/\s+/g, '');
/** The last `lines` non-blank rows of a capture, as one string. */
export function lastNonBlankLines(text: string, n = SCREEN_EXCERPT_LINES): string {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .join('\n');
}

/**
 * The live check (spec §5.3): the question must still be on screen. Whitespace is dropped on both
 * sides, because Claude Code wraps a long question over several indented rows. A permission prompt
 * reads "Do you want to proceed?" (or "Do you want to make this edit…?") and names its tool.
 */
export function promptVisible(screen: string, row: Pick<TabQuestion, 'kind' | 'payload'>): boolean {
  const shown = squash(lastNonBlankLines(screen, SCREEN_CHECK_LINES));
  if (row.kind === 'choice') {
    const first = (row.payload as ChoicePayload).questions[0];
    return !!first && shown.includes(squash(first.question).slice(0, 80));
  }
  return shown.includes(squash('Do you want')) || shown.includes((row.payload as PermissionPayload).tool_name);
}

const asHttp = (err: unknown): unknown => (err instanceof ControlError ? new HttpError(409, err.message, err.code) : err);
const codeOf = (err: unknown): string => (err instanceof ControlError || err instanceof HttpError ? (err.code ?? 'SEND_FAILED') : 'SEND_FAILED');
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runKeyPlan(ctx: ControlContext, tabId: string, steps: KeyStep[], sleep: (ms: number) => Promise<void>): Promise<void> {
  for (const [i, step] of steps.entries()) {
    if (i > 0) await sleep(KEY_STEP_PAUSE_MS);
    if ('key' in step) await sendKey(ctx, { tab_id: tabId, key: step.key });
    // This *is* the answer to the prompt the tab is waiting on: past sendInput's WAITING_PERMISSION guard on purpose.
    else await sendInput(ctx, { tab_id: tabId, text: step.text, enter: false, answering_permission: true });
  }
}

export interface AnswerDeps {
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  /** Test seam for the pause between keys. */
  sleep?: (ms: number) => Promise<void>;
  /** The mobile route's PIN hook (`requirePinFor`): runs after every check, before the claim. */
  beforeSend?: (row: TabQuestion, answer: TabAnswer) => void;
}

/**
 * Answers a tab's question from its card (spec §5.3). In order: the row through its owner, the body
 * against it, the tab through the scope (404), still open and still the tab's latest (409), still on
 * the live screen (409), the claim (409 for the loser of a double click), then the keys. A failure
 * after the claim leaves the row `failed` with the code and answers 502. Logs ids, kind and counts.
 */
export async function answerTabQuestion(ctx: ControlContext, id: string, raw: unknown, deps: AnswerDeps): Promise<TabQuestionView> {
  const userId = ctx.scope.user.id;
  const row = await ctx.repos.tabQuestions.findByIdForUser(id, userId);
  if (!row) throw notFound('Pergunta não encontrada');
  const answer = parseAnswer(row, raw);
  const { tab } = await ctx.scoped.tab(row.tab_id);
  if (row.status !== 'open') throw promptChanged();
  const latest = await ctx.repos.tabQuestions.findOpenForTab(tab.id);
  if (latest?.id !== row.id) throw promptChanged();

  let screen: string;
  try {
    screen = (await readScreen(ctx, { tab_id: tab.id, lines: SCREEN_CHECK_LINES })).text;
  } catch (err) {
    throw asHttp(err);
  }
  if (!promptVisible(screen, row)) throw promptChanged();

  deps.beforeSend?.(row, answer);
  const claimed = await ctx.repos.tabQuestions.claim(row.id, userId, answer);
  if (!claimed) throw promptChanged();

  const steps = row.kind === 'choice' ? choiceKeyPlan(row.payload as ChoicePayload, answer as ChoiceAnswer) : permissionKeyPlan(answer as PermissionAnswer);
  try {
    await runKeyPlan(ctx, tab.id, steps, deps.sleep ?? pause);
  } catch (err) {
    const code = codeOf(err);
    const failed = await ctx.repos.tabQuestions.markFailed(row.id, code);
    if (failed) await publishTabQuestions(ctx.repos, 'tab_question_answered', [failed]);
    deps.log.warn({ tabQuestionId: row.id, tabId: tab.id, kind: row.kind, code }, 'tab question answer failed');
    throw new HttpError(502, 'Não foi possível responder na aba', code);
  }
  deps.log.info({ tabQuestionId: row.id, tabId: tab.id, kind: row.kind, steps: steps.length }, 'tab question answered');
  const [view] = await publishTabQuestions(ctx.repos, 'tab_question_answered', [claimed]);
  return view;
}

/** The permission card's live excerpt (spec §6.1): read on demand, never stored nor logged. */
export async function tabQuestionScreen(ctx: ControlContext, id: string): Promise<{ text: string }> {
  const row = await ctx.repos.tabQuestions.findByIdForUser(id, ctx.scope.user.id);
  if (!row) throw notFound('Pergunta não encontrada');
  if (row.status !== 'open') throw promptChanged();
  try {
    const { text } = await readScreen(ctx, { tab_id: row.tab_id, lines: SCREEN_CHECK_LINES });
    return { text: lastNonBlankLines(text) };
  } catch (err) {
    throw asHttp(err);
  }
}
