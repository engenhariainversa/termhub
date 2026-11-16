// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatPendingBar } from './ChatPendingBar';
import { chatTimeline } from '../../lib/chat-timeline';
import type { ChatAction, TabQuestion, TabSuggestion } from '../../lib/types';

const T0 = '2026-09-30T00:00:00.000Z';
const at = (m: number) => new Date(Date.parse(T0) + m * 60_000).toISOString();

const action = (id: string, over: Partial<ChatAction> = {}): ChatAction => ({ id, tool: 'move_task', args: {}, class: 'write', status: 'pending', machine_id: null, project_id: null, tab_id: null, summary: `mover o card ${id}`, created_at: T0, ...over });
const choice = (id: string, over: Partial<TabQuestion> = {}): TabQuestion =>
  ({ id, tab_id: 't1', tab_name: 'api', kind: 'choice', status: 'open', answer: null, error_code: null, created_at: T0, answered_at: null, closed_at: null, payload: { questions: [{ question: 'Qual cor?', header: 'Cor', multi_select: false, options: [] }] }, ...over }) as TabQuestion;
const permission = (id: string, over: Partial<TabQuestion> = {}): TabQuestion =>
  ({ id, tab_id: 't1', tab_name: 'web', kind: 'permission', status: 'open', answer: null, error_code: null, created_at: T0, answered_at: null, closed_at: null, payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;
const suggestion = (id: string): TabSuggestion => ({ id, tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit' }, status: 'open', answer: null, error_code: null, created_at: T0, answered_at: null, closed_at: null });

const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderBar(actions: ChatAction[], questions: TabQuestion[] = [], suggestions: TabSuggestion[] = [], props: Partial<Parameters<typeof ChatPendingBar>[0]> = {}) {
  const onApprove = vi.fn();
  const utils = render(<ChatPendingBar entries={chatTimeline([], actions, questions, suggestions)} batchDeciding={false} onApprove={onApprove} {...props} />);
  return { ...utils, onApprove };
}

it('is not rendered when nothing waits, and suggestions or decided cards do not count', () => {
  const { container } = renderBar([action('a1', { status: 'executed' })], [choice('q1', { status: 'answered' })], [suggestion('s1')]);
  expect(container).toBeEmptyDOMElement();
});

it('counts one pending item in the singular, collapsed', () => {
  renderBar([action('a1')], [], [suggestion('s1')]);
  const toggle = screen.getByRole('button', { name: /1 pendente$/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('list')).toBeNull();
});

it('counts pending actions plus open questions and permissions in the plural, and lists them in thread order', () => {
  renderBar([action('a1', { created_at: at(2) })], [choice('q1', { created_at: at(1) }), permission('q2', { created_at: at(3) })], [suggestion('s1')]);
  const toggle = screen.getByRole('button', { name: /3 pendentes$/ });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const lines = within(screen.getByRole('list')).getAllByRole('button').map((b) => b.textContent);
  expect(lines).toEqual(['A aba «api» pergunta: Qual cor?', 'mover o card a1', 'A aba «web» pede permissão para usar «Bash»']);
});

it('a line scrolls the thread to its card and highlights it for a moment', () => {
  vi.useFakeTimers();
  const onLocate = vi.fn();
  const host = document.createElement('ol');
  host.innerHTML = '<li data-chat-card="a1 a2"></li><li data-chat-card="q1"></li>';
  document.body.appendChild(host);
  renderBar([action('a1'), action('a2')], [choice('q1', { created_at: at(1) })], [], { onLocate });
  fireEvent.click(screen.getByRole('button', { name: /3 pendentes/ }));
  fireEvent.click(screen.getByRole('button', { name: 'mover o card a2' }));
  const group = host.querySelector('[data-chat-card~="a2"]')!;
  expect(onLocate).toHaveBeenCalled();
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView.mock.contexts[0]).toBe(group);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  expect(group).toHaveClass('ring-2');
  act(() => void vi.advanceTimersByTime(1600));
  expect(group).not.toHaveClass('ring-2');

  fireEvent.click(screen.getByRole('button', { name: 'A aba «api» pergunta: Qual cor?' }));
  expect(scrollIntoView.mock.contexts[1]).toBe(host.querySelector('[data-chat-card="q1"]'));
  host.remove();
});

it('offers "Aprovar as reversíveis" only with two or more pending writes, and sends only their ids', () => {
  const { onApprove } = renderBar([action('a1'), action('a2', { class: 'irreversible' }), action('a3'), action('a4', { status: 'approved' })]);
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar as reversíveis (2)' }));
  expect(onApprove).toHaveBeenCalledWith(['a1', 'a3']);
  cleanup();
  renderBar([action('a1'), action('a2', { class: 'irreversible' })]);
  expect(screen.queryByRole('button', { name: /Aprovar as reversíveis/ })).toBeNull();
});

it('approves every pending write at once, 50 of them too (TER-1192), and is disabled while one is in flight', () => {
  const many = Array.from({ length: 50 }, (_, i) => action(`a${i}`));
  const { onApprove } = renderBar(many);
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar as reversíveis (50)' }));
  expect(onApprove.mock.calls[0][0]).toHaveLength(50);
  cleanup();
  renderBar([action('a1'), action('a2')], [], [], { batchDeciding: true });
  expect(screen.getByRole('button', { name: 'Aprovar as reversíveis (2)' })).toBeDisabled();
});
