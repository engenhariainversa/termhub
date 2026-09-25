import type { TabQuestion } from './types';
import { answerSummary, statusLabel, tabLabel } from './tab-question-text';

const base = { id: 'q1', tab_id: 't1', tab_name: 'api', error_code: null, created_at: '', answered_at: null, closed_at: null };
const choice = (over: Partial<TabQuestion> = {}) =>
  ({ ...base, kind: 'choice', status: 'open', answer: null, payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }, { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: [{ label: 'Maçã', description: '', recommended: false }, { label: 'Manga', description: '', recommended: false }] }] }, ...over }) as TabQuestion;
const permission = (over: Partial<TabQuestion> = {}) => ({ ...base, kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

it('names the tab, or says it is gone', () => {
  expect(tabLabel(choice())).toBe('A aba «api»');
  expect(tabLabel(choice({ tab_name: null }))).toBe('Uma aba');
});
it('states in pt-BR, the same words as the web', () => {
  expect(statusLabel(choice())).toBe('');
  expect(statusLabel(choice({ status: 'answered' }))).toBe('Respondida');
  expect(statusLabel(choice({ status: 'answered_in_tab' }))).toBe('Respondida na aba');
  expect(statusLabel(choice({ status: 'expired' }))).toBe('Expirada');
  expect(statusLabel(choice({ status: 'failed', error_code: 'MACHINE_OFFLINE' }))).toBe('Falhou — a máquina está offline');
  expect(statusLabel(choice({ status: 'failed', error_code: 'WHATEVER' }))).toBe('Falhou — não foi possível digitar na aba');
});
it('summarises what was answered', () => {
  expect(answerSummary(choice({ status: 'answered', answer: { answers: [{ selected: [1] }, { selected: [0, 1] }] } }))).toEqual(['Qual cor? → Verde', 'Quais frutas? → Maçã, Manga']);
  expect(answerSummary(choice({ status: 'answered', answer: { answers: [{ selected: [], text: 'Roxo' }, { selected: [0] }] } }))[0]).toBe('Qual cor? → Roxo');
  expect(answerSummary(choice({ status: 'answered_in_tab' }))).toEqual(['Qual cor?', 'Quais frutas?']);
  expect(answerSummary(permission({ status: 'answered', answer: { allow: true } }))).toEqual(['Permitido']);
  expect(answerSummary(permission({ status: 'answered', answer: { allow: false, text: 'use pnpm' } }))).toEqual(['Negado: «use pnpm»']);
  expect(answerSummary(permission({ status: 'answered', answer: { allow: false } }))).toEqual(['Negado']);
  expect(answerSummary(permission({ status: 'expired' }))).toEqual([]);
});
