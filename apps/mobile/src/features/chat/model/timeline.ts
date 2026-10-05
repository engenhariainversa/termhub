// Copied verbatim from apps/web/src/lib/chat-timeline.ts (design spec §6, "Chat logic" row); only
// the import of the shared types was adapted — `./types` here re-exports the contract's own types
// under the web's names (see `types.ts`), instead of the web's own `lib/types.ts`. Delete this copy
// once `@termhub/mobile-api` exports it (design spec §6). The usage-limit cards (TER-589) follow the web's
// own `chatTimeline`, which takes them the same way.
import type { ChatAction, ChatMessage, TabLimit, TabQuestion, TabSuggestion } from './types';

export type ChatEntry =
  | { kind: 'message'; at: string; message: ChatMessage }
  | { kind: 'action'; at: string; action: ChatAction }
  | { kind: 'action_group'; at: string; actions: ChatAction[] }
  | { kind: 'tab_question'; at: string; question: TabQuestion }
  | { kind: 'tab_suggestion'; at: string; suggestion: TabSuggestion }
  | { kind: 'tab_limit'; at: string; limit: TabLimit };

/** Where a card sits in the thread (spec 2026-09-30 §2.2): when it was brought back to the end of the
 * thread, else when it was created. Both the order and the window rule below use it. */
const cardAt = (card: { created_at: string; surfaced_at?: string | null }): string => card.surfaced_at ?? card.created_at;

/**
 * Merges messages and gate cards into one chronological thread, so a card renders next to the
 * answer that proposed it instead of in a separate list. Copies both inputs into entries first —
 * `messages` and `actions` are React state, re-fetched on every load and reconnect, and sorting
 * them in place would be a re-render bug that only shows up under StrictMode.
 */
export function chatTimeline(messages: ChatMessage[], actions: ChatAction[], tabQuestions: TabQuestion[] = [], tabSuggestions: TabSuggestion[] = [], tabLimits: TabLimit[] = []): ChatEntry[] {
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
  // A card brought back to the end of the thread is measured where it now sits (`cardAt`).
  const visibleActions = oldestMessageAt === null ? actions : actions.filter((action) => cardAt(action) >= oldestMessageAt);
  // A tab's question card follows the same window rule as a gate card: it belongs next to the thread around it.
  const visibleQuestions = oldestMessageAt === null ? tabQuestions : tabQuestions.filter((q) => cardAt(q) >= oldestMessageAt);
  const visibleSuggestions = oldestMessageAt === null ? tabSuggestions : tabSuggestions.filter((s) => cardAt(s) >= oldestMessageAt);
  const visibleLimits = oldestMessageAt === null ? tabLimits : tabLimits.filter((l) => cardAt(l) >= oldestMessageAt);

  // Actions first, deliberately: a stable sort with no tiebreak would just preserve this
  // concatenation order, so putting actions ahead of messages here means the "message before
  // action" rule below is doing the work, not an accident of array order. Removing that tiebreak
  // would now surface the wrong order (action before message on a tie) instead of hiding it.
  const entries: ChatEntry[] = [
    ...visibleActions.map((action): ChatEntry => ({ kind: 'action', at: cardAt(action), action })),
    ...messages.map((message): ChatEntry => ({ kind: 'message', at: message.created_at, message })),
    ...visibleQuestions.map((question): ChatEntry => ({ kind: 'tab_question', at: cardAt(question), question })),
    ...visibleSuggestions.map((suggestion): ChatEntry => ({ kind: 'tab_suggestion', at: cardAt(suggestion), suggestion })),
    ...visibleLimits.map((limit): ChatEntry => ({ kind: 'tab_limit', at: cardAt(limit), limit })),
  ];

  /**
   * TER-984: the answer's row is created empty when its turn starts and filled in as the turn runs, so
   * by time alone every card the turn made would read after its answer. A call that ran without asking
   * (a `grant_id`: set once, when the row is made) belongs inside the turn, so it is sorted just before
   * the answer of the turn it ran in, and the answer stays the last thing the turn shows. A card that
   * asks for confirmation keeps its own time, and so does a call made after a user message with no
   * answer yet (there is no answer of its turn to sit above).
   */
  const byTime = [...messages].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const turnAnswerAt = (at: string): string | null => {
    let last: ChatMessage | null = null;
    for (const m of byTime) {
      if (m.created_at > at) break;
      last = m;
    }
    return last?.role === 'assistant' ? last.created_at : null;
  };
  // rank breaks a tie at the same `key`: a call anchored to an answer reads before it, any other card after it.
  const keyed = entries.map((entry) => {
    if (entry.kind === 'action' && entry.action.grant_id && !entry.action.surfaced_at) {
      const answerAt = turnAnswerAt(entry.at);
      if (answerAt !== null) return { entry, key: answerAt, rank: 0 };
    }
    return { entry, key: entry.at, rank: entry.kind === 'message' ? 1 : 2 };
  });

  return keyed
    .sort((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      // A card (a gate card, a tab's question, suggestion or usage limit) reads after the message of the same instant; two cards keep their order.
      if (a.rank !== b.rank) return a.rank - b.rank;
      // Calls anchored to the same answer keep the order they ran in.
      if (a.rank === 0) return a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : 0;
      return 0;
    })
    .map((k) => k.entry);
}

/** Two or more pending gate cards become one grouped confirmation, where the oldest of them was (spec
 * 2026-09-26 §7.1): while cards wait the concierge has stopped, so they are one request's worth. */
export function groupPendingActions(entries: ChatEntry[]): ChatEntry[] {
  const pending = entries.flatMap((e) => (e.kind === 'action' && e.action.status === 'pending' ? [e.action] : []));
  if (pending.length < 2) return entries;
  let placed = false;
  return entries.flatMap((e): ChatEntry[] => {
    if (e.kind !== 'action' || e.action.status !== 'pending') return [e];
    if (placed) return [];
    placed = true;
    return [{ kind: 'action_group', at: e.at, actions: pending }];
  });
}
