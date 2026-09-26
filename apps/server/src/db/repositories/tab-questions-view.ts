import type { SuggestionPayload, TabRowKind } from '../../chat/tab-question-payload.js';
import type { Repositories } from './index.js';
import { PERMISSION_QUEUED, type TabQuestion, type TabQuestionStatus, type TabRowAnswer, type TabRowPayload } from './tab-questions.js';

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
}

/** Names resolved owner-scoped, in one batched read: a tab the user cannot see names nothing. */
export async function describeTabQuestions(repos: Pick<Repositories, 'tabs'>, rows: TabQuestion[], userId: string): Promise<TabQuestionView[]> {
  const ids = [...new Set(rows.map((r) => r.tab_id))];
  const tabs = ids.length ? await repos.tabs.findByIdsForOwner(ids, userId) : [];
  const nameOf = new Map(tabs.map((t) => [t.id, t.name]));
  return rows.map((r) => toTabQuestionView(r, nameOf.get(r.tab_id) ?? null));
}

function withoutSubagentFlag(payload: TabRowPayload): TabRowPayload {
  if (!('subagent' in payload)) return payload;
  const { subagent: _flag, ...rest } = payload as TabRowPayload & { subagent?: unknown };
  return rest as TabRowPayload;
}

/** One row as a view, with the tab's name already resolved by the caller. */
export function toTabQuestionView(r: TabQuestion, tabName: string | null): TabQuestionView {
  return {
    id: r.id,
    tab_id: r.tab_id,
    tab_name: tabName,
    kind: r.kind,
    // A suggestion always carries `context` on the wire (null for a row stored before TER-96); a question
    // never carries the server's `subagent` flag (spec 2026-09-26 §4.5), so its shape stays the same.
    payload: r.kind === 'suggestion' ? { text: (r.payload as SuggestionPayload).text, context: (r.payload as SuggestionPayload).context ?? null } : withoutSubagentFlag(r.payload),
    status: r.status,
    answer: r.answer,
    // `QUEUED` is the server's own bookkeeping for the permission queue: clients read `error_code` only for
    // `failed`, and the wire never carries the mark (spec 2026-09-26 §4.2).
    error_code: r.error_code === PERMISSION_QUEUED ? null : r.error_code,
    created_at: r.created_at,
    answered_at: r.answered_at,
    closed_at: r.closed_at,
  };
}

/**
 * `GET /chat` keeps suggestions out of `tab_questions` (spec 2026-09-25 tab suggestions §6.2): an app
 * that predates them parses that array strictly. They travel in `tab_suggestions`.
 */
export function splitTabRows(views: TabQuestionView[]): { tab_questions: TabQuestionView[]; tab_suggestions: TabQuestionView[] } {
  return { tab_questions: views.filter((v) => v.kind !== 'suggestion'), tab_suggestions: views.filter((v) => v.kind === 'suggestion') };
}
