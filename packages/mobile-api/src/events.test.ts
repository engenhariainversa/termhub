import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatEventSchema, chatGrantListQuery, chatGrantListResponse, tabQuestionSchema, tabSuggestionSchema } from './events.js';

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
  it('keeps grant_id on the card', () => {
    const r = chatEventSchema.parse({ type: 'granted_action', ...base, action: card });
    expect(r.type === 'granted_action' && r.action.grant_id).toBe('g1');
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
    expect(chatGrantListQuery.parse({ state: 'ended' })).toEqual({ state: 'ended', limit: 50 });
    expect(chatGrantListQuery.parse({ state: 'active', limit: '10', cursor: 'abc' })).toEqual({ state: 'active', limit: 10, cursor: 'abc' });
    for (const bad of [{}, { state: 'all' }, { state: 'ended', limit: '0' }, { state: 'ended', limit: '101' }, { state: 'ended', cursor: '' }]) expect(chatGrantListQuery.safeParse(bad).success).toBe(false);
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
