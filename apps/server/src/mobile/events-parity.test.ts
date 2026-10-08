import { chatEventSchema, STANDING_GRANT_KINDS as CONTRACT_STANDING_GRANT_KINDS } from '@termhub/mobile-api';
import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../chat/bus.js';
import { STANDING_GRANT_KINDS } from '../db/repositories/chat-standing-grants.js';

// One sample of every `ChatEvent` variant the bus carries, keyed by its type: the `Record` makes the
// type checker refuse this file when a variant is added to the bus and not here, and the test then
// refuses it when the mobile contract (`chatEventSchema`) does not accept it. Together they keep
// what /ws/m/chat forwards and what the app parses from drifting apart.
const base = { user_id: 'u1', conversation_id: 'c1' };
const question = {
  id: 'q1',
  tab_id: 't1',
  tab_name: 'api',
  kind: 'choice' as const,
  payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: 'Calma', recommended: true }, { label: 'Verde', description: '', recommended: false }] }] },
  status: 'open' as const,
  answer: null,
  error_code: null,
  created_at: '2026-09-25T12:00:00.000Z',
  answered_at: null,
  closed_at: null,
  suggestion: null,
  auto_answer: { answer: { answers: [{ selected: [0] }] }, by: 'memory' as const, reason: 'Mesma pergunta respondida antes', sources: [{ kind: 'decision' as const, id: 'd1' }], due_at: '2026-09-25T12:01:00.000Z', status: 'scheduled' as const },
  answered_via: null,
  surfaced_at: '2026-09-25T12:00:30.000Z',
  auto_decision: null,
};
const suggestion = {
  id: 's1',
  tab_id: 't1',
  tab_name: 'api',
  kind: 'suggestion' as const,
  payload: { text: 'commit it', context: 'Quer que eu faça o commit?' },
  status: 'open' as const,
  answer: null,
  error_code: null,
  created_at: '2026-09-25T12:00:00.000Z',
  answered_at: null,
  closed_at: null,
  suggestion: null,
  auto_answer: null,
  answered_via: null,
  surfaced_at: null,
  auto_decision: null,
};
const tabLimit = {
  id: 'tl1',
  tab_id: 't1',
  tab_name: 'api',
  payload: { account: { id: 'ac1', label: 'Trabalho' }, machine: { id: 'mc1', name: 'jarvis' }, resets_at: '2026-09-26T15:00:00.000Z', candidates: [{ id: 'ac2', label: 'Pessoal' }] },
  status: 'open' as const,
  result: null,
  created_at: '2026-09-26T12:00:00.000Z',
  closed_at: null,
};
const samples: { [K in ChatEvent['type']]: Extract<ChatEvent, { type: K }> } = {
  message: {
    type: 'message',
    ...base,
    // A reply (TER-447) whose original was deleted: the optional field and its nullable id both reach the app.
    message: { id: 'm1', conversation_id: 'c1', role: 'user', text: 'oi', usage: null, error_code: null, created_at: '2026-09-24T12:00:00.000Z', reply_to: { id: null, role: 'assistant', excerpt: 'Abri a aba' } },
  },
  delta: { type: 'delta', ...base, message_id: 'm1', delta: 'o' },
  action: { type: 'action', ...base, message_id: 'm1', tool: 'list_tabs', tool_use_id: 't1', args: { machine: 'x' } },
  action_result: { type: 'action_result', ...base, message_id: 'm1', tool_use_id: 't1', ok: true },
  reset: { type: 'reset', ...base, message_id: 'm1' },
  confirmation: {
    type: 'confirmation',
    ...base,
    action_id: 'a1',
    tool: 'run_command',
    args: { command: 'ls' },
    class: 'write',
    machine_id: 'mc1',
    project_id: null,
    tab_id: null,
    summary: 'Rodar ls',
    subagent: { id: 'sub1', description: 'Escrever testes' },
    created_at: '2026-09-24T12:00:00.000Z',
  },
  decision: { type: 'decision', ...base, action_id: 'a1', status: 'approved' },
  action_status: { type: 'action_status', ...base, action_id: 'a1', status: 'failed', error_code: 'TAB_GONE' },
  grant: { type: 'grant', ...base, grant: { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', tab_name: 'api' } },
  grant_revoked: { type: 'grant_revoked', ...base, grant_id: 'g1' },
  project_grant: { type: 'project_grant', ...base, grant: { id: 'pg1', project_id: 'p1', project_name: 'App', scope: 'board', source_action_id: 'a1', created_at: '2026-09-27T10:00:00.000Z', expires_at: '2026-09-28T10:00:00.000Z' } },
  project_grant_revoked: { type: 'project_grant_revoked', ...base, grant_id: 'pg1' },
  standing_grant: { type: 'standing_grant', ...base, grant: { id: 'sg1', project_id: 'p1', project_name: 'App', kind: 'close_tab', source_action_id: 'a1', created_at: '2026-09-28T10:00:00.000Z' } },
  standing_grant_revoked: { type: 'standing_grant_revoked', ...base, grant_id: 'sg1' },
  run_finished: { type: 'run_finished', ...base, message_id: null, ok: false, error_code: 'CHAT_FAILED' },
  run_started: { type: 'run_started', ...base, message_id: 'm1' },
  message_removed: { type: 'message_removed', ...base, message_id: 'm1' },
  granted_action: { type: 'granted_action', ...base, action: { id: 'a2', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'executed', machine_id: null, project_id: null, tab_id: 't1', grant_id: 'g1', summary: 'digitar `oi` na aba api', subagent: null, created_at: '2026-09-25T10:01:00.000Z', error_code: null, surfaced_at: null, auto_decision: { reason: 'Mesma resposta de antes', sources: [{ ref: 'decision:d1', question: 'Qual cor?', answer: 'Azul' }] } } },
  tab_question: { type: 'tab_question', ...base, question },
  tab_question_answered: { type: 'tab_question_answered', ...base, question: { ...question, status: 'answered', answer: { answers: [{ selected: [0] }] }, answered_at: '2026-09-25T12:01:00.000Z', auto_answer: { ...question.auto_answer, status: 'sent' }, answered_via: 'auto' } },
  tab_question_closed: { type: 'tab_question_closed', ...base, question: { ...question, kind: 'permission', payload: { tool_name: 'Bash' }, status: 'answered_in_tab', closed_at: '2026-09-25T12:02:00.000Z', auto_answer: null } },
  tab_suggestion: { type: 'tab_suggestion', ...base, suggestion },
  tab_suggestion_closed: { type: 'tab_suggestion_closed', ...base, suggestion: { ...suggestion, status: 'dismissed', closed_at: '2026-09-25T12:02:00.000Z' } },
  context: { type: 'context', ...base, tokens: 25258, window: 1_000_000 },
  compact: { type: 'compact', ...base, state: 'done', tokens_before: 20693, tokens: 1951, error_code: null },
  attachment_status: {
    type: 'attachment_status',
    ...base,
    attachment: { id: 'at1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 1234, status: 'ready', error_code: null, meta: { pages: 12, truncated: false }, created_at: '2026-09-26T12:00:00.000Z' },
  },
  subagent: {
    type: 'subagent',
    ...base,
    subagent: { id: 'sub1', description: 'Buscar CI', subagent_type: 'general-purpose', status: 'completed', started_at: '2026-09-26T12:00:00.000Z', ended_at: '2026-09-26T12:03:00.000Z' },
  },
  subagent_cancel_failed: { type: 'subagent_cancel_failed', ...base, subagent_id: 'sub1' },
  tab_limit: { type: 'tab_limit', ...base, notice: tabLimit },
  tab_limit_closed: { type: 'tab_limit_closed', ...base, notice: { ...tabLimit, status: 'swapped', result: 'Trocada para Pessoal', closed_at: '2026-09-26T12:05:00.000Z' } },
};

describe('ChatEvent / chatEventSchema parity', () => {
  it.each(Object.entries(samples))('the mobile contract accepts a %s event', (_type, sample) => {
    const r = chatEventSchema.safeParse(sample);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('a confirmation re-published with origin_update still parses (the app ignores the flag)', () => {
    const r = chatEventSchema.safeParse({ ...samples.confirmation, origin_update: true });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('the standing grant kinds are the same list on the server and in the mobile contract', () => {
    expect([...STANDING_GRANT_KINDS]).toEqual([...CONTRACT_STANDING_GRANT_KINDS]);
  });

  it('run_finished also parses with a message id and no error', () => {
    expect(chatEventSchema.safeParse({ type: 'run_finished', ...base, message_id: 'm1', ok: true, error_code: null }).success).toBe(true);
  });
});
