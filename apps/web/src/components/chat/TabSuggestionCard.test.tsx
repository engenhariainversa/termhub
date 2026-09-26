// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TabSuggestionCard } from './TabSuggestionCard';
import type { TabSuggestion } from '../../lib/types';

afterEach(() => cleanup());

const open = (over: Partial<TabSuggestion> = {}): TabSuggestion => ({ id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null, ...over });

it('"«api» sugere:" with the text editable; Enviar sends it as edited, Dispensar dismisses', () => {
  const onSend = vi.fn();
  const onDismiss = vi.fn();
  render(<TabSuggestionCard suggestion={open()} busy={false} onSend={onSend} onDismiss={onDismiss} />);
  expect(screen.getByText('«api» está esperando sua resposta')).toBeInTheDocument();
  const field = screen.getByLabelText('Sugestão do Claude Code (opcional — edite ou dispense)');
  expect(field).toHaveValue('commit it');
  fireEvent.change(field, { target: { value: '  commit it and push ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  expect(onSend).toHaveBeenCalledWith('commit it and push');
  fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
  expect(onDismiss).toHaveBeenCalled();
});

it('Enviar is disabled while sending or with an empty field', () => {
  const { rerender } = render(<TabSuggestionCard suggestion={open()} busy={true} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Dispensar' })).toBeDisabled();
  rerender(<TabSuggestionCard suggestion={open()} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Sugestão do Claude Code (opcional — edite ou dispense)'), { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
});

it('a card with no tab name says "Uma aba está esperando sua resposta"', () => {
  render(<TabSuggestionCard suggestion={open({ tab_name: null })} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('Uma aba está esperando sua resposta')).toBeInTheDocument();
});

it.each([
  [open({ status: 'answered', answer: { text: 'commit it and push' } }), 'commit it and push', 'Enviada'],
  [open({ status: 'dismissed' }), 'commit it', 'Dispensada'],
  [open({ status: 'answered_in_tab' }), 'commit it', 'Respondida na aba'],
  [open({ status: 'expired' }), 'commit it', 'Expirada'],
  [open({ status: 'failed', error_code: 'MACHINE_OFFLINE', answer: { text: 'commit it' } }), 'commit it', 'Falhou — a máquina está offline'],
])('a closed card is read-only and says how it ended (%#)', (s, text, label) => {
  render(<TabSuggestionCard suggestion={s} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
  expect(screen.queryByLabelText('Sugestão do Claude Code (opcional — edite ou dispense)')).toBeNull();
});

it('shows the error it is given', () => {
  render(<TabSuggestionCard suggestion={open()} busy={false} error="A sugestão mudou na aba" onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('A sugestão mudou na aba')).toBeInTheDocument();
});

const CONTEXT = `Criei o arquivo notes.txt.\n\n${'Detalhe. '.repeat(10).trim()}\n\nQuer que eu faça o commit?`;

it('shows the message it answers: the last paragraph, the whole message on demand (spec 2026-09-26 §6.4)', () => {
  render(<TabSuggestionCard suggestion={open({ payload: { text: 'C, pode seguir', context: CONTEXT } })} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('Quer que eu faça o commit?')).toBeInTheDocument();
  expect(screen.queryByText(/Criei o arquivo/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ver mensagem inteira' }));
  expect(screen.getByText(/Criei o arquivo notes\.txt\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Recolher' }));
  expect(screen.queryByText(/Criei o arquivo/)).toBeNull();
});

it('a one-paragraph message has nothing to expand; no message, no quote', () => {
  const { rerender, container } = render(<TabSuggestionCard suggestion={open({ payload: { text: 'commit it', context: 'Quer que eu faça o commit?' } })} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('Quer que eu faça o commit?')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Ver mensagem inteira' })).toBeNull();
  rerender(<TabSuggestionCard suggestion={open({ payload: { text: 'commit it', context: null } })} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(container.querySelector('blockquote')).toBeNull();
});

it('a closed card keeps the message, collapsed, under its old title', () => {
  render(<TabSuggestionCard suggestion={open({ status: 'answered', answer: { text: 'C, pode seguir' }, payload: { text: 'C, pode seguir', context: CONTEXT } })} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('«api» sugere:')).toBeInTheDocument();
  expect(screen.getByText('Quer que eu faça o commit?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Ver mensagem inteira' })).toBeInTheDocument();
});
