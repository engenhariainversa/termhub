import type { TabQuestionSuggestion } from '../../chat/decision-text.js';
import type { SuggestionPayload, TabRowKind } from '../../chat/tab-question-payload.js';
import { describeAutoDecisions, type AutoDecisionInput, type AutoDecisionView } from './auto-decision-view.js';
import type { Repositories } from './index.js';
import { PERMISSION_QUEUED, type AnsweredVia, type AutoAnswer, type TabQuestion, type TabQuestionStatus, type TabRowAnswer, type TabRowPayload } from './tab-questions.js';

/** A tab's question as both clients render it (`GET /chat`, the bus, the phone): the row minus what
 * only the server needs, plus the tab's name at read time (null once the tab is gone). */
export interface TabQuestionView {
  id: string;
  tab_id: string;
  tab_name: string | null;
  kind: TabRowKind;
  payload: TabRowPayload;
  status: TabQuestionStatus;
  answer: TabRowAnswer | null;
  error_code: string | null;
  created_at: string;
  answered_at: string | null;
  closed_at: string | null;
  /** Only while the card is still `open` (spec 2026-09-26 §4): answering, closing or the tab moving
   * on drops it, so a screen that reads the row later never resurfaces a stale suggestion. */
  suggestion: TabQuestionSuggestion | null;
  /** The countdown (spec 2026-09-26 concierge memory §6) — the person's own data, shown whole: while
   * the card is `open` (scheduled, cancelled as the pre-selection, or a failed send), and afterwards
   * only when it was `sent` or `failed`, so the card can say so. */
  auto_answer: AutoAnswer | null;
  /** How `answer` was obtained: `'auto'` when the countdown sent it; null on rows from before. */
  answered_via: AnsweredVia | null;
  /** When the card was last brought back to the end of the chat (TER-477): screens order by it, else `created_at`. */
  surfaced_at: string | null;
  /** TER-641: "Decisão automática" — set while the countdown runs or sends (`scheduled`/`sent`, which
   * stays on a card the countdown answered), with its reason and cited decisions resolved owner-scoped.
   * Null on a card answered by a click, a cancelled or failed countdown, or none at all. */
  auto_decision: AutoDecisionView | null;
}

/** The countdown that decides (or decided) this card by itself, as refs to resolve; null otherwise. */
function autoDecisionInput(r: TabQuestion): AutoDecisionInput | null {
  const auto = r.auto_answer;
  if (!auto || (auto.status !== 'scheduled' && auto.status !== 'sent')) return null;
  // A sent countdown only stays on the view of a card it answered, or one still open (in flight).
  if (auto.status === 'sent' && r.status !== 'open' && r.answered_via !== 'auto') return null;
  // `by` only where screens need it (an automatic board answer): other cards' views stay as they were
  return { reason: auto.reason, refs: auto.sources.map((s) => `${s.kind}:${s.id}`), ...(auto.by === 'automation' ? { by: auto.by } : {}) };
}

/** Names resolved owner-scoped, in one batched read: a tab the user cannot see names nothing. The
 * decisions an automatic answer cited are resolved the same way, and only when a row has one (TER-641). */
export async function describeTabQuestions(repos: Pick<Repositories, 'tabs' | 'chatDecisions'>, rows: TabQuestion[], userId: string): Promise<TabQuestionView[]> {
  const ids = [...new Set(rows.map((r) => r.tab_id))];
  const tabs = ids.length ? await repos.tabs.findByIdsForOwner(ids, userId) : [];
  const nameOf = new Map(tabs.map((t) => [t.id, t.name]));
  const inputs = rows.map(autoDecisionInput);
  const autos = inputs.some((i) => i !== null) ? await describeAutoDecisions(repos, inputs, userId) : inputs.map(() => null);
  return rows.map((r, i) => toTabQuestionView(r, nameOf.get(r.tab_id) ?? null, autos[i] ?? null));
}

/** One row as a view, with the tab's name already resolved by the caller. */
export function toTabQuestionView(r: TabQuestion, tabName: string | null, autoDecision: AutoDecisionView | null = null): TabQuestionView {
  return {
    id: r.id,
    tab_id: r.tab_id,
    tab_name: tabName,
    kind: r.kind,
    // A suggestion always carries `context` on the wire (null for a row stored before TER-96).
    // `agent` travels only on a Codex reply card, so Claude's rows keep their exact shape.
    payload: r.kind === 'suggestion' ? { text: (r.payload as SuggestionPayload).text, context: (r.payload as SuggestionPayload).context ?? null, ...((r.payload as SuggestionPayload).agent ? { agent: (r.payload as SuggestionPayload).agent } : {}) } : r.payload,
    status: r.status,
    answer: r.answer,
    // `QUEUED` is the server's own bookkeeping for the permission queue: clients read `error_code` only for
    // `failed`, and the wire never carries the mark (spec 2026-09-26 §4.2).
    error_code: r.error_code === PERMISSION_QUEUED ? null : r.error_code,
    created_at: r.created_at,
    answered_at: r.answered_at,
    closed_at: r.closed_at,
    suggestion: r.status === 'open' ? r.suggestion : null,
    auto_answer: r.auto_answer && (r.status === 'open' || r.auto_answer.status === 'sent' || r.auto_answer.status === 'failed') ? r.auto_answer : null,
    answered_via: r.answered_via ?? null,
    surfaced_at: r.surfaced_at ?? null,
    auto_decision: autoDecision,
  };
}

/**
 * `GET /chat` keeps suggestions out of `tab_questions` (spec 2026-09-25 tab suggestions §6.2): an app
 * that predates them parses that array strictly. They travel in `tab_suggestions`.
 */
export function splitTabRows(views: TabQuestionView[]): { tab_questions: TabQuestionView[]; tab_suggestions: TabQuestionView[] } {
  return { tab_questions: views.filter((v) => v.kind !== 'suggestion'), tab_suggestions: views.filter((v) => v.kind === 'suggestion') };
}
