import type { TabQuestion } from './types';
import { answerSummary, choiceAnswerDescription, choiceTitle, compactQuestionLine, compactQuestionOutcome, compactQuestionSubject, permissionTitle, statusLabel, tabLabel } from './tab-question-text';

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
  expect(statusLabel(choice({ status: 'expired' }))).toBe('Encerrada — a aba foi fechada');
  expect(statusLabel(choice({ status: 'expired', error_code: 'DISMISSED' }))).toBe('Dispensada');
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

it('reads the chosen options\' descriptions for the countdown line, each cut at 80 characters (same as the web)', () => {
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

type ChoiceQ = Extract<TabQuestion, { kind: 'choice' }>;
type PermissionQ = Extract<TabQuestion, { kind: 'permission' }>;
describe('Codex titles', () => {
  const q = (kind: 'choice' | 'permission', agent?: 'codex') => ({ id: 'q', tab_id: 't', tab_name: 'api', kind, status: 'open', answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null, payload: kind === 'choice' ? { questions: [], agent } : { tool_name: 'Bash', agent } }) as TabQuestion;
  it('names the Codex on a choice and a permission card, and only then', () => {
    expect(choiceTitle(q('choice', 'codex') as ChoiceQ)).toBe('A aba «api» perguntou (o Codex)');
    expect(choiceTitle(q('choice') as ChoiceQ)).toBe('A aba «api» perguntou');
    expect(permissionTitle(q('permission', 'codex') as PermissionQ)).toBe('A aba «api» pede permissão (o Codex)');
    expect(permissionTitle({ ...q('permission', 'codex'), tab_name: null } as PermissionQ)).toBe('Uma aba pede permissão (o Codex)');
    expect(permissionTitle(q('permission') as PermissionQ)).toBe('A aba «api» pede permissão para usar «Bash»');
  });
});

describe('compact line of a settled card (TER-1108), the same words as the web', () => {
  it('names the tab, the tool and how a permission ended', () => {
    expect(compactQuestionLine(permission({ status: 'answered_in_tab', tab_name: 'codex · ChatGPT' }))).toBe('«codex · ChatGPT» · Bash · respondida na aba');
    expect(compactQuestionLine(permission({ status: 'answered', answer: { allow: true } }))).toBe('«api» · Bash · permitida');
    expect(compactQuestionLine(permission({ status: 'answered', answer: { allow: false, text: 'não' } }))).toBe('«api» · Bash · negada');
    expect(compactQuestionLine(permission({ status: 'expired' }))).toBe('«api» · Bash · encerrada, a aba foi fechada');
    expect(compactQuestionLine(permission({ status: 'expired', error_code: 'DISMISSED' }))).toBe('«api» · Bash · dispensada');
    expect(compactQuestionLine(permission({ status: 'failed', error_code: 'MACHINE_OFFLINE' }))).toBe('«api» · Bash · falhou');
  });
  it('a choice card shows its first question, cut, and counts the others; a gone tab reads as "Uma aba"', () => {
    expect(compactQuestionLine(choice({ status: 'answered', answer: { answers: [{ selected: [0] }, { selected: [1] }] } }))).toBe('«api» · Qual cor? +1 outra · respondida');
    const long = 'Qual destas opções você prefere para a configuração do ambiente de testes do projeto?';
    expect(compactQuestionSubject(choice({ payload: { questions: [{ question: long, header: '', multi_select: false, options: [] }] } } as Partial<TabQuestion>))).toBe(`${long.slice(0, 60)}…`);
    expect(compactQuestionLine(choice({ status: 'answered_in_tab', tab_name: null }))).toBe('Uma aba · Qual cor? +1 outra · respondida na aba');
  });
  it('an open card has no outcome yet', () => {
    expect(compactQuestionOutcome(permission())).toBe('');
  });
});
