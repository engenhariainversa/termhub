// Ported verbatim from apps/web/src/lib/chat-timeline.test.ts (design spec §6): only the vitest
// import (jest supplies the same globals) and the `message()` fixture (`usage` is a required field
// of the contract's `ChatMessage`, unlike the web's own) were adapted.
import type { ChatAction, ChatMessage, TabQuestion, TabSuggestion } from './types';
import { chatTimeline, groupPendingActions } from './timeline';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    conversation_id: 'c1',
    role: 'assistant',
    text: 'oi',
    usage: null,
    error_code: null,
    created_at: T0,
    ...overrides,
  };
}

function action(overrides: Partial<ChatAction> = {}): ChatAction {
  return {
    id: 'a1',
    tool: 'Bash',
    args: {},
    class: 'write',
    status: 'pending',
    machine_id: null,
    project_id: null,
    tab_id: null,
    summary: 'digitar `npm test` na aba Terminal 2',
    created_at: T0,
    ...overrides,
  };
}

describe('chatTimeline', () => {
  it('interleaves messages and actions by created_at', () => {
    const messages = [message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T2 })];
    const actions = [action({ id: 'a1', created_at: T1 })];

    const result = chatTimeline(messages, actions);

    expect(result.map((e) => (e.kind === 'message' ? e.message.id : e.kind === 'action' ? e.action.id : e.kind === 'tab_question' ? e.question.id : e.kind === 'tab_suggestion' ? e.suggestion.id : e.actions.map((a) => a.id).join(',')))).toEqual(['m1', 'a1', 'm2']);
  });

  it('breaks a tie by putting the message before the action, regardless of the arrays\' own order', () => {
    const tiedMessage = message({ id: 'm1', created_at: T0 });
    const tiedAction = action({ id: 'a1', created_at: T0 });

    // Baseline: the tied pair alone.
    expect(chatTimeline([tiedMessage], [tiedAction]).map((e) => e.kind)).toEqual(['message', 'action']);

    // A stable sort with no explicit tiebreak just preserves concatenation order, so the tie's
    // outcome would flip depending on how the implementation concatenates the two inputs. Padding
    // each array with an earlier and a later entry — so the tied element sits at a different index
    // in each array — must not change which side of the tie wins.
    const paddedMessages = [message({ id: 'm0', created_at: '2025-12-31T00:00:00.000Z' }), tiedMessage, message({ id: 'm2', created_at: T2 })];
    const paddedActions = [action({ id: 'a0', created_at: '2025-12-31T00:00:00.000Z' }), tiedAction, action({ id: 'a2', created_at: T2 })];

    const result = chatTimeline(paddedMessages, paddedActions);
    const tiedPair = result.filter((e) => e.at === T0);
    expect(tiedPair.map((e) => e.kind)).toEqual(['message', 'action']);
  });

  it('does not depend on input order: shuffled inputs produce the same result, including a tied pair', () => {
    const messages = [message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T2 })];
    // a2 ties with m2 at T2, so shuffling must not disturb the message-before-action tiebreak either.
    const actions = [action({ id: 'a1', created_at: T1 }), action({ id: 'a2', created_at: T2 })];

    const forward = chatTimeline(messages, actions);
    const shuffledMessages = [messages[1]!, messages[0]!];
    const shuffledActions = [actions[1]!, actions[0]!];
    const backward = chatTimeline(shuffledMessages, shuffledActions);

    const idsOf = (entries: typeof forward) => entries.map((e) => (e.kind === 'message' ? e.message.id : e.kind === 'action' ? e.action.id : e.kind === 'tab_question' ? e.question.id : e.kind === 'tab_suggestion' ? e.suggestion.id : e.actions.map((a) => a.id).join(',')));
    expect(idsOf(backward)).toEqual(idsOf(forward));
    expect(idsOf(forward)).toEqual(['m1', 'a1', 'm2', 'a2']);
  });

  it('does not mutate its inputs', () => {
    const messages = [message({ id: 'm2', created_at: T2 }), message({ id: 'm1', created_at: T0 })];
    const actions = [action({ id: 'a2', created_at: T2 }), action({ id: 'a1', created_at: T0 })];

    chatTimeline(messages, actions);

    expect(messages.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(actions.map((a) => a.id)).toEqual(['a2', 'a1']);
  });

  it('returns an empty array for an empty conversation', () => {
    expect(chatTimeline([], [])).toEqual([]);
  });

  it('drops an action older than the oldest message, which the two windows let through', () => {
    // The message window is capped at 200 rows, the action window at 200 gated writes: past 200
    // messages the message window starts mid-history while the action window still reaches the
    // beginning of the conversation, so this card has no answer on screen to sit next to.
    const messages = [message({ id: 'm1', created_at: T1 })];
    const actions = [action({ id: 'a-old', created_at: T0 })];

    const result = chatTimeline(messages, actions);

    expect(result.map((e) => (e.kind === 'message' ? e.message.id : e.kind === 'action' ? e.action.id : e.kind === 'tab_question' ? e.question.id : e.kind === 'tab_suggestion' ? e.suggestion.id : e.actions.map((a) => a.id).join(',')))).toEqual(['m1']);
  });

  it('keeps an action newer than the oldest message, including one tied with it', () => {
    const messages = [message({ id: 'm1', created_at: T1 }), message({ id: 'm2', created_at: T2 })];
    const actions = [action({ id: 'a-tied', created_at: T1 }), action({ id: 'a-newer', created_at: T2 })];

    const result = chatTimeline(messages, actions);

    expect(result.map((e) => (e.kind === 'message' ? e.message.id : e.kind === 'action' ? e.action.id : e.kind === 'tab_question' ? e.question.id : e.kind === 'tab_suggestion' ? e.suggestion.id : e.actions.map((a) => a.id).join(',')))).toEqual(['m1', 'a-tied', 'm2', 'a-newer']);
  });

  it('measures the cutoff from the oldest message, not from the array\'s first element', () => {
    // `messages` is whatever the fetch and the live events left in state; nothing guarantees it is
    // sorted, so reading `messages[0]` as the cutoff would drop a card that belongs on screen.
    const messages = [message({ id: 'm2', created_at: T2 }), message({ id: 'm1', created_at: T0 })];
    const actions = [action({ id: 'a1', created_at: T1 })];

    const result = chatTimeline(messages, actions);

    expect(result.map((e) => (e.kind === 'message' ? e.message.id : e.kind === 'action' ? e.action.id : e.kind === 'tab_question' ? e.question.id : e.kind === 'tab_suggestion' ? e.suggestion.id : e.actions.map((a) => a.id).join(',')))).toEqual(['m1', 'a1', 'm2']);
  });

  it('keeps every action when there are no messages at all: there is nothing to compare against', () => {
    const actions = [action({ id: 'a1', created_at: T0 }), action({ id: 'a2', created_at: T2 })];

    const result = chatTimeline([], actions);

    expect(result.map((e) => (e.kind === 'message' ? e.message.id : e.kind === 'action' ? e.action.id : e.kind === 'tab_question' ? e.question.id : e.kind === 'tab_suggestion' ? e.suggestion.id : e.actions.map((a) => a.id).join(',')))).toEqual(['a1', 'a2']);
  });

  it('carries the row\'s own created_at as the entry\'s at', () => {
    const messages = [message({ id: 'm1', created_at: T0 })];
    const actions = [action({ id: 'a1', created_at: T1 })];

    const result = chatTimeline(messages, actions);

    expect(result[0]!.at).toBe(T0);
    expect(result[1]!.at).toBe(T1);
  });

  it('places a tab question by its time, after a message of the same instant, inside the message window', () => {
    const q = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'open', error_code: null, created_at: T1, answered_at: null, closed_at: null } as TabQuestion;
    const entries = chatTimeline([message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T1 })], [], [q, { ...q, id: 'q0', created_at: '2025-12-31T23:59:00.000Z' } as TabQuestion]);
    expect(entries.map((e) => (e.kind === 'message' ? e.message.id : e.kind === 'action' ? e.action.id : e.kind === 'tab_question' ? e.question.id : e.kind === 'tab_suggestion' ? e.suggestion.id : e.actions.map((a) => a.id).join(',')))).toEqual(['m1', 'm2', 'q1']);
  });

  it('places a tab suggestion by created_at, after the message of the same instant, inside the message window', () => {
    const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: T1, answered_at: null, closed_at: null } as TabSuggestion;
    const entries = chatTimeline([message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T1 })], [], [], [s, { ...s, id: 's0', created_at: '2025-12-31T23:59:00.000Z' } as TabSuggestion]);
    expect(entries.map((e) => (e.kind === 'tab_suggestion' ? e.suggestion.id : e.kind))).toEqual(['message', 'message', 's1']);
  });
});

