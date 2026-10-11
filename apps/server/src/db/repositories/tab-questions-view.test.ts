import { expect, it, vi } from 'vitest';
import type { TabQuestion } from './tab-questions.js';
import { describeTabQuestions, toTabQuestionView } from './tab-questions-view.js';

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

it('a Codex reply card carries agent on the wire; a Claude suggestion has no agent key', () => {
  const codex = row({ kind: 'suggestion', payload: { text: '', context: 'Rodo os testes?', agent: 'codex' }, status: 'open', closed_at: null });
  expect(toTabQuestionView(codex, 'api').payload).toEqual({ text: '', context: 'Rodo os testes?', agent: 'codex' });
  const claude = toTabQuestionView(row({ kind: 'suggestion', payload: { text: 'commit it', context: 'Quer?' }, status: 'open', closed_at: null }), 'api').payload;
  expect(claude).not.toHaveProperty('agent');
});

it('carries the countdown while the card is open, and afterwards only once sent or failed (spec 2026-09-26 concierge memory §6)', () => {
  const auto = { answer: { answers: [{ selected: [0] }] }, by: 'memory' as const, reason: 'r', sources: [{ kind: 'decision' as const, id: 'd1' }], due_at: '2026-09-26T12:01:00.000Z' };
  const open = row({ kind: 'choice', payload: { questions: [] }, status: 'open', closed_at: null });
  for (const status of ['scheduled', 'cancelled', 'sent', 'failed'] as const) {
    expect(toTabQuestionView({ ...open, auto_answer: { ...auto, status } }, 'api').auto_answer).toEqual({ ...auto, status });
  }
  const answered = { ...open, status: 'answered' as const };
  expect(toTabQuestionView({ ...answered, auto_answer: { ...auto, status: 'sent' }, answered_via: 'auto' }, 'api')).toMatchObject({ auto_answer: { status: 'sent' }, answered_via: 'auto' });
  expect(toTabQuestionView({ ...answered, auto_answer: { ...auto, status: 'failed', error_code: 'TAB_PROMPT_CHANGED' } }, 'api').auto_answer?.status).toBe('failed');
  expect(toTabQuestionView({ ...answered, auto_answer: { ...auto, status: 'cancelled' }, answered_via: 'card' }, 'api')).toMatchObject({ auto_answer: null, answered_via: 'card' });
  expect(toTabQuestionView(row(), 'api')).toMatchObject({ auto_answer: null, answered_via: null });
  // an automatic allow (agentic board §9.2) is stored as 'automation' but goes out as null: the apps' enum is card | auto
  expect(toTabQuestionView({ ...answered, answered_via: 'automation' }, 'api')).toMatchObject({ answered_via: null });
});

it('carries surfaced_at, null until the card is brought back (TER-477)', () => {
  expect(toTabQuestionView(row(), 'api').surfaced_at).toBeNull();
  expect(toTabQuestionView(row({ surfaced_at: '2026-09-30T06:00:00.000Z' }), 'api').surfaced_at).toBe('2026-09-30T06:00:00.000Z');
});

// TER-641: "Decisão automática" on a card the countdown decides or decided by itself.
it('describes the automatic decision while the countdown runs or once it answered; never for a click or a cancel', async () => {
  const auto = { answer: { answers: [{ selected: [0] }] }, by: 'concierge' as const, reason: 'Já decidido', sources: [{ kind: 'decision' as const, id: 'd1' }, { kind: 'note' as const, id: 'n1' }], due_at: '2026-09-26T12:01:00.000Z' };
  const open = row({ kind: 'choice', payload: { questions: [] }, status: 'open', closed_at: null });
  const findManyForUser = vi.fn(async (ids: string[], userId: string) => (userId === 'u1' && ids.includes('d1') ? [{ id: 'd1', question: 'Faço o rebase?', answer: { labels: [], text: 'pode' } }] : []));
  const repos = { tabs: { findByIdsForOwner: vi.fn(async () => [{ id: 't1', name: 'api' }]) }, chatDecisions: { findManyForUser } } as never;
  const views = await describeTabQuestions(
    repos,
    [
      { ...open, auto_answer: { ...auto, status: 'scheduled' } },
      { ...open, status: 'answered', auto_answer: { ...auto, status: 'sent' }, answered_via: 'auto' },
      { ...open, auto_answer: { ...auto, status: 'cancelled' } },
      { ...open, auto_answer: { ...auto, status: 'failed' } },
      { ...open, status: 'answered', answered_via: 'card' },
    ],
    'u1',
  );
  const expected = { reason: 'Já decidido', sources: [{ ref: 'decision:d1', question: 'Faço o rebase?', answer: 'pode' }, { ref: 'note:n1', question: null, answer: null }] };
  expect(views.map((v) => v.auto_decision)).toEqual([expected, expected, null, null, null]);
  expect(findManyForUser).toHaveBeenCalledTimes(1);
});

it('reads no decision when no card has a countdown', async () => {
  const findManyForUser = vi.fn();
  const repos = { tabs: { findByIdsForOwner: vi.fn(async () => []) }, chatDecisions: { findManyForUser } } as never;
  const [view] = await describeTabQuestions(repos, [row()], 'u1');
  expect(view!.auto_decision).toBeNull();
  expect(findManyForUser).not.toHaveBeenCalled();
});
