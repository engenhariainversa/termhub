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
  expect(screen.getByText('«api» sugere:')).toBeInTheDocument();
  const field = screen.getByLabelText('Texto da sugestão');
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
  fireEvent.change(screen.getByLabelText('Texto da sugestão'), { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
});

it('a card with no tab name says "Uma aba sugere:"', () => {
  render(<TabSuggestionCard suggestion={open({ tab_name: null })} busy={false} onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('Uma aba sugere:')).toBeInTheDocument();
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
  expect(screen.queryByLabelText('Texto da sugestão')).toBeNull();
});

it('shows the error it is given', () => {
  render(<TabSuggestionCard suggestion={open()} busy={false} error="A sugestão mudou na aba" onSend={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText('A sugestão mudou na aba')).toBeInTheDocument();
});
