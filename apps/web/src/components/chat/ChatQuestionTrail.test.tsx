// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { TabQuestion } from '../../lib/types';
import { ChatQuestionTrail } from './ChatQuestionTrail';

afterEach(cleanup);

const question = (id: string): TabQuestion =>
  ({ id, tab_id: 't1', tab_name: 'codex · ChatGPT', kind: 'permission', status: 'answered_in_tab', answer: null, payload: { tool_name: 'Bash', agent: 'codex', question: `Posso rodar ${id}?` }, error_code: null, created_at: '2026-10-21T00:00:00.000Z', answered_at: null, closed_at: null }) as TabQuestion;

const renderLine = (q: TabQuestion) => <li key={q.id}>{(q.payload as { question?: string }).question}</li>;

it('starts closed, with a line saying how many and how they ended, and opens to the cards on a click (TER-1108)', () => {
  const questions = Array.from({ length: 4 }, (_, i) => question(`q${i}`));
  render(<ul><ChatQuestionTrail questions={questions} renderQuestion={renderLine} /></ul>);
  const toggle = screen.getByRole('button', { name: /4 permissões do Codex respondidas na aba/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('Posso rodar q0?')).toBeNull();

  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getAllByText(/^Posso rodar q\d\?$/)).toHaveLength(4);

  fireEvent.click(toggle);
  expect(screen.queryByText('Posso rodar q0?')).toBeNull();
});

it('carries every card\'s id, so the pending bar and a reply\'s quote can find one inside (TER-477, TER-849)', () => {
  const { container } = render(<ul><ChatQuestionTrail questions={[question('x1'), question('x2')]} renderQuestion={renderLine} /></ul>);
  expect(container.querySelector('[data-chat-card~="x2"]')).not.toBeNull();
  expect(container.querySelector('[data-chat-trail]')).not.toBeNull();
});

it('stays open across a remount once the person opened it', () => {
  const questions = [question('y1'), question('y2')];
  const { unmount } = render(<ul><ChatQuestionTrail questions={questions} renderQuestion={renderLine} /></ul>);
  fireEvent.click(screen.getByRole('button'));
  unmount();
  render(<ul><ChatQuestionTrail questions={questions} renderQuestion={renderLine} /></ul>);
  expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
});
