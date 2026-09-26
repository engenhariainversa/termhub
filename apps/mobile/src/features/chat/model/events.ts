// How one live event of the open conversation changes its thread (design spec §6): pure reducers
// over the slice the chat store keeps — the thread's messages and actions and the `live` fold of the
// answer being written. The store decides which events reach here (`belongsTo`) and does the I/O.
import { applyLive, type LiveFold } from './live';
import { upsertTabSuggestion } from './tab-suggestion-text';
import type { ChatAction, ChatEvent, ChatGrant, ChatMessage, TabQuestion, TabSuggestion } from './types';

export interface EventSlice {
  messages: ChatMessage[];
  actions: ChatAction[];
  /** The answer being written: streamed text, tool calls and started rows, by message id. */
  live: LiveFold;
  /** The conversation's trusted tabs; at most one per tab (a new grant replaces the old one). */
  grants: ChatGrant[];
  /** The tabs' questions pushed into this conversation (spec 2026-09-25 §6.3). */
  tabQuestions: TabQuestion[];
  /** The tabs' suggestions pushed into this conversation (spec 2026-09-25 tab suggestions §6.4). */
  tabSuggestions: TabSuggestion[];
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === message.id);
  if (i < 0) return [...messages, message];
  return messages.map((m, j) => (j === i ? message : m));
}

/** Settles the pending action `id` as approved or denied. A card that has moved on already — a
 * re-read that says it ran, failed or expired — is never moved back; the same array when nothing
 * changes (idempotent). */
export function settlePending(actions: ChatAction[], id: string, status: 'approved' | 'denied'): ChatAction[] {
  if (!actions.some((a) => a.id === id && a.status === 'pending')) return actions;
  return actions.map((a) => (a.id === id ? { ...a, status } : a));
}

/** Every tab-question event carries the whole card: replace it by id, or append it. */
export function upsertTabQuestion(list: TabQuestion[], q: TabQuestion): TabQuestion[] {
  return list.some((x) => x.id === q.id) ? list.map((x) => (x.id === q.id ? q : x)) : [...list, q];
}

function actionFromConfirmation(e: Extract<ChatEvent, { type: 'confirmation' }>): ChatAction {
  return {
    id: e.action_id,
    tool: e.tool,
    args: e.args,
    class: e.class,
    status: 'pending',
    machine_id: e.machine_id,
    project_id: e.project_id,
    tab_id: e.tab_id,
    grant_id: null,
    summary: e.summary,
    created_at: e.created_at,
  };
}

/**
 * The slice after `e`, and whether the thread must be re-read from the server (every `message`
 * event: the web's rule). Returns the same slice for an event that changes nothing.
 */
export function applyEvent(slice: EventSlice, e: ChatEvent): { slice: EventSlice; reread: boolean } {
  switch (e.type) {
    case 'message': {
      // The row is final (or just announced): shown at once from the event and then confirmed by the
      // re-read. The fold drops its deltas when it is final, and marks it started when it announces.
      return { slice: { ...slice, messages: upsertMessage(slice.messages, e.message), live: applyLive(slice.live, e) }, reread: true };
    }
    case 'confirmation':
      if (slice.actions.some((a) => a.id === e.action_id)) return { slice, reread: false };
      return { slice: { ...slice, actions: [...slice.actions, actionFromConfirmation(e)] }, reread: false };
    case 'decision':
      return { slice: { ...slice, actions: settlePending(slice.actions, e.action_id, e.status) }, reread: false };
    case 'grant':
      return { slice: { ...slice, grants: [...slice.grants.filter((g) => g.id !== e.grant.id && g.tab_id !== e.grant.tab_id), e.grant] }, reread: false };
    case 'grant_revoked':
      return { slice: { ...slice, grants: slice.grants.filter((g) => g.id !== e.grant_id) }, reread: false };
    case 'granted_action':
      // A send_input run under a grant never asked: its card arrives whole, already executed.
      return {
        slice: { ...slice, actions: slice.actions.some((a) => a.id === e.action.id) ? slice.actions.map((a) => (a.id === e.action.id ? e.action : a)) : [...slice.actions, e.action] },
        reread: false,
      };
    case 'tab_question':
    case 'tab_question_answered':
    case 'tab_question_closed':
      return { slice: { ...slice, tabQuestions: upsertTabQuestion(slice.tabQuestions, e.question) }, reread: false };
    case 'tab_suggestion':
    case 'tab_suggestion_closed':
      return { slice: { ...slice, tabSuggestions: upsertTabSuggestion(slice.tabSuggestions, e.suggestion) }, reread: false };
    case 'delta':
    case 'action':
    case 'reset': {
      const live = applyLive(slice.live, e);
      return live === slice.live ? { slice, reread: false } : { slice: { ...slice, live }, reread: false };
    }
    default:
      return { slice, reread: false };
  }
}
