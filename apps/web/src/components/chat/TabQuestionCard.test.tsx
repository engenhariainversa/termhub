// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TabQuestionCard } from './TabQuestionCard';
import type { TabQuestion } from '../../lib/types';

afterEach(() => cleanup());

const base = { tab_id: 't1', tab_name: 'api', error_code: null, created_at: '', answered_at: null, closed_at: null };
const colors = { question: 'What is your favorite color?', header: 'Color', multi_select: false, options: [{ label: 'Blue', description: 'Calm and classic.', recommended: true }, { label: 'Green', description: 'Fresh and natural.', recommended: false }, { label: 'Red', description: 'Bold and energetic.', recommended: false }] };
const fruits = { question: 'Which fruits do you like?', header: 'Fruits', multi_select: true, options: [{ label: 'Apple', description: '', recommended: false }, { label: 'Banana', description: '', recommended: false }, { label: 'Mango', description: '', recommended: false }] };
const choice = (over: Partial<TabQuestion> = {}) => ({ ...base, id: 'q1', kind: 'choice', status: 'open', answer: null, payload: { questions: [colors, fruits] }, ...over }) as TabQuestion;
const permission = (over: Partial<TabQuestion> = {}) => ({ ...base, id: 'q2', kind: 'permission', status: 'open', answer: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

it('answers a two-question card: a radio on the first tab, checkboxes on the second', () => {
  const onAnswer = vi.fn();
  render(<TabQuestionCard question={choice()} answering={false} onAnswer={onAnswer} />);
  expect(screen.getByText('A aba «api» perguntou')).toBeInTheDocument();
  expect(screen.getByText('Recomendada')).toBeInTheDocument();
  expect(screen.getByText('Calm and classic.')).toBeInTheDocument();
  const submit = screen.getByRole('button', { name: 'Responder' });
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: /Green/ }));
  fireEvent.click(screen.getByRole('tab', { name: 'Fruits' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Mango/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Apple/ }));
  fireEvent.click(submit);
  expect(onAnswer).toHaveBeenCalledWith({ answers: [{ selected: [1] }, { selected: [0, 2] }] });
});

it('"Outra resposta" answers with text and sets the options aside', () => {
  const onAnswer = vi.fn();
  render(<TabQuestionCard question={choice({ payload: { questions: [colors] } } as Partial<TabQuestion>)} answering={false} onAnswer={onAnswer} />);
  expect(screen.queryByRole('tab')).toBeNull(); // one question: no tab strip
  fireEvent.change(screen.getByLabelText('Outra resposta'), { target: { value: '  Purple ' } });
  expect(screen.getByRole('radio', { name: /Blue/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
  expect(onAnswer).toHaveBeenCalledWith({ answers: [{ selected: [], text: 'Purple' }] });
});

it('a permission card shows the live excerpt and allows, denies, or denies with a sentence', async () => {
  const onAnswer = vi.fn();
  const loadScreen = vi.fn(async () => 'Bash command\n  touch probe-file.txt\nDo you want to proceed?');
  render(<TabQuestionCard question={permission()} answering={false} onAnswer={onAnswer} loadScreen={loadScreen} />);
  expect(screen.getByText('A aba «api» pede permissão para usar «Bash»')).toBeInTheDocument();
  expect(await screen.findByText(/touch probe-file\.txt/)).toBeInTheDocument();
  expect(screen.getByText('Tela da aba')).toBeInTheDocument();
  expect(loadScreen).toHaveBeenCalledWith('q2');
  fireEvent.click(screen.getByRole('button', { name: 'Permitir' }));
  expect(onAnswer).toHaveBeenLastCalledWith({ allow: true });
  fireEvent.click(screen.getByRole('button', { name: 'Negar' }));
  expect(onAnswer).toHaveBeenLastCalledWith({ allow: false });
  fireEvent.click(screen.getByRole('button', { name: 'Negar e dizer…' }));
  fireEvent.change(screen.getByLabelText('O que dizer à aba'), { target: { value: 'use pnpm' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  expect(onAnswer).toHaveBeenLastCalledWith({ allow: false, text: 'use pnpm' });
});

it('disables every answer while one is in flight', () => {
  render(<TabQuestionCard question={permission()} answering onAnswer={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Permitir' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Negar' })).toBeDisabled();
});

it.each([
  [choice({ status: 'answered', answer: { answers: [{ selected: [1] }, { selected: [0] }] } } as Partial<TabQuestion>), ['What is your favorite color? → Green', 'Respondida']],
  [choice({ status: 'answered_in_tab' }), ['Respondida na aba']],
  [permission({ status: 'expired' }), ['Expirada']],
  [permission({ status: 'failed', error_code: 'MACHINE_OFFLINE', answer: { allow: true } } as Partial<TabQuestion>), ['Permitido', 'Falhou — a máquina está offline']],
])('a closed card is read-only and says how it ended (%#)', (q, texts) => {
  render(<TabQuestionCard question={q} answering={false} onAnswer={vi.fn()} loadScreen={vi.fn(async () => 'x')} />);
  for (const t of texts) expect(screen.getByText(t)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Responder|Permitir/ })).toBeNull();
});

it('shows the error it is given', () => {
  render(<TabQuestionCard question={permission()} answering={false} onAnswer={vi.fn()} error="A pergunta mudou na aba" />);
  expect(screen.getByText('A pergunta mudou na aba')).toBeInTheDocument();
});
