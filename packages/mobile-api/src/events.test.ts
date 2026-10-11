import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatActionSchema, chatEventSchema, chatMessage, chatGrantListItemSchema, chatGrantListQuery, chatGrantListResponse, chatStandingGrantSchema, STANDING_GRANT_KINDS, subagentViewSchema, tabQuestionSchema, tabSuggestionSchema } from './events.js';

const base = { user_id: 'u1', conversation_id: 'c1' };
const grant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', tab_name: 'api' };
const card = { id: 'a2', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'executed', machine_id: null, project_id: null, tab_id: 't1', grant_id: 'g1', summary: 'digitar `oi` na aba api', created_at: '2026-09-25T10:01:00.000Z' };

describe('chatEventSchema: grants', () => {
  it.each([
    ['grant', { type: 'grant', ...base, grant }],
    ['grant_revoked', { type: 'grant_revoked', ...base, grant_id: 'g1' }],
    ['granted_action', { type: 'granted_action', ...base, action: card }],
  ])('accepts %s', (_t, e) => {
    const r = chatEventSchema.safeParse(e);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('parses project_grant and project_grant_revoked', () => {
    const pg = { id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: '2026-09-27T10:00:00.000Z', expires_at: '2026-09-28T10:00:00.000Z' };
    expect(chatEventSchema.parse({ type: 'project_grant', ...base, grant: pg }).type).toBe('project_grant');
    expect(chatEventSchema.parse({ type: 'project_grant', ...base, grant: { ...pg, project_name: null, source_action_id: null } }).type).toBe('project_grant');
    expect(chatEventSchema.parse({ type: 'project_grant_revoked', ...base, grant_id: 'pg1' }).type).toBe('project_grant_revoked');
  });
  it('project grants carry a scope, board when an older server omits it (TER-325)', () => {
    const pg = { id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: '2026-09-27T10:00:00.000Z', expires_at: '2026-09-28T10:00:00.000Z' };
    const old = chatEventSchema.parse({ type: 'project_grant', ...base, grant: pg });
    expect(old.type === 'project_grant' && old.grant.scope).toBe('board');
    const all = chatEventSchema.parse({ type: 'project_grant', ...base, grant: { ...pg, scope: 'all' } });
    expect(all.type === 'project_grant' && all.grant.scope).toBe('all');
    expect(chatEventSchema.safeParse({ type: 'project_grant', ...base, grant: { ...pg, scope: 'tudo' } }).success).toBe(false);
  });
  it('keeps grant_id on the card', () => {
    const r = chatEventSchema.parse({ type: 'granted_action', ...base, action: card });
    expect(r.type === 'granted_action' && r.action.grant_id).toBe('g1');
  });
});

// The card's origin (spec 2026-09-26 §4): which subagent's turn proposed the action. Optional and
// nullable on both `chatActionSchema` and the `confirmation` event, so an older server (neither field
// nor value) and a current one saying "no subagent" both still parse.
describe('chatActionSchema / confirmation: subagent', () => {
  const subagent = { id: 'sub1', description: 'Escrever testes' };
  it.each([
    ['with a subagent', { ...card, subagent }],
    ['with no subagent (null)', { ...card, subagent: null }],
    ['without the field at all (an older server)', card],
  ])('accepts a card %s', (_label, c) => {
    const r = chatActionSchema.safeParse(c);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('parses the subagent through to the card', () => {
    expect(chatActionSchema.parse({ ...card, subagent }).subagent).toEqual(subagent);
  });

  const confirmation = { type: 'confirmation', ...base, action_id: 'a1', tool: 'run_command', args: { command: 'ls' }, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'Rodar ls', created_at: '2026-09-24T12:00:00.000Z' };
  it.each([
    ['with a subagent', { ...confirmation, subagent }],
    ['with no subagent (null)', { ...confirmation, subagent: null }],
    ['without the field at all (an older server)', confirmation],
  ])('accepts a confirmation %s', (_label, e) => {
    const r = chatEventSchema.safeParse(e);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});

it('parses both kinds of tab question and refuses a payload of the other kind', () => {
  const common = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'choice', payload: { questions: [{ question: 'Q?', header: 'Q', multi_select: false, options: [{ label: 'a', description: '', recommended: true }] }] }, answer: null }).success).toBe(true);
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'permission', payload: { tool_name: 'Bash' }, answer: { allow: false, text: 'não' } }).success).toBe(true);
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'permission', payload: { questions: [] }, answer: null }).success).toBe(false);
});

