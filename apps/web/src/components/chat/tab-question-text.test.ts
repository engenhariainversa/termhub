import { describe, expect, it } from 'vitest';
import type { TabQuestion } from '../../lib/types';
import {
  answerSummary,
  choiceTitle,
  permissionTitle,
  autoAnswerFailureText,
  autoAnswerSeconds,
  choiceAnswerDescription,
  choiceAnswerLabel,
  formatCountdown,
  statusLabel,
  suggestionLine,
  suggestionSourceSentence,
  tabLabel,
  upsertTabQuestion,
} from './tab-question-text';

const base = { id: 'q1', tab_id: 't1', tab_name: 'api', error_code: null, created_at: '', answered_at: null, closed_at: null };
const choice = (over: Partial<TabQuestion> = {}) =>
  ({ ...base, kind: 'choice', status: 'open', answer: null, payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] }, { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: [{ label: 'Maçã', description: '', recommended: false }, { label: 'Manga', description: '', recommended: false }] }] }, ...over }) as TabQuestion;
const permission = (over: Partial<TabQuestion> = {}) => ({ ...base, kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

it('names the tab, or says it is gone', () => {
  expect(tabLabel(choice())).toBe('A aba «api»');
  expect(tabLabel(choice({ tab_name: null }))).toBe('Uma aba');
});
it('states in pt-BR', () => {
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
it('names the suggestion\'s source (an option, or free text) in pt-BR', () => {
  const item = choice().payload.questions[0]!;
  expect(
    suggestionLine(item, { question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [1], source: { question: 'Qual cor prefere?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }),
  ).toBe('Sugestão da memória: você respondeu «Verde» a «Qual cor prefere?» em termhub, 20/09/2026');
  expect(
    suggestionLine(item, { question_index: 0, decision_id: 'd2', similarity: 0.9, selected: [], text: 'Roxo', source: { question: 'Qual cor prefere?', project_name: null, answered_at: '2026-09-20T10:00:00.000Z' } }),
  ).toBe('Sugestão da memória: você respondeu «Roxo» a «Qual cor prefere?» em sem projeto, 20/09/2026');
});

it('a concierge suggestion names its own reason instead of the past-decision sentence', () => {
  const item = choice().payload.questions[0]!;
  expect(
    suggestionLine(item, { question_index: 0, decision_id: '', similarity: 0, selected: [1], by: 'concierge', reason: 'Você prefere Verde em specs de UI', sources: ['doc:i1'], source: { question: 'Qual cor prefere?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }),
  ).toBe('Sugestão do concierge: «Verde». Motivo: Você prefere Verde em specs de UI');
});

it('formats a countdown as m:ss, never negative', () => {
  expect(formatCountdown(0)).toBe('0:00');
  expect(formatCountdown(59)).toBe('0:59');
  expect(formatCountdown(60)).toBe('1:00');
  expect(formatCountdown(61)).toBe('1:01');
  expect(formatCountdown(-5)).toBe('0:00');
  expect(formatCountdown(41.4)).toBe('0:41');
});

it('computes the whole seconds left until due_at, ceiled and never negative', () => {
  const now = Date.parse('2026-09-27T10:00:00.000Z');
  expect(autoAnswerSeconds('2026-09-27T10:00:42.000Z', now)).toBe(42);
  expect(autoAnswerSeconds('2026-09-27T10:00:00.400Z', now)).toBe(1);
  expect(autoAnswerSeconds('2026-09-27T10:00:00.000Z', now)).toBe(0);
  expect(autoAnswerSeconds('2026-09-27T09:59:00.000Z', now)).toBe(0); // already due: never negative
});

it('names why an automatic answer failed, one sentence per code, in pt-BR', () => {
  expect(autoAnswerFailureText('TAB_PROMPT_CHANGED')).toBe('Não consegui responder sozinho: a pergunta mudou na aba.');
  expect(autoAnswerFailureText('AUTODECIDE_OFF')).toBe('Resposta automática cancelada: você desligou «Responder sozinho».');
  expect(autoAnswerFailureText('PRECEDENT_FORGOTTEN')).toBe('Resposta automática cancelada: o precedente foi esquecido.');
  expect(autoAnswerFailureText('PRECEDENT_EXPIRED')).toBe('Resposta automática cancelada: o precedente expirou.');
  expect(autoAnswerFailureText('SOME_OTHER_CODE')).toBe('Não consegui responder sozinho.');
  expect(autoAnswerFailureText(undefined)).toBe('Não consegui responder sozinho.');
  expect(autoAnswerFailureText(null)).toBe('Não consegui responder sozinho.');
});

it('builds the past-decision sentence a countdown\'s "Fonte:" reuses', () => {
  const item = choice().payload.questions[0]!;
  expect(
    suggestionSourceSentence(item, { question_index: 0, decision_id: 'd1', similarity: 0.9, selected: [1], source: { question: 'Qual cor prefere?', project_name: 'termhub', answered_at: '2026-09-20T10:00:00.000Z' } }),
  ).toBe('você respondeu «Verde» a «Qual cor prefere?» em termhub, 20/09/2026');
});

it('reads what a ChoiceAnswer would say, one value per question, joined', () => {
  const { payload } = choice();
  expect(choiceAnswerLabel(payload, { answers: [{ selected: [1] }, { selected: [0, 1] }] })).toBe('Verde / Maçã, Manga');
  expect(choiceAnswerLabel(payload, { answers: [{ selected: [], text: 'Roxo' }] })).toBe('Roxo');
});

it('reads the chosen options\' descriptions for the countdown line, each cut at 80 characters', () => {
  const opt = (label: string, description: string) => ({ label, description, recommended: false });
  const payload = {
    questions: [
      { question: 'Como seguir?', header: 'Passo', multi_select: false, options: [opt('Opção 1', 'faz merge e push para main'), opt('Opção 2', '')] },
      { question: 'E depois?', header: 'Depois', multi_select: true, options: [opt('A', 'x'.repeat(90)), opt('B', 'b')] },
    ],
  };
  expect(choiceAnswerDescription(payload, { answers: [{ selected: [0] }] })).toBe('faz merge e push para main');
  expect(choiceAnswerDescription(payload, { answers: [{ selected: [1] }] })).toBeNull();
  expect(choiceAnswerDescription(payload, { answers: [{ selected: [], text: 'livre' }] })).toBeNull();
  expect(choiceAnswerDescription(payload, { answers: [{ selected: [0] }, { selected: [0, 1] }] })).toBe(`faz merge e push para main / ${'x'.repeat(80)}… / b`);
});

it('upserts by id, appending a new one', () => {
  const list = [choice()];
  expect(upsertTabQuestion(list, choice({ status: 'answered' }))).toEqual([choice({ status: 'answered' })]);
  expect(upsertTabQuestion(list, permission({ id: 'q2' }))).toHaveLength(2);
});

describe('Codex titles', () => {
  const q = (kind: 'choice' | 'permission', agent?: 'codex') => ({ id: 'q', tab_id: 't', tab_name: 'api', kind, status: 'open', answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null, payload: kind === 'choice' ? { questions: [], agent } : { tool_name: 'Bash', agent } }) as TabQuestion;
  it('names the Codex on a choice and a permission card, and only then', () => {
    expect(choiceTitle(q('choice', 'codex'))).toBe('A aba «api» perguntou (o Codex)');
    expect(choiceTitle(q('choice'))).toBe('A aba «api» perguntou');
    expect(permissionTitle(q('permission', 'codex'))).toBe('A aba «api» pede permissão (o Codex)');
    expect(permissionTitle({ ...q('permission', 'codex'), tab_name: null } as TabQuestion)).toBe('Uma aba pede permissão (o Codex)');
    expect(permissionTitle(q('permission'))).toBe('A aba «api» pede permissão para usar «Bash»');
  });
});
