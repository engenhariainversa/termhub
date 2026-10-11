// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatActionGroup } from './ChatActionGroup';
import type { ChatAction } from '../../lib/types';

afterEach(() => cleanup());

const action = (id: string, over: Partial<ChatAction> = {}): ChatAction => ({ id, tool: 'move_task', args: {}, class: 'write', status: 'pending', machine_id: null, project_id: null, tab_id: null, summary: `mover o card ${id}`, created_at: '2026-09-26T00:00:00.000Z', ...over }) as ChatAction;

it('lists every action, checks writes and leaves irreversible ones unchecked', () => {
  render(<ChatActionGroup actions={[action('a1'), action('a2', { class: 'irreversible', summary: 'apagar o card X' })]} deciding={false} onDecide={vi.fn()} onShowSeparately={vi.fn()} />);
  expect(screen.getByText('2 ações aguardando sua confirmação')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'mover o card a1' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /apagar o card X/ })).not.toBeChecked();
  expect(screen.getByText('irreversível')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Aprovar selecionadas (1)' })).toBeEnabled();
});

it('approves the checked ones and denies the unchecked ones in one call', () => {
  const onDecide = vi.fn();
  render(<ChatActionGroup actions={[action('a1'), action('a2'), action('a3')]} deciding={false} onDecide={onDecide} onShowSeparately={vi.fn()} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'mover o card a2' }));
  expect(screen.getByText('As desmarcadas serão recusadas.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar selecionadas (2)' }));
  expect(onDecide).toHaveBeenCalledWith([{ id: 'a1', decision: 'approve' }, { id: 'a2', decision: 'deny' }, { id: 'a3', decision: 'approve' }]);
});

it('Recusar todas denies every one; nothing checked disables approving; Ver separadas asks for the cards', () => {
  const onDecide = vi.fn();
  const onShowSeparately = vi.fn();
  render(<ChatActionGroup actions={[action('a1', { class: 'irreversible' }), action('a2', { class: 'irreversible' })]} deciding={false} onDecide={onDecide} onShowSeparately={onShowSeparately} />);
  expect(screen.getByRole('button', { name: 'Aprovar selecionadas (0)' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Recusar todas' }));
  expect(onDecide).toHaveBeenCalledWith([{ id: 'a1', decision: 'deny' }, { id: 'a2', decision: 'deny' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Ver separadas' }));
  expect(onShowSeparately).toHaveBeenCalled();
});

it('disables everything while deciding', () => {
  render(<ChatActionGroup actions={[action('a1'), action('a2')]} deciding onDecide={vi.fn()} onShowSeparately={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Recusar todas' })).toBeDisabled();
});

it('names the subagent that proposed an action', () => {
  render(<ChatActionGroup actions={[action('a1', { subagent: { id: 's1', description: 'Buscar CI' } })]} deciding={false} onDecide={vi.fn()} onShowSeparately={vi.fn()} />);
  expect(screen.getByText('Pedido pelo subagente «Buscar CI»')).toBeInTheDocument();
});
it('no origin line without a subagent', () => {
  render(<ChatActionGroup actions={[action('a1')]} deciding={false} onDecide={vi.fn()} onShowSeparately={vi.fn()} />);
  expect(screen.queryByText(/Pedido pelo subagente/)).toBeNull();
});

it('carries every action id, space-separated, for the pending bar to find any of them', () => {
  const { container } = render(<ChatActionGroup actions={[action('a1'), action('a2')]} deciding={false} onDecide={vi.fn()} onShowSeparately={vi.fn()} />);
  expect(container.querySelector('[data-chat-card~="a2"]')).not.toBeNull();
  expect(container.querySelector('[data-chat-card~="a1"]')).toBe(container.querySelector('[data-chat-card~="a2"]'));
});

it('keeps the ticks across a remount, so a retry never turns ticked irreversible cards into refusals (TER-530)', () => {
  const onDecide = vi.fn();
  const actions = [action('r1', { class: 'irreversible', summary: 'fechar a aba 1' }), action('r2', { class: 'irreversible', summary: 'fechar a aba 2' }), action('r3')];
  const first = render(<ChatActionGroup actions={actions} deciding={false} onDecide={vi.fn()} onShowSeparately={vi.fn()} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /fechar a aba 1/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /fechar a aba 2/ }));
  // The request failed (a 429, say) and the group remounted: a new pending card moved its key.
  first.unmount();
  render(<ChatActionGroup actions={[...actions, action('r4')]} deciding={false} onDecide={onDecide} onShowSeparately={vi.fn()} />);
  expect(screen.getByRole('checkbox', { name: /fechar a aba 1/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /fechar a aba 2/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar selecionadas (4)' }));
  expect(onDecide).toHaveBeenCalledWith([
    { id: 'r1', decision: 'approve' },
    { id: 'r2', decision: 'approve' },
    { id: 'r3', decision: 'approve' },
    { id: 'r4', decision: 'approve' },
  ]);
});
