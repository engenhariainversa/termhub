import { applyEvent, mergeMessage, mergeThread, type EventSlice } from './events';
import { emptyFold, foldLive } from './live';
import type { ChatAction, ChatEvent, ChatMessage, TabQuestion, TabSuggestion } from './types';

const at = '2026-09-24T12:00:00.000Z';
const base = { user_id: 'u1', conversation_id: 'c1' };
const row = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, conversation_id: 'c1', role: 'assistant', text: '', usage: null, error_code: null, created_at: at, ...extra });
const action = (id: string, status: ChatAction['status'] = 'pending'): ChatAction => ({ id, tool: 't', args: {}, class: 'write', status, machine_id: null, project_id: null, tab_id: null, grant_id: null, summary: 's', created_at: at });
const delta = (messageId: string, text: string): ChatEvent => ({ type: 'delta', ...base, message_id: messageId, delta: text });
const empty: EventSlice = { messages: [], actions: [], live: emptyFold(), grants: [], tabQuestions: [], tabSuggestions: [] };
const att = { id: 'att1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf' as const, bytes: 10, status: 'pending' as const, error_code: null, meta: null, created_at: at };

describe('mergeMessage', () => {
  it('appends a new row, replaces a changed one and keeps the other row objects', () => {
    const a = row('a', { text: 'x' });
    const b = row('b');
    const list = [a, b];
    const appended = mergeMessage(list, row('c'));
    expect(appended.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(appended[0]).toBe(a);

    const replaced = mergeMessage(list, row('b', { text: 'done' }));
    expect(replaced).not.toBe(list);
    expect(replaced[0]).toBe(a);
    expect(replaced[1]).toEqual(row('b', { text: 'done' }));
  });

  it('hands back the very same list when nothing changed (same text, usage, error code and time)', () => {
    const a = row('a', { text: 'x', usage: { input: 1 } });
    const list = [a];
    expect(mergeMessage(list, { ...a, usage: { input: 1 } })).toBe(list);
    expect(mergeMessage(list, { ...a, usage: { input: 2 } })).not.toBe(list);
    expect(mergeMessage(list, { ...a, error_code: 'HOST_GONE' })).not.toBe(list);
    expect(mergeMessage(list, { ...a, created_at: '2026-09-24T12:00:01.000Z' })).not.toBe(list);
  });

  it('compares attachments the way the web does (length, then id, status and error code per position; undefined is [])', () => {
    const a = row('a', { role: 'user', attachments: [att] });
    const list = [a];
    expect(mergeMessage(list, { ...a, attachments: [{ ...att, meta: { pages: 2 } }] })).toBe(list);
    expect(mergeMessage(list, { ...a, attachments: [{ ...att, status: 'ready' }] })).not.toBe(list);
    expect(mergeMessage(list, { ...a, attachments: [{ ...att, status: 'failed', error_code: 'ATTACHMENT_INVALID' }] })).not.toBe(list);
    expect(mergeMessage(list, { ...a, attachments: [{ ...att, id: 'att2' }] })).not.toBe(list);
    expect(mergeMessage(list, { ...a, attachments: [] })).not.toBe(list);
    expect(mergeMessage(list, { ...a, attachments: undefined })).not.toBe(list);
    const bare = row('b', { role: 'user' });
    const bareList = [bare];
    expect(mergeMessage(bareList, { ...bare, attachments: [] })).toBe(bareList);
    expect(mergeMessage(bareList, { ...bare, attachments: [att] })).not.toBe(bareList);
  });
});

describe('mergeThread', () => {
  const later = '2026-09-24T12:00:05.000Z';

  it('merges the snapshot by id: server rows win, untouched rows keep their objects, and the same list comes back when nothing changed', () => {
    const a = row('a', { text: 'x' });
    const b = row('b', { text: 'y' });
    const current = [a, b];
    expect(mergeThread(current, [row('a', { text: 'x' }), row('b', { text: 'y' })])).toBe(current);
    const merged = mergeThread(current, [row('a', { text: 'x' }), row('b', { text: 'y', usage: { output: 3 } })]);
    expect(merged[0]).toBe(a);
    expect(merged[1]).toEqual(row('b', { text: 'y', usage: { output: 3 } }));
  });

  it("keeps a row the snapshot lacks when it is newer than the snapshot (a message event that landed meanwhile) or this device's own, and drops the rest", () => {
    const a = row('a', { text: 'x' });
    const landed = row('c', { text: 'oi', created_at: later });
    const local = row('local:1', { role: 'user', text: 'oi', local: 'sending' });
    const gone = row('old', { text: 'z', created_at: '2026-09-24T11:00:00.000Z' });
    const merged = mergeThread([a, gone, landed, local], [a, row('b', { text: 'new' })]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'c', 'local:1', 'b']);
    expect(merged[0]).toBe(a);
  });

  it('a re-read corrects an attachment status the phone missed while backgrounded or offline', () => {
    const sent = row('m1', { role: 'user', attachments: [att] });
    const current = [sent];
    const merged = mergeThread(current, [{ ...sent, attachments: [{ ...att, status: 'ready', meta: { pages: 2 } }] }]);
    expect(merged).not.toBe(current);
    expect(merged[0]!.attachments).toEqual([{ ...att, status: 'ready', meta: { pages: 2 } }]);
    expect(mergeThread(merged, [{ ...sent, attachments: [{ ...att, status: 'ready', meta: { pages: 2 } }] }])).toBe(merged);
  });

  it('an empty snapshot keeps every current row (nothing is older than it)', () => {
    const current = [row('a', { text: 'x' })];
    expect(mergeThread(current, [])).toBe(current);
  });
});

