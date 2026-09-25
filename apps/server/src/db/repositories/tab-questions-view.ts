import type { ChoiceAnswer, ChoicePayload, PermissionAnswer, PermissionPayload, TabQuestionKind } from '../../chat/tab-question-payload.js';
import type { Repositories } from './index.js';
import type { TabQuestion, TabQuestionStatus } from './tab-questions.js';

/** A tab's question as both clients render it (`GET /chat`, the bus, the phone): the row minus what
 * only the server needs, plus the tab's name at read time (null once the tab is gone). */
export interface TabQuestionView {
  id: string;
  tab_id: string;
  tab_name: string | null;
  kind: TabQuestionKind;
  payload: ChoicePayload | PermissionPayload;
  status: TabQuestionStatus;
  answer: ChoiceAnswer | PermissionAnswer | null;
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

/** One row as a view, with the tab's name already resolved by the caller. */
export function toTabQuestionView(r: TabQuestion, tabName: string | null): TabQuestionView {
  return {
    id: r.id,
    tab_id: r.tab_id,
    tab_name: tabName,
    kind: r.kind,
    payload: r.payload,
    status: r.status,
    answer: r.answer,
    error_code: r.error_code,
    created_at: r.created_at,
    answered_at: r.answered_at,
    closed_at: r.closed_at,
  };
}