describe('groupPendingActions', () => {
  it('leaves a single pending card alone', () => {
    const entries = chatTimeline([message({ id: 'm1', created_at: T0 })], [action({ id: 'a1', created_at: T1 }), action({ id: 'a2', created_at: T2, status: 'approved' })]);
    expect(groupPendingActions(entries)).toEqual(entries);
  });

  it('replaces two or more pending cards with one group at the oldest one\'s place, keeping decided cards', () => {
    const T3 = '2026-01-01T00:03:00.000Z';
    const T4 = '2026-01-01T00:04:00.000Z';
    const entries = chatTimeline(
      [message({ id: 'm1', created_at: T0 }), message({ id: 'm2', created_at: T3 })],
      [action({ id: 'a1', created_at: T1 }), action({ id: 'a2', created_at: T2, status: 'denied' }), action({ id: 'a3', created_at: T4 })],
    );

    const result = groupPendingActions(entries);

    expect(result.map((e) => e.kind)).toEqual(['message', 'action_group', 'action', 'message']);
    const group = result[1]!;
    expect(group.kind === 'action_group' && group.actions.map((a) => a.id)).toEqual(['a1', 'a3']);
    expect(group.at).toBe(T1);
    const decided = result[2]!;
    expect(decided.kind === 'action' && decided.action.id).toBe('a2');
  });
});
