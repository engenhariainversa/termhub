// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatWatches } from './ChatWatches';
import { watchEventsLabel, watchHeadline, watchKindLabel, watchPlainEvents, watchStatus, watchUntilLabel } from './watch-text';
import type { ChatWatch } from '../../lib/types';

const now = new Date(2026, 9, 22, 14, 0);
const watch = (id: string, over: Partial<ChatWatch> = {}): ChatWatch => ({
  id,
  kind: 'pr',
  target_id: 'pr-1',
  label: 'PR #511 Login fix',
  events: ['merged', 'ci_failed'],
  recurring: false,
  note: '',
  summary: 'Te aviso quando o PR #511 for mesclado',
  created_at: '2026-10-21T10:00:00.000Z',
  expires_at: new Date(2026, 9, 22, 18, 0).toISOString(),
  fire_count: 0,
  last_event: null,
  last_fired_at: null,
  target_state: null,
  ...over,
});
const tabWatch = watch('w2', {
  kind: 'tab',
  label: 'OPM-568 Abacate',
  events: ['finished', 'waiting_input', 'waiting_permission', 'idle', 'error', 'blocked', 'auth_required', 'trust_prompt', 'gone'],
  recurring: true,
  summary: 'Te aviso quando a aba OPM-568 (Abacate) parar',
  expires_at: new Date(2026, 9, 23, 16, 0).toISOString(),
  fire_count: 2,
  last_event: 'finished',
  last_fired_at: new Date(2026, 9, 22, 13, 32).toISOString(),
  target_state: 'working',
});

afterEach(cleanup);

it('is not rendered when there is no watch', () => {
  const { container } = render(<ChatWatches watches={[]} cancelingId={null} errors={{}} onCancel={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

it('shows one watch on one line: the person\'s sentence, what already happened, until when, and ✕', () => {
  const onCancel = vi.fn();
  render(<ChatWatches watches={[tabWatch]} cancelingId={null} errors={{}} onCancel={onCancel} now={now} />);
  expect(screen.getByRole('region', { name: 'Acompanhando' })).toBeInTheDocument();
  expect(screen.getByText('Te aviso quando a aba OPM-568 (Abacate) parar')).toBeInTheDocument();
  expect(screen.getByText(/trabalhando agora · terminou às 13:32 · avisou 2× · até amanhã 16:00/)).toBeInTheDocument();
  // The detailed events only unfolded.
  expect(screen.queryByText(/avisa em:/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Te aviso quando a aba OPM-568/ }));
  expect(screen.getByText(/Aba OPM-568 Abacate · avisa em: terminou, esperando resposta.* · toda vez/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar Te aviso quando a aba OPM-568 (Abacate) parar' }));
  expect(onCancel).toHaveBeenCalledWith('w2');
});

it('never shows the concierge\'s note, not even as a tooltip (an older server may still send it)', () => {
  const { container } = render(<ChatWatches watches={[watch('w1', { note: 'read_last_answer e notify needs_you' })]} cancelingId={null} errors={{}} onCancel={vi.fn()} now={now} />);
  expect(container.textContent).not.toContain('read_last_answer');
  expect(container.innerHTML).not.toContain('read_last_answer');
});

it('folds several watches into "Acompanhando N coisas", unfolded on click', () => {
  render(<ChatWatches watches={[watch('w1'), tabWatch, watch('r1', { kind: 'reminder', target_id: null, label: 'Conferir o build', summary: 'Conferir o build', events: ['due'], next_at: new Date(2026, 9, 22, 18, 0).toISOString(), every_minutes: null })]} cancelingId={null} errors={{}} onCancel={vi.fn()} now={now} />);
  const toggle = screen.getByRole('button', { name: /Acompanhando 3 coisas/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('Te aviso quando o PR #511 for mesclado')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(screen.getByText('Te aviso quando o PR #511 for mesclado')).toBeInTheDocument();
  expect(screen.getByText('Às 18:00: Conferir o build')).toBeInTheDocument();
});

it('disables the ✕ in flight and shows a failure under its watch, unfolded', () => {
  render(<ChatWatches watches={[watch('w1'), tabWatch]} cancelingId="w1" errors={{ w1: 'Não foi possível cancelar' }} onCancel={vi.fn()} now={now} />);
  expect(screen.getByRole('button', { name: 'Cancelar Te aviso quando o PR #511 for mesclado' })).toBeDisabled();
  expect(screen.getByText('Não foi possível cancelar')).toBeInTheDocument();
});

it('composes a sentence for a watch made before the concierge wrote one, in plain words', () => {
  expect(watchHeadline(watch('w1', { summary: null }), now)).toBe('PR #511 Login fix: te aviso quando o PR for mesclado ou o CI falhar');
  expect(watchPlainEvents(tabWatch)).toBe('terminar, perguntar algo ou der erro');
  expect(watchPlainEvents({ kind: 'tab', events: ['gone'] })).toBe('for fechada');
  expect(watchHeadline(watch('r1', { kind: 'reminder', summary: null, label: 'nota interna', next_at: new Date(2026, 9, 22, 18, 0).toISOString() }), now)).toBe('Lembrete às 18:00');
});

it('says what happened last, when, and how many times', () => {
  expect(watchStatus(watch('w1', { last_event: 'ci_failed', last_fired_at: new Date(2026, 9, 22, 9, 5).toISOString(), fire_count: 1 }), now)).toBe('CI falhou às 09:05 · até 18:00');
  expect(watchStatus(watch('w1', { kind: 'tab', target_state: 'waiting_input' }), now)).toBe('parada agora · até 18:00');
  expect(watchStatus(watch('w1', { last_event: 'rebooted', last_fired_at: new Date(2026, 9, 22, 9, 5).toISOString() }), now)).toBe('rebooted às 09:05 · até 18:00');
  expect(
    watchStatus(watch('r1', { kind: 'reminder', recurring: true, every_minutes: 10, expires_at: new Date(2026, 9, 22, 20, 0).toISOString(), next_at: new Date(2026, 9, 22, 14, 10).toISOString() }), now),
  ).toBe('a cada 10 min · até 20:00');
});

it('shows an unknown kind or event as it came', () => {
  expect(watchKindLabel('agent_release')).toBe('Versão do agent');
  expect(watchKindLabel('deploy_target')).toBe('deploy_target');
  expect(watchKindLabel('constructor')).toBe('constructor');
  expect(watchEventsLabel(['published', 'rebooted'])).toBe('publicou, rebooted');
});

it('says the validity the human way: today, tomorrow, or a date', () => {
  expect(watchUntilLabel({ expires_at: new Date(2026, 9, 22, 14, 32).toISOString() }, now)).toBe('até 14:32');
  expect(watchUntilLabel({ expires_at: new Date(2026, 9, 23, 16, 0).toISOString() }, now)).toBe('até amanhã 16:00');
  expect(watchUntilLabel({ expires_at: new Date(2026, 9, 25, 9, 5).toISOString() }, now)).toMatch(/^até 25\/10.*09:05$/);
});
