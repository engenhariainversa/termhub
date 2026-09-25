// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatActionCard } from './ChatActionCard';
import type { ChatAction, ChatGrant } from '../../lib/types';

afterEach(() => cleanup());

const base: ChatAction = { id: 'a1', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'pending', machine_id: null, project_id: null, tab_id: 't1', summary: 'digitar `oi` na aba Terminal 1', created_at: '' };
const grant: ChatGrant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '', expires_at: new Date(Date.now() + 3_600_000).toISOString(), tab_name: 'Terminal 1' };

it('offers "Permitir sempre nesta aba" on a pending send_input to a tab', () => {
  const onDecide = vi.fn();
  render(<ChatActionCard action={base} deciding={false} onDecide={onDecide} />);
  fireEvent.click(screen.getByRole('button', { name: 'Permitir sempre nesta aba' }));
  expect(onDecide).toHaveBeenCalledWith('approve_tab');
});
it.each([
  ['answering a permission', { ...base, args: { tab_id: 't1', text: '1', answering_permission: true } }],
  ['run_command', { ...base, tool: 'run_command', args: { tab_id: 't1', command: 'ls' } }],
  ['no tab', { ...base, tab_id: null, args: { text: 'oi' } }],
])('does not offer it for %s', (_l, action) => {
  render(<ChatActionCard action={action as ChatAction} deciding={false} onDecide={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
});
it('the card that granted shows until when and revokes', () => {
  const onRevoke = vi.fn();
  render(<ChatActionCard action={{ ...base, status: 'executed' }} deciding={false} onDecide={vi.fn()} grant={grant} onRevoke={onRevoke} />);
  expect(screen.getByText(/^Permitido nesta aba até/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
  expect(onRevoke).toHaveBeenCalled();
});
it('an action run under a grant reads "aba confiada"', () => {
  render(<ChatActionCard action={{ ...base, status: 'executed', grant_id: 'g1' }} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByText('Executado · aba confiada')).toBeInTheDocument();
});