it('an announced assistant row is marked started; its final row replaces it by id and clears its deltas; the slice is untouched when nothing changed', () => {
  const announced = applyEvent(empty, { type: 'message', ...base, message: row('m1') });
  expect(announced.messages).toEqual([row('m1')]);
  expect(announced.live.started.has('m1')).toBe(true);
  expect(applyEvent(announced, { type: 'message', ...base, message: row('m1') })).toBe(announced);

  const streaming = applyEvent(announced, delta('m1', 'oi'));
  expect(streaming.live.deltas.get('m1')).toBe('oi');
  expect(streaming.messages).toBe(announced.messages);

  const final = applyEvent(streaming, { type: 'message', ...base, message: row('m1', { text: 'oi' }) });
  expect(final.messages).toEqual([row('m1', { text: 'oi' })]);
  expect(final.live).toEqual(emptyFold());
});

it('confirmations and decisions are idempotent', () => {
  const confirmation: ChatEvent = { type: 'confirmation', ...base, action_id: 'a1', tool: 't', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 's', created_at: at };
  const once = applyEvent(empty, confirmation);
  expect(applyEvent(once, confirmation)).toBe(once);
  expect(once.actions).toEqual([action('a1')]);

  const decided = applyEvent(once, { type: 'decision', ...base, action_id: 'a1', status: 'approved' });
  expect(decided.actions).toEqual([action('a1', 'approved')]);
  expect(applyEvent(decided, { type: 'decision', ...base, action_id: 'a1', status: 'approved' }).actions).toBe(decided.actions);
});

it('leaves the slice untouched for events that change nothing here', () => {
  expect(applyEvent(empty, { type: 'hello', protocol: 1, server_time: at })).toBe(empty);
  expect(applyEvent(empty, { type: 'action_result', ...base, message_id: 'm1', tool_use_id: 'x', ok: true })).toBe(empty);
  expect(applyEvent(empty, { type: 'reset', ...base, message_id: 'm1' })).toBe(empty);
});

it('a decision only settles a pending card: a card that already ran is never moved back', () => {
  const ran: EventSlice = { ...empty, actions: [action('a1', 'executed')] };
  expect(applyEvent(ran, { type: 'decision', ...base, action_id: 'a1', status: 'approved' }).actions).toBe(ran.actions);
});

it('a run_finished event neither crashes nor changes the thread', () => {
  const thread: EventSlice = { messages: [row('m1', { text: 'oi' })], actions: [action('a1')], live: foldLive([delta('m1', 'oi')]), grants: [], tabQuestions: [], tabSuggestions: [] };
  const finished: ChatEvent = { type: 'run_finished', ...base, message_id: 'm1', ok: true, error_code: null };
  const failed: ChatEvent = { type: 'run_finished', ...base, message_id: null, ok: false, error_code: 'HOST_GONE' };
  expect(applyEvent(thread, finished)).toBe(thread);
  expect(applyEvent(thread, failed)).toBe(thread);
});