it('parses a tab suggestion and its two events; refuses a question on them', () => {
  const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabSuggestionSchema.safeParse(s).success).toBe(true);
  expect(tabSuggestionSchema.safeParse({ ...s, status: 'dismissed', closed_at: '2026-09-25T12:01:00.000Z' }).success).toBe(true);
  expect(tabSuggestionSchema.safeParse({ ...s, kind: 'permission', payload: { tool_name: 'Bash' } }).success).toBe(false);
  expect(chatEventSchema.safeParse({ type: 'tab_suggestion', ...base, suggestion: s }).success).toBe(true);
  expect(chatEventSchema.safeParse({ type: 'tab_suggestion_closed', ...base, suggestion: { ...s, status: 'answered', answer: { text: 'commit it' } } }).success).toBe(true);
});

it('a tab question never carries the dismissed status: that value is the suggestions\' own', () => {
  const common = { id: 'q1', tab_id: 't1', tab_name: 'api', error_code: null, created_at: '2026-09-25T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'permission', payload: { tool_name: 'Bash' }, answer: null, status: 'dismissed' }).success).toBe(false);
});

it('a tab question suggestion item may carry the concierge fields (by/reason/sources); an older app still parses without them (concierge memory spec 2026-09-26 §5.4)', () => {
  const common = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: '2026-09-26T12:00:00.000Z', answered_at: null, closed_at: null };
  const choicePayload = { payload: { questions: [{ question: 'Q?', header: 'Q', multi_select: false, options: [{ label: 'a', description: '', recommended: false }] }] }, answer: null };
  const conciergeItem = {
    question_index: 0,
    decision_id: '',
    similarity: 0,
    selected: [0],
    by: 'concierge',
    reason: 'Você sempre faz assim',
    sources: ['doc:i1'],
    source: { question: 'Q?', project_name: null, answered_at: '2026-09-20T10:00:00.000Z' },
  };
  const r = tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload, suggestion: { items: [conciergeItem] } });
  expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  expect(r.success && r.data.suggestion?.items[0]).toMatchObject({ by: 'concierge', reason: 'Você sempre faz assim', sources: ['doc:i1'] });
  // Without them at all: still parses (an older server never sends them, a memory-backed suggestion).
  const { by: _by, reason: _reason, sources: _sources, ...plain } = conciergeItem;
  expect(tabQuestionSchema.safeParse({ ...common, kind: 'choice', ...choicePayload, suggestion: { items: [plain] } }).success).toBe(true);
});

