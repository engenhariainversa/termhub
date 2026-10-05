import type { FastifyBaseLogger } from 'fastify';
import { expireTabLimits } from './tab-limits.js';
import { automaticRunOfTab } from '../automation/pause.js';
import { config } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { CloseScope, TabQuestion, TabQuestionCloseStatus } from '../db/repositories/tab-questions.js';
import { describeTabQuestions, type TabQuestionView } from '../db/repositories/tab-questions-view.js';
import type { Tab } from '../db/repositories/types.js';
import { monitorBus } from '../monitor/bus.js';
import type { Interpreted } from '../monitor/state.js';
import { maybeScheduleRepeat } from './auto-answer.js';
import { chatBus } from './bus.js';
import { suggestFor } from './decision-memory.js';
import { defaultEmbedder, type Embedder } from './embeddings.js';
import { failureLabel } from './service.js';
import type { ChoicePayload, TabQuestionInput } from './tab-question-payload.js';
import type { Waker } from './wake.js';

/** Never fails to open a card over a logging concern: the default when a caller has none of its own. */
const silentLog: Pick<FastifyBaseLogger, 'info' | 'warn'> = { info() {}, warn() {} };

export type TabQuestionEventType = 'tab_question' | 'tab_question_answered' | 'tab_question_closed';

/**
 * Which rows a hook event closes, or null when it closes nothing (spec 2026-09-30 tab questions per
 * subagent §5). An event closes its own agent's rows: a subagent's next tool call or its end closes that
 * subagent's card and nobody else's, and the main thread's events leave a running subagent's card alone.
 * Two main-thread events close every row, being proof that nothing runs: a session end, and a Stop with
 * nothing left in the background. A subagent leaves the permission queue only when it ends: a tool call of
 * its own may be a parallel call's, landing while its dialog is still pending.
 * What never closes: an event that opens a question (it closes the previous one itself, `open`); a
 * `Notification`, which only says the tab is still waiting; AskUserQuestion's own `PermissionRequest`, the
 * question's companion; a subagent's event from a script that does not name it (spec 2026-09-26 §4.5); and
 * Codex's `notify` (`agent-turn-complete`), which only repeats the end of the turn its `Stop` hook already
 * reported, and would close the reply card that `Stop` just opened.
 */
export function closingScope(next: Interpreted): CloseScope | null {
  if (next.question) return null;
  const event = next.meta.event;
  if (event === 'Notification') return null;
  if (event === 'agent-turn-complete') return null;
  if (event === 'PermissionRequest' && next.meta.tool === 'AskUserQuestion') return null;
  if (next.meta.subagent === true) {
    return typeof next.meta.agent_id === 'string' ? { agent: next.meta.agent_id, leavesQueue: event === 'SubagentStop' } : null;
  }
  if (event === 'SessionEnd') return 'all';
  if (event === 'Stop' && !next.backgroundTasks) return 'all';
  return { agent: null, leavesQueue: true };
}

/**
 * Tells every open screen of each row's conversation owner. Resolves the views it published. A
 * suggestion row goes out on its own events (spec 2026-09-25 tab suggestions §6.2) — `tab_suggestion`
 * when it opens, `tab_suggestion_closed` for anything after — so every close path here also closes it.
 * `update` marks a still-open card republished because it changed, not because it opened: screens
 * redraw it, the phone is not pushed again (TER-919).
 */
export async function publishTabQuestions(
  repos: Pick<Repositories, 'tabs' | 'chatDecisions'>,
  type: TabQuestionEventType,
  rows: TabQuestion[],
  opts: { update?: boolean } = {},
): Promise<TabQuestionView[]> {
  const views: TabQuestionView[] = [];
  for (const row of rows) {
    const [view] = await describeTabQuestions(repos, [row], row.user_id);
    if (row.kind === 'suggestion') chatBus.publish({ type: type === 'tab_question' ? 'tab_suggestion' : 'tab_suggestion_closed', user_id: row.user_id, conversation_id: row.conversation_id, suggestion: view });
    else if (type === 'tab_question' && opts.update) chatBus.publish({ type, user_id: row.user_id, conversation_id: row.conversation_id, question: view, update: true });
    else chatBus.publish({ type, user_id: row.user_id, conversation_id: row.conversation_id, question: view });
    views.push(view);
  }
  return views;
}

/** Closes the scope's cards, removes departing queue members, and announces the closed rows. */
export async function closeTabQuestions(repos: Repositories, tabId: string, status: TabQuestionCloseStatus, scope: CloseScope = 'all'): Promise<TabQuestion[]> {
  const closed = await repos.tabQuestions.closeForTab(tabId, status, scope);
  await publishTabQuestions(repos, 'tab_question_closed', closed);
  return closed;
}

