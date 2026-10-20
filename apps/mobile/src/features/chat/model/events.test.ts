import { applyEvent, mergeMessage, mergeThread, type EventSlice } from './events';
import { applyLive, emptyFold, foldLive } from './live';
import type { ChatAction, ChatEvent, ChatMessage, SubagentView, TabLimit, TabQuestion, TabSuggestion } from './types';

const at = '2026-09-24T12:00:00.000Z';
const base = { user_id: 'u1', conversation_id: 'c1' };
const row = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, conversation_id: 'c1', role: 'assistant', text: '', usage: null, error_code: null, created_at: at, ...extra });
const action = (id: string, status: ChatAction['status'] = 'pending'): ChatAction => ({ id, tool: 't', args: {}, class: 'write', status, machine_id: null, project_id: null, tab_id: null, grant_id: null, summary: 's', created_at: at });
const delta = (messageId: string, text: string): ChatEvent => ({ type: 'delta', ...base, message_id: messageId, delta: text });
const empty: EventSlice = { messages: [], actions: [], live: emptyFold(), grants: [], projectGrants: [], tabQuestions: [], tabSuggestions: [], tabLimits: [], subagents: [], cancelFailed: [] };
const att = { id: 'att1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf' as const, bytes: 10, status: 'pending' as const, error_code: null, meta: null, created_at: at };
const subagent = (over: Partial<SubagentView> & { id: string }): SubagentView => ({ description: 'Buscar CI', subagent_type: null, status: 'running', started_at: at, ended_at: null, ...over });

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

  it("keeps the list key of a row this device sent when the server's version replaces it (TER-1001)", () => {
    const sent = row('u1', { role: 'user', text: 'oi', row_key: 'local:abc' });
    const merged = mergeMessage([sent], row('u1', { role: 'user', text: 'oi', created_at: '2026-09-24T12:00:01.000Z' }));
    expect(merged[0]).toMatchObject({ id: 'u1', created_at: '2026-09-24T12:00:01.000Z', row_key: 'local:abc' });
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
  const NONE: ReadonlySet<string> = new Set();
  const later = '2026-09-24T12:00:05.000Z';

  it('merges the snapshot by id: server rows win, untouched rows keep their objects, and the same list comes back when nothing changed', () => {
    const a = row('a', { text: 'x' });
    const b = row('b', { text: 'y' });
    const current = [a, b];
    expect(mergeThread(current, [row('a', { text: 'x' }), row('b', { text: 'y' })], NONE, NONE)).toBe(current);
    const merged = mergeThread(current, [row('a', { text: 'x' }), row('b', { text: 'y', usage: { output: 3 } })], NONE, NONE);
    expect(merged[0]).toBe(a);
    expect(merged[1]).toEqual(row('b', { text: 'y', usage: { output: 3 } }));
  });

  // Rewritten on purpose (spec 2026-09-29 §5 rule 3): a row the snapshot lacks used to stay when it
  // was newer than the snapshot's newest row, which kept a deleted answer for ever (an answer is
  // always newer than its question). It now stays only when its `message` event arrived during the read.
  it("keeps a row the snapshot lacks only when its message event arrived during the read, or when it is this device's own, and drops the rest", () => {
    const a = row('a', { text: 'x' });
    const landed = row('c', { text: 'oi', created_at: later });
    const local = row('local:1', { role: 'user', text: 'oi', local: 'sending' });
    const gone = row('old', { text: 'z', created_at: '2026-09-24T11:00:00.000Z' });
    const deletedAnswer = row('d', { created_at: later });
    const merged = mergeThread([a, gone, landed, deletedAnswer, local], [a, row('b', { text: 'new' })], NONE, new Set(['c']));
    expect(merged.map((m) => m.id)).toEqual(['a', 'c', 'local:1', 'b']);
    expect(merged[0]).toBe(a);
  });

  it('keeps a final row over the snapshot\'s empty version of it', () => {
    const done = row('a', { text: 'pronto' });
    const current = [done];
    expect(mergeThread(current, [row('a')], NONE, NONE)).toBe(current);
    const failed = [row('b', { error_code: 'HOST_GONE' })];
    expect(mergeThread(failed, [row('b')], NONE, NONE)).toBe(failed);
  });

  it('leaves out a removed row of the snapshot, and never keeps a removed row as newer than the snapshot', () => {
    const a = row('a', { role: 'user', text: 'oi' });
    const gone = row('g', { created_at: later });
    const merged = mergeThread([a, gone], [a, row('g')], new Set(['g']), new Set(['g']));
    expect(merged.map((m) => m.id)).toEqual(['a']);
    expect(mergeThread([a], [a, row('g')], new Set(['g']), NONE).map((m) => m.id)).toEqual(['a']);
  });

  it('a re-read corrects an attachment status the phone missed while backgrounded or offline', () => {
    const sent = row('m1', { role: 'user', attachments: [att] });
    const current = [sent];
    const merged = mergeThread(current, [{ ...sent, attachments: [{ ...att, status: 'ready', meta: { pages: 2 } }] }], NONE, NONE);
    expect(merged).not.toBe(current);
    expect(merged[0]!.attachments).toEqual([{ ...att, status: 'ready', meta: { pages: 2 } }]);
    expect(mergeThread(merged, [{ ...sent, attachments: [{ ...att, status: 'ready', meta: { pages: 2 } }] }], NONE, NONE)).toBe(merged);
  });

  // Rewritten on purpose (spec 2026-09-29 §5 rule 3): an empty snapshot used to keep every row.
  it('an empty snapshot keeps only the rows that arrived during the read and this device\'s own', () => {
    const current = [row('a', { text: 'x' })];
    expect(mergeThread(current, [], NONE, new Set(['a']))).toBe(current);
    expect(mergeThread(current, [], NONE, NONE)).toEqual([]);
    const local = [row('local:1', { role: 'user', text: 'oi', local: 'failed' })];
    expect(mergeThread(local, [], NONE, NONE)).toBe(local);
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
  // Changed on purpose (spec 2026-09-29 §5): the final row also closes m1, so nothing reopens it.
  expect(final.live).toEqual({ ...emptyFold(), closed: new Set(['m1']) });
});

describe('run state events (spec 2026-09-29 §5)', () => {
  it('mergeMessage keeps a final row over an empty one (text, and error code), returning the same list', () => {
    const answered = [row('m1', { text: 'pronto' })];
    expect(mergeMessage(answered, row('m1'))).toBe(answered);
    const failed = [row('m2', { error_code: 'RUN_FAILED' })];
    expect(mergeMessage(failed, row('m2'))).toBe(failed);
  });

  it('message_removed drops the row from messages and closes it in live', () => {
    const slice = { ...empty, messages: [row('u1', { role: 'user', text: 'oi' }), row('m1')], live: foldLive([delta('m1', 'oi')]) };
    const next = applyEvent(slice, { type: 'message_removed', ...base, message_id: 'm1' });
    expect(next.messages.map((m) => m.id)).toEqual(['u1']);
    expect(next.live.deltas.has('m1')).toBe(false);
    expect(next.live.started.has('m1')).toBe(false);
    expect(next.live.closed.has('m1')).toBe(true);
    expect(next.live.removed.has('m1')).toBe(true);
    expect(applyEvent(next, { type: 'message_removed', ...base, message_id: 'm1' })).toBe(next);
  });

  it('message_removed for a row the slice does not have keeps the same messages array, and remembers the id', () => {
    const slice = { ...empty, messages: [row('u1', { role: 'user', text: 'oi' })] };
    const next = applyEvent(slice, { type: 'message_removed', ...base, message_id: 'm9' });
    expect(next.messages).toBe(slice.messages);
    expect(next.live.removed.has('m9')).toBe(true);
  });

  it('run_started changes only live', () => {
    const slice = { ...empty, messages: [row('m1')] };
    const next = applyEvent(slice, { type: 'run_started', ...base, message_id: 'm1' });
    expect(next.live.started.has('m1')).toBe(true);
    expect(next.messages).toBe(slice.messages);
    expect(next.actions).toBe(slice.actions);
    expect(applyEvent(next, { type: 'run_started', ...base, message_id: 'm1' })).toBe(next);
  });

  it('run_finished with an id closes the row in live; with a null id the slice is the same', () => {
    const slice = { ...empty, messages: [row('m1')], live: applyLive(emptyFold(), delta('m1', 'oi')) };
    const done = applyEvent(slice, { type: 'run_finished', ...base, message_id: 'm1', ok: true, error_code: null });
    expect(done.live.closed.has('m1')).toBe(true);
    expect(done.messages).toBe(slice.messages);
    expect(applyEvent(slice, { type: 'run_finished', ...base, message_id: null, ok: false, error_code: 'SETUP_FAILED' })).toBe(slice);
  });
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

describe('confirmation: subagent origin (spec 2026-09-26 §4)', () => {
  const confirmation = (subagent: { id: string; description: string } | null = null): ChatEvent => ({ type: 'confirmation', ...base, action_id: 'a1', tool: 't', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 's', subagent, created_at: at });

  it('a fresh confirmation carries its subagent through to the card', () => {
    const once = applyEvent(empty, confirmation({ id: 'sub1', description: 'Buscar CI' }));
    expect(once.actions).toEqual([{ ...action('a1'), subagent: { id: 'sub1', description: 'Buscar CI' } }]);
  });

  it('a repeated confirmation merges a later subagent into the existing card, without touching its status', () => {
    const bare = applyEvent(empty, confirmation());
    const decided = applyEvent(bare, { type: 'decision', ...base, action_id: 'a1', status: 'approved' });
    const merged = applyEvent(decided, confirmation({ id: 'sub1', description: 'Buscar CI' }));
    expect(merged.actions).toEqual([{ ...action('a1', 'approved'), subagent: { id: 'sub1', description: 'Buscar CI' } }]);
  });

  it('a repeated confirmation with nothing new changes nothing', () => {
    const once = applyEvent(empty, confirmation({ id: 'sub1', description: 'Buscar CI' }));
    expect(applyEvent(once, confirmation())).toBe(once);
  });
});

describe('pending cards at hand (spec 2026-09-30 TER-477)', () => {
  const later = '2026-09-24T13:00:00.000Z';
  const confirmation = (extra: Partial<Extract<ChatEvent, { type: 'confirmation' }>> = {}): ChatEvent => ({ type: 'confirmation', ...base, action_id: 'a1', tool: 't', args: {}, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 's', created_at: at, ...extra });

  it('a fresh confirmation carries its surfaced_at to the card', () => {
    expect(applyEvent(empty, confirmation({ surfaced_at: later })).actions[0]?.surfaced_at).toBe(later);
  });

  it('a confirmation for a card on screen brings it back: surfaced_at merged, status and subagent kept', () => {
    const sub = { id: 'sub1', description: 'Buscar CI' };
    const once = applyEvent(empty, confirmation({ subagent: sub }));
    const back = applyEvent(once, confirmation({ surfaced_at: later, resurfaced: true }));
    expect(back.actions).toEqual([{ ...action('a1'), subagent: sub, surfaced_at: later }]);
    // The same surfaced_at again changes nothing.
    expect(applyEvent(back, confirmation({ surfaced_at: later, resurfaced: true }))).toBe(back);
  });

  it('merges both a later subagent and a surfaced_at from one confirmation', () => {
    const once = applyEvent(empty, confirmation());
    const sub = { id: 'sub1', description: 'Buscar CI' };
    expect(applyEvent(once, confirmation({ subagent: sub, surfaced_at: later })).actions).toEqual([{ ...action('a1'), subagent: sub, surfaced_at: later }]);
  });

  it('action_status moves the card to its status with the error code; an unknown id changes nothing', () => {
    const slice: EventSlice = { ...empty, actions: [action('a1'), action('a2')] };
    const failed = applyEvent(slice, { type: 'action_status', ...base, action_id: 'a1', status: 'failed', error_code: 'TAB_GONE' });
    expect(failed.actions).toEqual([{ ...action('a1', 'failed'), error_code: 'TAB_GONE' }, action('a2')]);
    expect(failed.actions[1]).toBe(slice.actions[1]);
    const expired = applyEvent(slice, { type: 'action_status', ...base, action_id: 'a2', status: 'expired', error_code: null });
    expect(expired.actions[1]).toEqual({ ...action('a2', 'expired'), error_code: null });
    expect(applyEvent(slice, { type: 'action_status', ...base, action_id: 'zz', status: 'executed', error_code: null })).toBe(slice);
    expect(applyEvent(failed, { type: 'action_status', ...base, action_id: 'a1', status: 'failed', error_code: 'TAB_GONE' })).toBe(failed);
  });

  it('a resurfaced tab question replaces the row, now with surfaced_at', () => {
    const q = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: at, answered_at: null, closed_at: null, kind: 'permission', payload: { tool_name: 'Bash' }, answer: null } as TabQuestion;
    const slice: EventSlice = { ...empty, tabQuestions: [q] };
    const back = applyEvent(slice, { type: 'tab_question', ...base, question: { ...q, surfaced_at: later }, resurfaced: true });
    expect(back.tabQuestions).toEqual([{ ...q, surfaced_at: later }]);
  });
});

describe('subagents panel (spec 2026-09-26 panel §4/§5.4)', () => {
  it('a subagent event upserts the row by id', () => {
    const started = applyEvent(empty, { type: 'subagent', ...base, subagent: subagent({ id: 's1' }) });
    expect(started.subagents).toEqual([subagent({ id: 's1' })]);
    const updated = applyEvent(started, { type: 'subagent', ...base, subagent: subagent({ id: 's1', status: 'completed', ended_at: at }) });
    expect(updated.subagents).toEqual([subagent({ id: 's1', status: 'completed', ended_at: at })]);
  });

  it('subagent_cancel_failed adds the id to cancelFailed; a later subagent event for it clears the mark', () => {
    const slice: EventSlice = { ...empty, subagents: [subagent({ id: 's1' })] };
    const failed = applyEvent(slice, { type: 'subagent_cancel_failed', ...base, subagent_id: 's1' });
    expect(failed.cancelFailed).toEqual(['s1']);
    // Idempotent: a repeat does not duplicate the id.
    expect(applyEvent(failed, { type: 'subagent_cancel_failed', ...base, subagent_id: 's1' })).toBe(failed);

    const cleared = applyEvent(failed, { type: 'subagent', ...base, subagent: subagent({ id: 's1', status: 'stopping' }) });
    expect(cleared.cancelFailed).toEqual([]);
  });
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

// Rewritten on purpose (spec 2026-09-29 §5): `run_finished` with an id used to leave the slice
// alone; it now closes the row in `live`. The thread itself still does not change.
it('a run_finished event neither crashes nor changes the thread; with an id it closes the row in live', () => {
  const thread: EventSlice = { messages: [row('m1', { text: 'oi' })], actions: [action('a1')], live: foldLive([delta('m1', 'oi')]), grants: [], projectGrants: [], tabQuestions: [], tabSuggestions: [], tabLimits: [], subagents: [], cancelFailed: [] };
  const finished: ChatEvent = { type: 'run_finished', ...base, message_id: 'm1', ok: true, error_code: null };
  const failed: ChatEvent = { type: 'run_finished', ...base, message_id: null, ok: false, error_code: 'HOST_GONE' };
  const closed = applyEvent(thread, finished);
  expect(closed.messages).toBe(thread.messages);
  expect(closed.actions).toBe(thread.actions);
  expect(closed.live.closed.has('m1')).toBe(true);
  expect(closed.live.deltas.has('m1')).toBe(false);
  expect(applyEvent(closed, finished)).toBe(closed);
  expect(applyEvent(thread, failed)).toBe(thread);
});

describe('tab grants', () => {
  const grant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api' };
  const slice: EventSlice = { messages: [], actions: [action('a1')], live: emptyFold(), grants: [], projectGrants: [], tabQuestions: [], tabSuggestions: [], tabLimits: [], subagents: [], cancelFailed: [] };

  it('a grant event adds it; a second grant for the same tab replaces the first', () => {
    const added = applyEvent(slice, { type: 'grant', ...base, grant });
    expect(added).toEqual({ ...slice, grants: [grant] });
    const again = applyEvent(added, { type: 'grant', ...base, grant: { ...grant, id: 'g2' } });
    expect(again.grants).toEqual([{ ...grant, id: 'g2' }]);
  });

  it('a narrow grant for a tab keeps its active terminal grant; a same-tool re-grant still replaces', () => {
    const terminal = { ...grant, id: 'gt', tool: 'terminal' };
    const narrow = { ...grant, id: 'gn', tool: 'send_key' };
    const withTerminal = applyEvent(slice, { type: 'grant', ...base, grant: terminal });
    const both = applyEvent(withTerminal, { type: 'grant', ...base, grant: narrow });
    expect(both.grants).toEqual([terminal, narrow]);
    const reTerminal = applyEvent(both, { type: 'grant', ...base, grant: { ...terminal, id: 'gt2' } });
    expect(reTerminal.grants).toEqual([narrow, { ...terminal, id: 'gt2' }]);
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

describe('project grants', () => {
  const pg = { id: 'pg1', project_id: 'p1', project_name: 'termhub', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', scope: 'board' as const };
  const slice: EventSlice = { messages: [], actions: [action('a1')], live: emptyFold(), grants: [], projectGrants: [], tabQuestions: [], tabSuggestions: [], tabLimits: [], subagents: [], cancelFailed: [] };

  it('a project_grant event adds it; a second grant for the same project replaces the first', () => {
    const added = applyEvent(slice, { type: 'project_grant', ...base, grant: pg });
    expect(added).toEqual({ ...slice, projectGrants: [pg] });
    const again = applyEvent(added, { type: 'project_grant', ...base, grant: { ...pg, id: 'pg2' } });
    expect(again.projectGrants).toEqual([{ ...pg, id: 'pg2' }]);
  });

  it('project_grant_revoked removes it by id', () => {
    const granted: EventSlice = { ...slice, projectGrants: [pg, { ...pg, id: 'pg2', project_id: 'p2' }] };
    const revoked = applyEvent(granted, { type: 'project_grant_revoked', ...base, grant_id: 'pg1' });
    expect(revoked).toEqual({ ...granted, projectGrants: [{ ...pg, id: 'pg2', project_id: 'p2' }] });
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

it('usage-limit events upsert the card by id, and leave the rest of the slice alone (TER-589)', () => {
  const l: TabLimit = {
    id: 'l1',
    tab_id: 't1',
    tab_name: 'api',
    payload: { account: { id: 'a1', label: 'Pessoal' }, machine: { id: 'm1', name: 'jarvis' }, resets_at: null, candidates: [{ id: 'a2', label: 'Trabalho' }] },
    status: 'open',
    result: null,
    created_at: at,
    closed_at: null,
  };
  const opened = applyEvent(empty, { type: 'tab_limit', ...base, notice: l });
  expect(opened).toEqual({ ...empty, tabLimits: [l] });
  const other = { ...l, id: 'l2' };
  const both = applyEvent(opened, { type: 'tab_limit', ...base, notice: other });
  expect(both.tabLimits).toEqual([l, other]);
  const swapped: TabLimit = { ...l, status: 'swapped', result: 'a2', closed_at: at };
  expect(applyEvent(both, { type: 'tab_limit_closed', ...base, notice: swapped }).tabLimits).toEqual([swapped, other]);
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