describe('tab grants', () => {
  const grant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api' };
  const slice: EventSlice = { messages: [], actions: [action('a1')], live: emptyFold(), grants: [], tabQuestions: [], tabSuggestions: [] };

  it('a grant event adds it; a second grant for the same tab replaces the first', () => {
    const added = applyEvent(slice, { type: 'grant', ...base, grant });
    expect(added).toEqual({ ...slice, grants: [grant] });
    const again = applyEvent(added, { type: 'grant', ...base, grant: { ...grant, id: 'g2' } });
    expect(again.grants).toEqual([{ ...grant, id: 'g2' }]);
  });

  it('grant_revoked removes it by id', () => {
    const granted: EventSlice = { ...slice, grants: [grant, { ...grant, id: 'g2', tab_id: 't2' }] };
    const revoked = applyEvent(granted, { type: 'grant_revoked', ...base, grant_id: 'g1' });
    expect(revoked).toEqual({ ...granted, grants: [{ ...grant, id: 'g2', tab_id: 't2' }] });
  });

  it('granted_action appends the card, and replaces a card with the same id', () => {
    const ran: ChatAction = { ...action('a2', 'executed'), grant_id: 'g1' };
    const appended = applyEvent(slice, { type: 'granted_action', ...base, action: ran });
    expect(appended).toEqual({ ...slice, actions: [action('a1'), ran] });
    const replaced = applyEvent(slice, { type: 'granted_action', ...base, action: { ...action('a1', 'executed'), grant_id: 'g1' } });
    expect(replaced.actions).toEqual([{ ...action('a1', 'executed'), grant_id: 'g1' }]);
  });
});

it('tab question events upsert the card by id', () => {
  const q = { id: 'q1', tab_id: 't1', tab_name: 'api', kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'open', error_code: null, created_at: at, answered_at: null, closed_at: null } as TabQuestion;
  const opened = applyEvent(empty, { type: 'tab_question', ...base, question: q });
  expect(opened).toEqual({ ...empty, tabQuestions: [q] });
  const answered = { ...q, status: 'answered', answer: { allow: true } } as TabQuestion;
  expect(applyEvent(opened, { type: 'tab_question_answered', ...base, question: answered }).tabQuestions).toEqual([answered]);
  const closed = { ...answered, closed_at: at } as TabQuestion;
  expect(applyEvent(opened, { type: 'tab_question_closed', ...base, question: closed }).tabQuestions).toEqual([closed]);
});

it('tab suggestion events upsert the card by id', () => {
  const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: at, answered_at: null, closed_at: null } as TabSuggestion;
  const opened = applyEvent(empty, { type: 'tab_suggestion', ...base, suggestion: s });
  expect(opened).toEqual({ ...empty, tabSuggestions: [s] });
  const sent = { ...s, status: 'answered', answer: { text: 'commit it' } } as TabSuggestion;
  expect(applyEvent(opened, { type: 'tab_suggestion_closed', ...base, suggestion: sent }).tabSuggestions).toEqual([sent]);
});

describe('attachment_status', () => {
  const attachment = { id: 'att1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf' as const, bytes: 10, status: 'pending' as const, error_code: null, meta: null, created_at: at };
  const user = row('m1', { role: 'user', attachments: [attachment] });
  const other = row('m0', { role: 'user', text: 'oi', attachments: undefined });
  const slice: EventSlice = { ...empty, messages: [other, user] };

  it('patches the attachment inside its message, keeps the other rows and the fold', () => {
    const next = applyEvent(slice, { type: 'attachment_status', ...base, attachment: { ...attachment, status: 'ready', meta: { pages: 3 } } });
    expect(next).not.toBe(slice);
    expect(next.messages[0]).toBe(other);
    expect(next.messages[1]!.attachments).toEqual([{ ...attachment, status: 'ready', meta: { pages: 3 } }]);
    expect(next.live).toBe(slice.live);
  });

  it('is a no-op for an unknown id or an unchanged status', () => {
    expect(applyEvent(slice, { type: 'attachment_status', ...base, attachment: { ...attachment, id: 'zz' } })).toBe(slice);
    expect(applyEvent(slice, { type: 'attachment_status', ...base, attachment })).toBe(slice);
  });
});