/**
 * A tab asked something: the row goes into the project owner's most recently active conversation and
 * the card onto every screen showing it. A project nobody chats in (or with no owner) gets no card — the
 * question stays in the tab, as before — but the same `open` runs with no conversation (spec 2026-09-26
 * §4.1): under the tab's lock, whatever the tab had open still closes, and a permission queue is marked
 * or kept exactly as with a card. A permission queued behind an open one opens nothing either.
 *
 * A fresh `choice` card is offered a suggestion from the person's past decisions (spec 2026-09-26 §4)
 * before it is announced — best effort, and never blocks the card on it. A stored suggestion that
 * covers every question from a decision may start a countdown on it (`maybeScheduleRepeat`, spec
 * 2026-09-26 concierge memory §6): the card is still announced once, carrying `auto_answer`. `deps` lets tests and the
 * ingest path (`noteHookEvent`) pass their own embedder/logger; left out, it is `defaultEmbedder()`
 * (null without EMBED_URL) and a no-op logger.
 *
 * The suggestion step takes long enough (an embed round trip, a vector query) that the card can move
 * on underneath it, so the three outcomes are handled on purpose rather than always falling back to
 * the question as first opened:
 *  - a suggestion attaches (`setSuggestion`) and is shown on the row it actually landed on;
 *  - `setSuggestion` finds the row no longer `open` (closed or answered meanwhile): nothing is shown —
 *    republishing a closed card as if it were still open would be wrong — and `openTabQuestion` itself
 *    resolves `null`, exactly as if nothing had opened;
 *  - `setSuggestion` itself fails (a DB hiccup): the plain question is still shown, with the suggestion
 *    folded in only for that one published view (the brief's fallback: best effort must not lose the
 *    card over a write it cannot retry here);
 *  - an embedder ran and found nothing (or timed out, or failed): the row is re-checked
 *    (`findOpenForTab`) before announcing it, since by then it may already have moved on; with no
 *    embedder configured at all, `suggestFor` returned instantly and nothing has had time to change, so
 *    that extra read is skipped.
 *
 * Once the card is out (published), a fresh `choice` card that got no automatic answer — no repeat
 * countdown from `maybeScheduleRepeat` above — wakes the project's concierge (spec 2026-09-26
 * concierge memory §7, D9b), fire-and-forget (`void`): the hook POST that got us here never waits for
 * a wake turn, and `deps.waker`'s own contract (`createWaker`) never throws. In a tab with a live
 * automatic run (`automaticRunOfTab`) the card goes to `automationAnswer` instead (agentic board spec
 * D18: repeat, recommended option, wake, escalate), fire-and-forget too; a `permission` card there goes to
 * `answerPermissionAutomatically` (§9.2: "allow" by the project's rules, or escalate).
 */
export async function openTabQuestion(
  repos: Repositories,
  tab: Pick<Tab, 'id' | 'project_id' | 'name'>,
  input: TabQuestionInput,
  deps?: { agentId?: string | null; embedder?: Embedder | null; log?: Pick<FastifyBaseLogger, 'info' | 'warn'>; waker?: Waker },
): Promise<TabQuestion | null> {
  // Only the owner's chat: another user's conversation left on the project (a former owner, or an
  // admin's) must not receive the card, which would let them answer a tab they no longer own.
  const owner = (await repos.projects.findById(tab.project_id))?.owner_id;
  const conversation = owner ? await repos.chat.findLatestActiveForProject(tab.project_id, owner) : undefined;
  const { question, closed } = await repos.tabQuestions.open({ tab_id: tab.id, project_id: tab.project_id, conversation_id: conversation?.id ?? null, kind: input.kind, payload: input.payload, tool_use_id: input.tool_use_id, agent_id: deps?.agentId ?? null });
  await publishTabQuestions(repos, 'tab_question_closed', closed);
  // A permission with no card because one is already open (queued behind it) is that card's business; only
  // one with no conversation at all is parked.
  if (!question && (input.kind === 'choice' || !conversation)) {
    // No card (no active conversation of the owner's): in a tab with a live automatic run the run is
    // parked for the person before anything else looks at the tab, so nothing is ever typed into the
    // question (agentic board review I1). A manual tab keeps the question in the tab, as before.
    const run = await automaticRunOfTab(repos, tab.id).catch(() => null);
    if (run) {
      const log = deps?.log ?? silentLog;
      // loaded lazily: automation/answers reaches the follower, whose imports lead back here
      await import('../automation/answers.js')
        .then(({ questionWithoutCard }) => questionWithoutCard(repos, run, log, input.kind))
        .catch((err) => log.warn({ tabId: tab.id, code: failureLabel(err) }, 'automation: question with no card not parked'));
    }
  }
  let shown = question;
  if (question?.kind === 'choice') {
    const embedder = deps?.embedder !== undefined ? deps.embedder : defaultEmbedder();
    const suggestion = await suggestFor(repos, question, { embedder, threshold: config.decisionSuggestThreshold, log: deps?.log ?? silentLog });
    if (suggestion) {
      let stored: TabQuestion | undefined;
      try {
        stored = await repos.tabQuestions.setSuggestion(question.id, suggestion);
        shown = stored ?? null;
      } catch {
        shown = { ...question, suggestion };
      }
      // The repeat path (spec 2026-09-26 concierge memory §6, D9a): best effort, like the suggestion —
      // a failure here must not lose the card, which then shows the suggestion alone.
      if (stored) {
        try {
          shown = (await maybeScheduleRepeat(repos, stored)) ?? stored;
        } catch (err) {
          (deps?.log ?? silentLog).warn({ tabQuestionId: stored.id, code: failureLabel(err) }, 'auto answer not scheduled');
        }
      }
    } else if (embedder) {
      const stillOpen = await repos.tabQuestions.findOpenForTab(tab.id);
      if (stillOpen?.id !== question.id) shown = null;
    }
  }
  if (shown) {
    await publishTabQuestions(repos, 'tab_question', [shown]);
    if (shown.kind === 'choice') {
      const log = deps?.log ?? silentLog;
      // A tab with a live automatic run answers by the agentic board's own order (spec D18); every
      // other tab — a manual one, a paused or disabled project — exactly as before.
      const run = await automaticRunOfTab(repos, tab.id).catch(() => null);
      if (run) {
        const card = shown;
        // loaded lazily: automation/answers reaches the follower, whose imports lead back here
        void import('../automation/answers.js')
          .then(({ automationAnswer }) => automationAnswer({ repos, waker: deps?.waker, log }, card, run))
          .catch((err) => log.warn({ tabQuestionId: card.id, code: failureLabel(err) }, 'automation: question not handled'));
      } else if (!shown.auto_answer && deps?.waker) void deps.waker.wake(shown, tab.name);
    } else if (shown.kind === 'permission') {
      // A permission in a tab with a live automatic run is answered "allow" when the project's rules allow
      // it, or escalated (agentic board spec §9.2); in any other tab the card waits for the person, as before.
      const run = await automaticRunOfTab(repos, tab.id).catch(() => null);
      if (run) {
        const log = deps?.log ?? silentLog;
        const card = shown;
        // loaded lazily, like automationAnswer above
        void import('../automation/answers.js')
          .then(({ answerPermissionAutomatically }) => answerPermissionAutomatically({ repos, log }, card, run))
          .catch((err) => log.warn({ tabQuestionId: card.id, code: failureLabel(err) }, 'automation: permission not handled'));
      }
    }
  }
  return shown;
}

