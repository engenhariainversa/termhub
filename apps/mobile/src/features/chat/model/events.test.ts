import { applyEvent, LIVE_CAP, type EventSlice } from './events';
import type { ChatAction, ChatEvent, ChatMessage, TabQuestion } from './types';

const at = '2026-09-24T12:00:00.000Z';
const base = { user_id: 'u1', conversation_id: 'c1' };
const row = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, conversation_id: 'c1', role: 'assistant', text: '', usage: null, error_code: null, created_at: at, ...extra });
const action = (id: string, status: ChatAction['status'] = 'pending'): ChatAction => ({ id, tool: 't', args: {}, class: 'write', status, machine_id: null, project_id: null, tab_id: null, grant_id: null, summary: 's', created_at: at });
const delta = (messageId: string, text: string): ChatEvent => ({ type: 'delta', ...base, message_id: messageId, delta: text });
const empty: EventSlice = { messages: [], actions: [], live: [], grants: [], tabQuestions: [] };

it('an announced assistant row stays in live; its final row replaces it and clears its deltas, and both ask for a re-read', () => {
  const announced = applyEvent(empty, { type: 'message', ...base, message: row('m1') });
  expect(announced.reread).toBe(true);
  expect(announced.slice.messages).toEqual([row('m1')]);
  expect(announced.slice.live).toHaveLength(1);

  const streaming = applyEvent(announced.slice, delta('m1', 'oi'));
  expect(streaming.reread).toBe(false);
  expect(streaming.slice.live).toHaveLength(2);

  const final = applyEvent(streaming.slice, { type: 'message', ...base, message: row('m1', { text: 'oi' }) });
  expect(final.slice.messages).toEqual([row('m1', { text: 'oi' })]);
  expect(final.slice.live).toEqual([]);
});

it('confirmations and decisions are idempotent', () => {
  const confirmation: ChatEvent = { type: 'confirmation', ...base, action_id: 'a1', tool: 't', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 's', created_at: at };
  const once = applyEvent(empty, confirmation).slice;
  expect(applyEvent(once, confirmation).slice).toBe(once);
  expect(once.actions).toEqual([action('a1')]);

  const decided = applyEvent(once, { type: 'decision', ...base, action_id: 'a1', status: 'approved' }).slice;
  expect(decided.actions).toEqual([action('a1', 'approved')]);
  expect(applyEvent(decided, { type: 'decision', ...base, action_id: 'a1', status: 'approved' }).slice.actions).toBe(decided.actions);
});

it(`keeps at most ${LIVE_CAP} live events, dropping the oldest`, () => {
  let slice = empty;
  for (let i = 0; i < LIVE_CAP + 10; i++) slice = applyEvent(slice, delta('m1', String(i))).slice;
  expect(slice.live).toHaveLength(LIVE_CAP);
  expect(slice.live[0]).toEqual(delta('m1', '10'));
});

it('leaves the slice untouched for events that change nothing here', () => {
  expect(applyEvent(empty, { type: 'hello', protocol: 1, server_time: at }).slice).toBe(empty);
  expect(applyEvent(empty, { type: 'action_result', ...base, message_id: 'm1', tool_use_id: 'x', ok: true }).slice).toBe(empty);
});

it('a decision only settles a pending card: a card that already ran is never moved back', () => {
  const ran: EventSlice = { ...empty, actions: [action('a1', 'executed')] };
  expect(applyEvent(ran, { type: 'decision', ...base, action_id: 'a1', status: 'approved' }).slice.actions).toBe(ran.actions);
});

it('a run_finished event neither crashes nor changes the thread', () => {
  const thread: EventSlice = { messages: [row('m1', { text: 'oi' })], actions: [action('a1')], live: [delta('m1', 'oi')], grants: [], tabQuestions: [] };
  const finished: ChatEvent = { type: 'run_finished', ...base, message_id: 'm1', ok: true, error_code: null };
  const failed: ChatEvent = { type: 'run_finished', ...base, message_id: null, ok: false, error_code: 'HOST_GONE' };
  expect(applyEvent(thread, finished)).toEqual({ slice: thread, reread: false });
  expect(applyEvent(thread, finished).slice).toBe(thread);
  expect(applyEvent(thread, failed).slice).toBe(thread);
});

describe('tab grants', () => {
  const grant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api' };
  const slice: EventSlice = { messages: [], actions: [action('a1')], live: [], grants: [], tabQuestions: [] };

  it('a grant event adds it; a second grant for the same tab replaces the first', () => {
    const added = applyEvent(slice, { type: 'grant', ...base, grant });
    expect(added).toEqual({ slice: { ...slice, grants: [grant] }, reread: false });
    const again = applyEvent(added.slice, { type: 'grant', ...base, grant: { ...grant, id: 'g2' } });
    expect(again.slice.grants).toEqual([{ ...grant, id: 'g2' }]);
    expect(again.reread).toBe(false);
  });

  it('grant_revoked removes it by id', () => {
    const granted: EventSlice = { ...slice, grants: [grant, { ...grant, id: 'g2', tab_id: 't2' }] };
    const revoked = applyEvent(granted, { type: 'grant_revoked', ...base, grant_id: 'g1' });
    expect(revoked).toEqual({ slice: { ...granted, grants: [{ ...grant, id: 'g2', tab_id: 't2' }] }, reread: false });
  });

  it('granted_action appends the card, and replaces a card with the same id', () => {
    const ran: ChatAction = { ...action('a2', 'executed'), grant_id: 'g1' };
    const appended = applyEvent(slice, { type: 'granted_action', ...base, action: ran });
    expect(appended).toEqual({ slice: { ...slice, actions: [action('a1'), ran] }, reread: false });
    const replaced = applyEvent(slice, { type: 'granted_action', ...base, action: { ...action('a1', 'executed'), grant_id: 'g1' } });
    expect(replaced.slice.actions).toEqual([{ ...action('a1', 'executed'), grant_id: 'g1' }]);
    expect(replaced.reread).toBe(false);
  });
});

it('tab question events upsert the card by id and never ask for a re-read', () => {
  const q = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'open', error_code: null, created_at: at, answered_at: null, closed_at: null } as TabQuestion;
  const opened = applyEvent(empty, { type: 'tab_question', ...base, question: q });
  expect(opened).toEqual({ slice: { ...empty, tabQuestions: [q] }, reread: false });
  const answered = { ...q, status: 'answered', answer: { allow: true } } as TabQuestion;
  expect(applyEvent(opened.slice, { type: 'tab_question_answered', ...base, question: answered }).slice.tabQuestions).toEqual([answered]);
  const closed = { ...answered, closed_at: at } as TabQuestion;
  expect(applyEvent(opened.slice, { type: 'tab_question_closed', ...base, question: closed }).slice.tabQuestions).toEqual([closed]);
});
