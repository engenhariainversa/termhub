import { expect, it } from 'vitest';
import type { TabQuestionView } from '../db/repositories/tab-questions-view.js';
import { tabQuestionContext } from './tab-question-context.js';

const base = { tab_id: 't1', tab_name: 'api', status: 'answered' as const, error_code: null, created_at: '', answered_at: '', closed_at: null };
const colors = { question: 'Qual cor?', header: 'Cor', multi_select: false, options: [{ label: 'Azul', description: '', recommended: true }, { label: 'Verde', description: '', recommended: false }] };
const fruits = { question: 'Quais frutas?', header: 'Frutas', multi_select: true, options: ['Maçã', 'Banana', 'Manga'].map((label) => ({ label, description: '', recommended: false })) };

it('says what each tab asked and what the person answered, one line per question', () => {
  const questions: TabQuestionView[] = [
    { ...base, id: 'q1', kind: 'choice', payload: { questions: [colors, fruits] }, answer: { answers: [{ selected: [1] }, { selected: [0, 2] }] } },
    { ...base, id: 'q2', tab_name: null, tab_id: 't9', kind: 'choice', payload: { questions: [colors] }, answer: { answers: [{ selected: [], text: 'Roxo' }] } },
    { ...base, id: 'q3', kind: 'permission', payload: { tool_name: 'Bash' }, answer: { allow: true } },
    { ...base, id: 'q4', kind: 'permission', payload: { tool_name: 'Edit' }, answer: { allow: false, text: 'use pnpm' } },
    { ...base, id: 'q5', kind: 'permission', payload: { tool_name: 'Write' }, answer: { allow: false } },
  ];
  expect(tabQuestionContext(questions)).toBe(
    [
      'Enquanto isso:',
      '- a aba «api» perguntou «Qual cor?»; o usuário respondeu «Verde».',
      '- a aba «api» perguntou «Quais frutas?»; o usuário respondeu «Maçã, Manga».',
      '- a aba «t9» perguntou «Qual cor?»; o usuário respondeu «Roxo».',
      '- a aba «api» pediu permissão para usar «Bash»; o usuário permitiu.',
      '- a aba «api» pediu permissão para usar «Edit»; o usuário negou e disse «use pnpm».',
      '- a aba «api» pediu permissão para usar «Write»; o usuário negou.',
    ].join('\n'),
  );
});

it('is null with nothing to say', () => {
  expect(tabQuestionContext([])).toBeNull();
});