/**
 * The ingest step's hand-off (spec §4.2): a question opens, or the event closes its scope when
 * `closingScope` allows it. Close-only events skip the tab update. Never throws: bookkeeping for a card
 * must not turn it into a failed POST. Logs ids, kind and counts; never the question. `waker` is
 * optional (spec 2026-09-26 concierge memory §7): the ingest route (`ingestHookEvent`) passes the real
 * one down from `app.ts`, next to `repos` and `log` — there is no `ChatService` instance to build it
 * from here, and this module must not construct one of its own.
 */
export async function noteHookEvent(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, tab: Tab, next: Interpreted, waker?: Waker): Promise<void> {
  try {
    if (next.question) {
      // Codex events carry no agent id, so its choice and permission rows get `agent_id: null`: a card
      // a Codex subagent opens is closed by the main thread's events too (the behaviour before TER-179).
      const q = await openTabQuestion(repos, tab, next.question, { log, waker, agentId: typeof next.meta.agent_id === 'string' ? next.meta.agent_id : null });
      if (q) log.info({ tabId: tab.id, tabQuestionId: q.id, kind: q.kind, questions: q.kind === 'choice' ? (q.payload as ChoicePayload).questions.length : 1 }, 'tab question opened');
    } else {
      const scope = closingScope(next);
      if (scope !== null) await closeTabQuestions(repos, tab.id, 'answered_in_tab', scope);
    }
  } catch (err) {
    log.warn({ tabId: tab.id, code: failureLabel(err) }, 'tab question bookkeeping failed');
  }
}

/** A removed tab (closed from the UI, by the concierge, or with its machine) expires its question. */
export function startTabQuestionExpiry(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>): () => void {
  return monitorBus.subscribeLifecycle((event) => {
    if (event.kind !== 'removed') return;
    void closeTabQuestions(repos, event.tab_id, 'expired').catch((err) => log.warn({ tabId: event.tab_id, code: failureLabel(err) }, 'tab question expiry failed'));
    // and its usage-limit card (TER-589)
    void expireTabLimits(repos, log, event.tab_id);
  });
}

/**
 * Closes, as `expired`, every card whose tab is gone without a lifecycle event saying so — the other color
 * removed it during a blue/green switch, or this process was down (spec 2026-09-26 §4.7). At boot and in the
 * hourly purge. Never throws; logs the count and codes only.
 */
export async function expireOrphanTabQuestions(repos: Repositories, log: Pick<FastifyBaseLogger, 'info' | 'warn'>): Promise<number> {
  try {
    const closed = await repos.tabQuestions.expireOrphans();
    await publishTabQuestions(repos, 'tab_question_closed', closed);
    if (closed.length > 0) log.info({ count: closed.length }, 'orphan tab questions expired');
    return closed.length;
  } catch (err) {
    log.warn({ code: failureLabel(err) }, 'orphan tab question sweep failed');
    return 0;
  }
}
