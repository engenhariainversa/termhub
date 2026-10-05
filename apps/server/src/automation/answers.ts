import { blocklistParts, scheduleAutoAnswer } from '../chat/auto-answer.js';
import { checkChoiceAnswer, type ChoiceAnswer, type ChoicePayload } from '../chat/tab-question-payload.js';
import type { Waker } from '../chat/wake.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion as TabQuestionRow } from '../db/repositories/tab-questions.js';
import { tk } from '../i18n/index.js';
import { autoAnswerBlocked } from '../memory/blocklist.js';
import { recordEvent } from './events.js';
import { QUESTION_UNANSWERED, wakeOrEscalate } from './follower.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const noopLog: Log = { info: () => {}, warn: () => {} };

/** The countdown's reason when the agent's own recommended option is picked (stored as is, like
 *  `REPEAT_REASON`; screens show it translated for `by: 'automation'`). */
export const RECOMMENDED_REASON = tk('Opção recomendada pelo agente');

export interface AnswerDeps {
  repos: Repositories;
  /** The chat's waker (app.ts); left out, step 3 is skipped and an unanswered question escalates. */
  waker?: Waker;
  log?: Log;
}

/**
 * What became of a question of an automatic tab (spec D18): a memory repeat already counting down, the
 * recommended option scheduled, the chat woken, or the run escalated to the person. `closed`: the card
 * moved on meanwhile (answered in the tab, a newer question) and nothing was done.
 */
export type AnswerOutcome = 'repeat' | 'recommended' | 'woken' | 'escalated' | 'closed';

/**
 * The option the agent marked "(Recomendado)" / "(Recommended)" (parsed into `option.recommended`), as its
 * label — only on a card with a single question and exactly one marked option. Null otherwise.
 */
export function recommendedOption(payload: ChoicePayload): string | null {
  if (payload.questions.length !== 1) return null;
  const marked = payload.questions[0]!.options.filter((o) => o.recommended === true);
  return marked.length === 1 ? marked[0]!.label : null;
}

/** The card as the database has it now: closed, counting down (someone scheduled first), or still waiting. */
async function cardNow(repos: Repositories, q: TabQuestionRow): Promise<'closed' | 'counting' | 'open'> {
  const open = await repos.tabQuestions.findOpenForTab(q.tab_id);
  if (open?.id !== q.id) return 'closed';
  const status = open.auto_answer?.status;
  return status === 'scheduled' || status === 'sent' ? 'counting' : 'open';
}

/**
 * A `choice` card opened in a tab with a live automatic run (spec §9.1, D18), in order:
 *
 * 1. a countdown the memory repeat already scheduled (`maybeScheduleRepeat`) → `'repeat'`;
 * 2. a single-question card with exactly one option the agent marked recommended, when the keyword block
 *    (`memory/blocklist.ts`) does not fire on the card or that option → a countdown with `by:
 *    'automation'` and the usual delay (the person can still cancel it) → `'recommended'`;
 * 3. the chat woken for it (`automatic: true`: no "Responder sozinho", the automation's own budget) →
 *    `'woken'` — an answer it schedules goes through the same countdown; a card it leaves alone is
 *    escalated by the follower after QUESTION_WAIT_MS;
 * 4. otherwise (no budget, no host, the wake failed) the run waits for the person → `'escalated'`.
 *
 * Paths 1 and 2 record `question_answered`, path 4 `escalated`. The caller checked the run is live
 * (`automaticRunOfTab`); the sender checks again before anything is typed (D24). Logs ids only.
 */
export async function automationAnswer(deps: AnswerDeps, q: TabQuestionRow, run: AutomationRun): Promise<AnswerOutcome> {
  const { repos } = deps;
  const log = deps.log ?? noopLog;
  if (q.kind !== 'choice' || q.status !== 'open') return 'closed';
  const answered = async (via: 'repeat' | 'recommended') => {
    await recordEvent(repos, { project_id: run.project_id, task_id: run.task_id, run_id: run.id, kind: 'question_answered', payload: { via, tab_id: q.tab_id, question_id: q.id } }).catch(() =>
      log.warn({ runId: run.id, tabQuestionId: q.id }, 'automation: question_answered not recorded'),
    );
    log.info({ runId: run.id, tabQuestionId: q.id, via }, 'automation: question answered');
  };

  // 1. memory first
  const counting = q.auto_answer?.status;
  if (counting === 'scheduled' || counting === 'sent') {
    await answered('repeat');
    return 'repeat';
  }

  // 2. the agent's own recommendation, never past the keyword block
  const payload = q.payload as ChoicePayload;
  const label = recommendedOption(payload);
  if (label !== null) {
    const answer: ChoiceAnswer = { answers: [{ selected: [payload.questions[0]!.options.findIndex((o) => o.recommended === true)] }] };
    if (checkChoiceAnswer(payload, answer) === null && !autoAnswerBlocked(blocklistParts(payload, answer))) {
      if (await scheduleAutoAnswer(repos, { row: q, answer, by: 'automation', reason: RECOMMENDED_REASON, sources: [] })) {
        await answered('recommended');
        return 'recommended';
      }
      const now = await cardNow(repos, q);
      if (now === 'closed') return 'closed';
      if (now === 'counting') {
        await answered('repeat');
        return 'repeat';
      }
    }
  }

  // 3. wake the chat
  const tab = await repos.tabs.findById(q.tab_id);
  // the waker never throws by contract; a failure is the same as no wake
  const woken = deps.waker ? await deps.waker.wake(q, tab?.name ?? null, { automatic: true }).catch(() => false) : false;
  if (woken) {
    log.info({ runId: run.id, tabQuestionId: q.id }, 'automation: chat woken for a question');
    return 'woken';
  }

  // 4. the person — unless the card moved on, or something scheduled an answer meanwhile
  const now = await cardNow(repos, q);
  if (now === 'closed') return 'closed';
  if (now === 'counting') {
    await answered('repeat');
    return 'repeat';
  }
  await wakeOrEscalate(repos, run, QUESTION_UNANSWERED, log);
  return 'escalated';
}
