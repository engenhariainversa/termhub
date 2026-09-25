// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatGrantStrip } from './ChatGrantStrip';
import type { ChatGrant } from '../../lib/types';

afterEach(() => cleanup());

const grant: ChatGrant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '', expires_at: new Date(Date.now() + 3_600_000).toISOString(), tab_name: 'Terminal 1' };

it('shows one line per active grant, naming the tab, and revokes it', () => {
  const onRevoke = vi.fn();
  render(<ChatGrantStrip grants={[grant]} revokingId={null} onRevoke={onRevoke} />);
  expect(screen.getByText(/Enviando direto para a aba Terminal 1 até/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
  expect(onRevoke).toHaveBeenCalledWith('g1');
});
it('hides expired grants, and renders nothing without any', () => {
  const { container } = render(<ChatGrantStrip grants={[{ ...grant, expires_at: new Date(Date.now() - 1000).toISOString() }]} revokingId={null} onRevoke={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});
it('names a tab that no longer exists plainly', () => {
  render(<ChatGrantStrip grants={[{ ...grant, tab_name: null }]} revokingId={null} onRevoke={vi.fn()} />);
  expect(screen.getByText(/uma aba que não existe mais/)).toBeInTheDocument();
});
