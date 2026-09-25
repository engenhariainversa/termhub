import type { ChatAction, ChatMessage, TabQuestion, TabSuggestion } from './types';

export type ChatEntry =
  | { kind: 'message'; at: string; message: ChatMessage }
  | { kind: 'action'; at: string; action: ChatAction }
  | { kind: 'tab_question'; at: string; question: TabQuestion }
  | { kind: 'tab_suggestion'; at: string; suggestion: TabSuggestion };

/**
 * Merges messages, gate cards and tab questions into one chronological thread, so a card renders
 * next to the answer that proposed it instead of in a separate list. Copies both inputs into
 * entries first — `messages` and `actions` are React state, re-fetched on every load and
 * reconnect, and sorting them in place would be a re-render bug that only shows up under
 * StrictMode.
 */
export function chatTimeline(messages: ChatMessage[], actions: ChatAction[], tabQuestions: TabQuestion[] = [], tabSuggestions: TabSuggestion[] = []): ChatEntry[] {
  /**
   * `GET /api/chat` reads two independent windows: the newest 200 messages and the newest 200
   * actions. Only gated writes ever land in the action trail, so past 200 messages the message
   * window starts mid-history while the much shorter action window still reaches back to the
   * beginning of the conversation — every older card would then sort above the oldest visible
   * message and `/chat` would open with a block of already-decided cards and no messages around
   * them. A card belongs next to the answer that proposed it, so a card whose answer is not in the
   * message window is not shown at all. With no messages to compare against there is no cutoff to
   * apply: keep every action rather than inventing one.
   */
  const oldestMessageAt = messages.reduce<string | null>((oldest, m) => (oldest === null || m.created_at < oldest ? m.created_at : oldest), null);
  const visibleActions = oldestMessageAt === null ? actions : actions.filter((action) => action.created_at >= oldestMessageAt);
  // A tab's question card follows the same window rule as a gate card: it belongs next to the thread around it.
  const visibleQuestions = oldestMessageAt === null ? tabQuestions : tabQuestions.filter((q) => q.created_at >= oldestMessageAt);
  const visibleSuggestions = oldestMessageAt === null ? tabSuggestions : tabSuggestions.filter((s) => s.created_at >= oldestMessageAt);

  // Actions first, deliberately: a stable sort with no tiebreak would just preserve this
  // concatenation order, so putting actions ahead of messages here means the "message before
  // action" rule below is doing the work, not an accident of array order. Removing that tiebreak
  // would now surface the wrong order (action before message on a tie) instead of hiding it.
  const entries: ChatEntry[] = [
    ...visibleActions.map((action): ChatEntry => ({ kind: 'action', at: action.created_at, action })),
    ...messages.map((message): ChatEntry => ({ kind: 'message', at: message.created_at, message })),
    ...visibleQuestions.map((question): ChatEntry => ({ kind: 'tab_question', at: question.created_at, question })),
    ...visibleSuggestions.map((suggestion): ChatEntry => ({ kind: 'tab_suggestion', at: suggestion.created_at, suggestion })),
  ];

  return entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    // A card (a gate card, a tab's question or suggestion) reads after the message of the same instant; two cards keep their order.
    if (a.kind === 'message' && b.kind !== 'message') return -1;
    if (b.kind === 'message' && a.kind !== 'message') return 1;
    return 0;
  });
}