describe('chat grant list', () => {
  const item = {
    id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: null, created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z',
    tab_name: null, project_id: null, project_name: null, conversation_id: 'c1', conversation_project_name: null, conversation_archived: false,
    state: 'expired', ended_at: '2026-09-26T10:00:00.000Z',
  };
  it('parses the server list shape', () => {
    expect(chatGrantListResponse.parse({ grants: [item], next_cursor: null }).grants[0]!.state).toBe('expired');
    expect(chatGrantListResponse.safeParse({ grants: [{ ...item, state: 'gone' }], next_cursor: null }).success).toBe(false);
  });
  it('validates the query: state required, limit 1..100 defaulting to 50', () => {
    expect(chatGrantListQuery.parse({ state: 'ended' })).toEqual({ state: 'ended', limit: 50, kinds: 'tab' });
    expect(chatGrantListQuery.parse({ state: 'active', limit: '10', cursor: 'abc' })).toEqual({ state: 'active', limit: 10, cursor: 'abc', kinds: 'tab' });
    for (const bad of [{}, { state: 'all' }, { state: 'ended', limit: '0' }, { state: 'ended', limit: '101' }, { state: 'ended', cursor: '' }]) expect(chatGrantListQuery.safeParse(bad).success).toBe(false);
  });

  it('list items: kind defaults to tab, a project row has no tab', () => {
    const tabRow = { ...grant, project_id: 'p1', project_name: 'App', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false, state: 'active', ended_at: null };
    expect(chatGrantListItemSchema.parse(tabRow).kind).toBe('tab');
    expect(chatGrantListItemSchema.parse({ ...tabRow, kind: 'project', tab_id: null, tab_name: null, tool: null }).kind).toBe('project');
    expect(chatGrantListQuery.parse({ state: 'active' }).kinds).toBe('tab');
  });

  it('list items: scope is null by default (tab rows, older servers), board or all on project rows (TER-325)', () => {
    const tabRow = { ...grant, project_id: 'p1', project_name: 'App', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false, state: 'active', ended_at: null };
    expect(chatGrantListItemSchema.parse(tabRow).scope).toBeNull();
    const projectRow = { ...tabRow, kind: 'project', tab_id: null, tab_name: null, tool: null };
    expect(chatGrantListItemSchema.parse({ ...projectRow, scope: 'all' }).scope).toBe('all');
    expect(chatGrantListItemSchema.parse({ ...projectRow, scope: 'board' }).scope).toBe('board');
  });
});

describe('standing grants (TER-386)', () => {
  const standing = { id: 'sg1', project_id: 'p1', project_name: 'App', kind: 'close_tab', source_action_id: 'a1', created_at: '2026-09-28T10:00:00.000Z' };
  const listRow = {
    kind: 'standing', id: 'sg1', tab_id: null, tool: null, tab_name: null, source_action_id: 'a1', created_at: '2026-09-28T10:00:00.000Z', expires_at: null,
    project_id: 'p1', project_name: 'App', conversation_id: null, conversation_project_name: null, conversation_archived: false, state: 'active', ended_at: null, scope: null, standing_kind: 'close_tab',
  };

  it('the kinds are the five the server knows', () => {
    expect(STANDING_GRANT_KINDS).toEqual(['open_tab', 'close_tab', 'start_agent', 'board', 'terminal']);
  });

  it('parses a standing grant view, with a gone project and no source; refuses an unknown kind', () => {
    expect(chatStandingGrantSchema.parse(standing)).toEqual(standing);
    expect(chatStandingGrantSchema.safeParse({ ...standing, project_name: null, source_action_id: null }).success).toBe(true);
    expect(chatStandingGrantSchema.safeParse({ ...standing, kind: 'delete_task' }).success).toBe(false);
  });

  it('events standing_grant and standing_grant_revoked parse', () => {
    for (const e of [{ type: 'standing_grant', ...base, grant: standing }, { type: 'standing_grant_revoked', ...base, grant_id: 'sg1' }]) {
      const r = chatEventSchema.safeParse(e);
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    }
    expect(chatEventSchema.safeParse({ type: 'standing_grant_revoked', ...base }).success).toBe(false);
  });

  it('a standing list row parses: no expiry, no tab, a kind, and a conversation that may be gone', () => {
    const r = chatGrantListItemSchema.safeParse(listRow);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(r.data).toMatchObject({ kind: 'standing', expires_at: null, standing_kind: 'close_tab', conversation_id: null });
    expect(chatGrantListItemSchema.parse({ ...listRow, state: 'revoked', ended_at: '2026-09-28T11:00:00.000Z', conversation_id: 'c1' }).state).toBe('revoked');
    expect(chatGrantListItemSchema.safeParse({ ...listRow, standing_kind: 'delete_task' }).success).toBe(false);
  });

  it('an old-shape tab row still parses: kind defaults to tab and standing_kind to null', () => {
    const tabRow = { ...grant, project_id: 'p1', project_name: 'App', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false, state: 'active', ended_at: null };
    expect(chatGrantListItemSchema.parse(tabRow)).toMatchObject({ kind: 'tab', standing_kind: null, scope: null });
  });

  it('the list query takes kinds=all_standing', () => {
    expect(chatGrantListQuery.parse({ state: 'ended', kinds: 'all_standing' }).kinds).toBe('all_standing');
    expect(chatGrantListQuery.safeParse({ state: 'ended', kinds: 'standing' }).success).toBe(false);
  });
});

