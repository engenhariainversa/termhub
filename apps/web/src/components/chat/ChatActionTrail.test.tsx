// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { ChatAction } from '../../lib/types';
import { ChatActionTrail } from './ChatActionTrail';

afterEach(cleanup);

const action = (over: Partial<ChatAction> & { id: string }): ChatAction => ({
  tool: 'close_tab',
  args: {},
  class: 'write',
  status: 'executed',
  machine_id: null,
  project_id: null,
  tab_id: 't1',
  summary: `fechar a aba «${over.id}»`,
  created_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

const renderCard = (a: ChatAction) => <li key={a.id}>{a.summary}</li>;

it('starts closed, with a line saying how many and what, and opens to the cards on a click (TER-1024)', () => {
  const actions = Array.from({ length: 7 }, (_, i) => action({ id: `aba ${i}` }));
  render(<ul><ChatActionTrail actions={actions} renderAction={renderCard} /></ul>);
  const toggle = screen.getByRole('button', { name: /7 ações executadas · fechar aba ×7/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('fechar a aba «aba 0»')).toBeNull();

  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getAllByText(/^fechar a aba «aba \d»$/)).toHaveLength(7);

  fireEvent.click(toggle);
  expect(screen.queryByText('fechar a aba «aba 0»')).toBeNull();
});

it('stays open across a remount once the person opened it', () => {
  const actions = [action({ id: 'x1' }), action({ id: 'x2' })];
  const { unmount } = render(<ul><ChatActionTrail actions={actions} renderAction={renderCard} /></ul>);
  fireEvent.click(screen.getByRole('button'));
  unmount();
  render(<ul><ChatActionTrail actions={actions} renderAction={renderCard} /></ul>);
  expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
});

it('opens by itself when asked to, for cards the person just decided', () => {
  render(<ul><ChatActionTrail actions={[action({ id: 'y1' }), action({ id: 'y2' })]} renderAction={renderCard} initiallyOpen /></ul>);
  expect(screen.getByText('fechar a aba «y1»')).toBeInTheDocument();
});
