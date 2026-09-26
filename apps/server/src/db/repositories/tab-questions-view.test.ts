import { expect, it } from 'vitest';
import type { TabQuestion } from './tab-questions.js';
import { toTabQuestionView } from './tab-questions-view.js';

const row = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'permission', payload: { tool_name: 'Bash' }, tool_use_id: null,
  status: 'answered_in_tab', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: '2026-09-26T12:00:00.000Z', injected_at: null, created_at: '2026-09-26T11:59:00.000Z', ...over,
});

it('never puts the permission queue mark on the wire; a failure code still travels (spec 2026-09-26 §4.2)', () => {
  expect(toTabQuestionView(row({ error_code: 'QUEUED' }), 'api').error_code).toBeNull();
  expect(toTabQuestionView(row({ status: 'failed', error_code: 'MACHINE_OFFLINE' }), 'api').error_code).toBe('MACHINE_OFFLINE');
});

it('a suggestion always carries context on the wire: null for a row stored before TER-96', () => {
  const s = row({ kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', closed_at: null });
  expect(toTabQuestionView(s, 'api').payload).toEqual({ text: 'commit it', context: null });
  expect(toTabQuestionView({ ...s, payload: { text: 'commit it', context: 'Quer que eu faça o commit?' } }, 'api').payload).toEqual({ text: 'commit it', context: 'Quer que eu faça o commit?' });
  expect(toTabQuestionView(row(), 'api').payload).toEqual({ tool_name: 'Bash' }); // questions untouched
});

it("never puts the subagent flag on the wire: a subagent's card has the same payload shape (spec 2026-09-26 §4.5)", () => {
  const p = row({ payload: { tool_name: 'Bash', subagent: true } as never, status: 'open', closed_at: null });
  expect(toTabQuestionView(p, 'api').payload).toEqual({ tool_name: 'Bash' });
  const payload = { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [] }] };
  expect(toTabQuestionView(row({ kind: 'choice', payload: { ...payload, subagent: true } as never }), 'api').payload).toEqual(payload);
});