it('a suggestion may carry the message it answers; an app and a server that predate it both still parse (spec 2026-09-26 §6.3)', () => {
  const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-26T12:00:00.000Z', answered_at: null, closed_at: null };
  expect(tabSuggestionSchema.parse({ ...s, payload: { text: 'commit it', context: 'Quer que eu faça o commit?' } }).payload.context).toBe('Quer que eu faça o commit?');
  expect(tabSuggestionSchema.safeParse({ ...s, payload: { text: 'commit it', context: null } }).success).toBe(true);
  expect(tabSuggestionSchema.parse(s).payload.context).toBeUndefined(); // a server before TER-96
  // The schema an app before TER-96 shipped: a plain z.object strips the new field instead of refusing it.
  const before = tabSuggestionSchema.extend({ payload: z.object({ text: z.string() }) });
  expect(before.parse({ ...s, payload: { text: 'commit it', context: 'x' } }).payload).toEqual({ text: 'commit it' });
});

it('parses attachment_status, and a message that carries attachments', () => {
  const attachment = { id: 'at1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 1234, status: 'ready', error_code: null, meta: { pages: 12 }, created_at: '2026-09-26T12:00:00.000Z' };
  expect(chatEventSchema.safeParse({ type: 'attachment_status', ...base, attachment }).success).toBe(true);
  const message = { id: 'm1', conversation_id: 'c1', role: 'user', text: '', usage: null, error_code: null, created_at: '2026-09-26T12:00:00.000Z', attachments: [attachment] };
  expect(chatEventSchema.safeParse({ type: 'message', ...base, message }).success).toBe(true);
  expect(chatEventSchema.safeParse({ type: 'attachment_status', ...base, attachment: { ...attachment, kind: 'exe' } }).success).toBe(false);
});

// The subagents panel (spec 2026-09-26 panel §4): a row per subagent, and the failed-cancel notice.
describe('chatEventSchema: subagents', () => {
  const subagent = { id: 'sub1', description: 'Buscar CI', subagent_type: null, status: 'running', started_at: '2026-09-26T12:00:00.000Z', ended_at: null };
  it.each([
    ['subagent', { type: 'subagent', ...base, subagent }],
    ['subagent (ended)', { type: 'subagent', ...base, subagent: { ...subagent, subagent_type: 'general-purpose', status: 'interrupted', ended_at: '2026-09-26T12:04:00.000Z' } }],
    ['subagent_cancel_failed', { type: 'subagent_cancel_failed', ...base, subagent_id: 'sub1' }],
  ])('accepts %s', (_t, e) => {
    const r = chatEventSchema.safeParse(e);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('refuses a status the server never sends', () => {
    expect(subagentViewSchema.safeParse({ ...subagent, status: 'paused' }).success).toBe(false);
  });
  it('requires the subagent id on a failed cancel', () => {
    expect(chatEventSchema.safeParse({ type: 'subagent_cancel_failed', ...base }).success).toBe(false);
  });
});

describe('chatMessage notice (TER-588)', () => {
  const row = { id: 'm1', conversation_id: 'c1', role: 'assistant', text: '', usage: null, error_code: 'USAGE_LIMIT', created_at: '2026-09-30T06:00:00.000Z' };
  it('reads the usage limit and the account swap, and a message without one', () => {
    const limit = { kind: 'usage_limit', account: null, resets_at: '2026-09-30T06:20:00.000Z', fallback: 'none_free' };
    expect(chatMessage.parse({ ...row, notice: limit }).notice).toEqual(limit);
    const swap = { kind: 'account_swap', from: 'Pessoal', to: 'Trabalho', resets_at: null };
    expect(chatMessage.parse({ ...row, notice: swap }).notice).toEqual(swap);
    expect(chatMessage.parse(row).notice).toBeUndefined();
  });
  it('drops a notice it does not know instead of failing the message', () => {
    const parsed = chatMessage.safeParse({ ...row, notice: { kind: 'something_new' } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.notice).toBeUndefined();
  });
});

it('a message may carry what it answers, with a null id once the original is gone (TER-447)', () => {
  const m = { id: 'm2', conversation_id: 'c1', role: 'user', text: 'faz de novo', usage: null, error_code: null, created_at: '2026-09-30T12:00:00.000Z' };
  expect(chatMessage.parse({ ...m, reply_to: { id: 'm1', role: 'assistant', excerpt: 'Abri a aba' } }).reply_to).toEqual({ id: 'm1', role: 'assistant', excerpt: 'Abri a aba' });
  expect(chatMessage.parse({ ...m, reply_to: { id: null, role: 'user', excerpt: 'oi' } }).reply_to?.id).toBeNull();
  expect(chatMessage.parse(m).reply_to).toBeUndefined();
  // A reply to a card (TER-849); a card kind a newer server adds is dropped, the quote stays.
  expect(chatMessage.parse({ ...m, reply_to: { id: null, role: 'assistant', excerpt: 'Abrir aba', card: { kind: 'action', id: 'a1' } } }).reply_to?.card).toEqual({ kind: 'action', id: 'a1' });
  expect(chatMessage.parse({ ...m, reply_to: { id: null, role: 'assistant', excerpt: 'x', card: { kind: 'later', id: 'z' } } }).reply_to).toEqual({ id: null, role: 'assistant', excerpt: 'x' });
});

// Pending cards at hand (spec 2026-09-30, TER-477): `surfaced_at` brings a card to the end of the
// thread, `error_code` says why a confirmation went stale, and `action_status` moves a card live. All
// optional + nullable, and a new event type rather than a new enum value, so an installed app keeps parsing.
describe('pending cards at hand (TER-477)', () => {
  const q = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: '2026-09-30T12:00:00.000Z', answered_at: null, closed_at: null, kind: 'permission', payload: { tool_name: 'Bash' }, answer: null };
  const s = { id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '2026-09-30T12:00:00.000Z', answered_at: null, closed_at: null };
  const confirmation = { type: 'confirmation', ...base, action_id: 'a1', tool: 'run_command', args: { command: 'ls' }, class: 'write', machine_id: null, project_id: null, tab_id: null, summary: 'Rodar ls', created_at: '2026-09-30T12:00:00.000Z' };

  it('an action of an older server (no error_code, no surfaced_at) still parses', () => {
    const r = chatActionSchema.parse(card);
    expect(r.error_code).toBeUndefined();
    expect(r.surfaced_at).toBeUndefined();
  });
  it('an action carries error_code and surfaced_at', () => {
    const r = chatActionSchema.parse({ ...card, status: 'failed', error_code: 'TAB_GONE', surfaced_at: '2026-09-30T13:00:00.000Z' });
    expect(r).toMatchObject({ error_code: 'TAB_GONE', surfaced_at: '2026-09-30T13:00:00.000Z' });
    expect(chatActionSchema.safeParse({ ...card, error_code: null, surfaced_at: null }).success).toBe(true);
  });
  it('a tab question and a suggestion carry surfaced_at, or none (an older server)', () => {
    expect(tabQuestionSchema.parse({ ...q, surfaced_at: '2026-09-30T13:00:00.000Z' }).surfaced_at).toBe('2026-09-30T13:00:00.000Z');
    expect(tabQuestionSchema.safeParse({ ...q, surfaced_at: null }).success).toBe(true);
    expect(tabQuestionSchema.safeParse(q).success).toBe(true);
    expect(tabSuggestionSchema.parse({ ...s, surfaced_at: '2026-09-30T13:00:00.000Z' }).surfaced_at).toBe('2026-09-30T13:00:00.000Z');
    expect(tabSuggestionSchema.safeParse(s).success).toBe(true);
  });
  it('a resurfaced confirmation and tab_question parse with surfaced_at and resurfaced', () => {
    const c = chatEventSchema.parse({ ...confirmation, surfaced_at: '2026-09-30T13:00:00.000Z', resurfaced: true });
    expect(c.type === 'confirmation' && [c.surfaced_at, c.resurfaced]).toEqual(['2026-09-30T13:00:00.000Z', true]);
    expect(chatEventSchema.safeParse({ ...confirmation, surfaced_at: null }).success).toBe(true);
    const t = chatEventSchema.parse({ type: 'tab_question', ...base, question: { ...q, surfaced_at: '2026-09-30T13:00:00.000Z' }, resurfaced: true });
    expect(t.type === 'tab_question' && t.resurfaced).toBe(true);
  });
  it('parses action_status, with or without an error code', () => {
    const r = chatEventSchema.parse({ type: 'action_status', ...base, action_id: 'a1', status: 'failed', error_code: 'TAB_GONE' });
    expect(r).toMatchObject({ type: 'action_status', action_id: 'a1', status: 'failed', error_code: 'TAB_GONE' });
    for (const status of ['executed', 'expired'] as const) {
      expect(chatEventSchema.safeParse({ type: 'action_status', ...base, action_id: 'a1', status, error_code: null }).success).toBe(true);
    }
    expect(chatEventSchema.safeParse({ type: 'action_status', ...base, action_id: 'a1', status: 'pending', error_code: null }).success).toBe(false);
  });
});

describe('tab limit events (TER-589)', () => {
  const notice = {
    id: 'n1', tab_id: 't1', tab_name: 'api', status: 'open', result: null, created_at: '2026-09-30T02:30:00.000Z', closed_at: null,
    payload: { account: { id: 'a1', label: 'pessoal' }, machine: { id: 'm1', name: 'mac' }, resets_at: '2026-09-30T03:20:00.000Z', candidates: [{ id: 'a2', label: 'trabalho' }] },
  };
  it('parses the card events, and the card never passes as a tab question', () => {
    expect(chatEventSchema.safeParse({ type: 'tab_limit', user_id: 'u', conversation_id: 'c', notice }).success).toBe(true);
    expect(chatEventSchema.safeParse({ type: 'tab_limit_closed', user_id: 'u', conversation_id: 'c', notice: { ...notice, status: 'swapped', result: 'a2' } }).success).toBe(true);
    expect(tabQuestionSchema.safeParse({ ...notice, kind: 'usage_limit', answer: null, error_code: null, answered_at: null }).success).toBe(false);
  });
});

// "Decisão automática" (TER-641): optional + nullable on an action and on a tab question, so an older
// server (absent) and an older app (stripped by a plain z.object) keep working.
describe('auto_decision (TER-641)', () => {
  const q = { id: 'q1', tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: '2026-10-01T12:00:00.000Z', answered_at: null, closed_at: null, kind: 'permission', payload: { tool_name: 'Bash' }, answer: null };
  const auto = { reason: 'Mesma pergunta de ontem', sources: [{ ref: 'decision:d1', question: 'Rodo os testes?', answer: 'Sim' }, { ref: 'note:n1', question: null, answer: null }] };

  it('an action carries auto_decision, null, or none (an older server)', () => {
    expect(chatActionSchema.parse({ ...card, auto_decision: auto }).auto_decision).toEqual(auto);
    expect(chatActionSchema.parse({ ...card, auto_decision: null }).auto_decision).toBeNull();
    expect(chatActionSchema.parse(card).auto_decision).toBeUndefined();
  });
  it('a tab question carries auto_decision, with a null reason too', () => {
    expect(tabQuestionSchema.parse({ ...q, auto_decision: { ...auto, reason: null } }).auto_decision?.reason).toBeNull();
    expect(tabQuestionSchema.parse(q).auto_decision).toBeUndefined();
  });
});
