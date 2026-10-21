// Ported from apps/web/src/lib/chat-question-trail.test.ts: the same words on both.
import type { TabQuestion } from './types';
import { questionTrailSummary } from './question-trail';

const base = { tab_id: 't1', tab_name: 'codex · ChatGPT', error_code: null, created_at: '', answered_at: null, closed_at: null };
const permission = (id: string, over: Partial<TabQuestion> = {}, agent?: 'codex') => ({ ...base, id, kind: 'permission', status: 'answered_in_tab', answer: null, payload: { tool_name: 'Bash', ...(agent ? { agent } : {}) }, ...over }) as TabQuestion;
const choice = (id: string, over: Partial<TabQuestion> = {}, agent?: 'codex') =>
  ({ ...base, id, kind: 'choice', status: 'answered', answer: { answers: [{ selected: [0] }] }, payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: false }] }], ...(agent ? { agent } : {}) }, ...over }) as TabQuestion;

describe('questionTrailSummary (TER-1108)', () => {
  it('counts permissions the Codex asked and how they ended', () => {
    expect(questionTrailSummary([permission('a', {}, 'codex'), permission('b', {}, 'codex'), permission('c', {}, 'codex'), permission('d', {}, 'codex')])).toBe('4 permissões do Codex respondidas na aba');
  });
  it('names nobody when a card is not the Codex\'s, and says "no chat" for cards answered here', () => {
    expect(questionTrailSummary([permission('a', { status: 'answered', answer: { allow: true } }), permission('b', { status: 'answered', answer: { allow: false } }, 'codex')])).toBe('2 permissões respondidas no chat');
  });
  it('reads "perguntas" for choice cards and both when mixed', () => {
    expect(questionTrailSummary([choice('a'), choice('b')])).toBe('2 perguntas respondidas no chat');
    expect(questionTrailSummary([choice('a', { status: 'answered_in_tab' }, 'codex'), permission('b', {}, 'codex')])).toBe('2 perguntas e permissões do Codex respondidas na aba');
  });
  it('says "resolvidas" when they ended differently, and expired/failed when all did', () => {
    expect(questionTrailSummary([permission('a'), permission('b', { status: 'expired' })])).toBe('2 permissões resolvidas');
    expect(questionTrailSummary([permission('a', { status: 'expired' }), permission('b', { status: 'expired' })])).toBe('2 permissões expiradas');
    expect(questionTrailSummary([permission('a', { status: 'failed', error_code: 'MACHINE_OFFLINE' }), permission('b', { status: 'failed' })])).toBe('2 permissões falharam');
  });
});
