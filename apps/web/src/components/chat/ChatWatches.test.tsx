// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatWatches } from './ChatWatches';
import { reminderDetails, watchEventsLabel, watchKindLabel, watchUntilLabel } from './watch-text';
import type { ChatWatch } from '../../lib/types';

const watch = (id: string, over: Partial<ChatWatch> = {}): ChatWatch => ({
  id,
  kind: 'pr',
  target_id: 'pr-1',
  label: 'PR #511 Login fix',
  events: ['merged', 'ci_failed'],
  recurring: false,
  note: 'avisar o Pedro',
  created_at: '2026-10-21T10:00:00.000Z',
  expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  fire_count: 0,
  ...over,
});

afterEach(cleanup);

it('is not rendered when there is no watch', () => {
  const { container } = render(<ChatWatches watches={[]} cancelingId={null} errors={{}} onCancel={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

it('lists each watch with its kind, label, events, note and a Cancelar that calls back with its id', () => {
  const onCancel = vi.fn();
  render(<ChatWatches watches={[watch('w1'), watch('w2', { kind: 'tab', label: 'api', events: ['finished'], recurring: true, note: '' })]} cancelingId={null} errors={{}} onCancel={onCancel} />);
  expect(screen.getByText('Acompanhando')).toBeInTheDocument();
  expect(screen.getByText('PR #511 Login fix')).toBeInTheDocument();
  expect(screen.getByText(/avisa em: merge, CI vermelho/)).toBeInTheDocument();
  expect(screen.getByText('avisar o Pedro')).toBeInTheDocument();
  expect(screen.getByText(/avisa em: terminou · sempre · até/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar api' }));
  expect(onCancel).toHaveBeenCalledWith('w2');
});

it('disables the Cancelar in flight and shows a failure under its watch', () => {
  render(<ChatWatches watches={[watch('w1')]} cancelingId="w1" errors={{ w1: 'Não foi possível cancelar' }} onCancel={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Cancelar PR #511 Login fix' })).toBeDisabled();
  expect(screen.getByText('Não foi possível cancelar')).toBeInTheDocument();
});

it('shows an unknown kind or event as it came', () => {
  expect(watchKindLabel('agent_release')).toBe('Versão do agent');
  expect(watchKindLabel('deploy_target')).toBe('deploy_target');
  expect(watchKindLabel('constructor')).toBe('constructor');
  expect(watchEventsLabel(['published', 'rebooted'])).toBe('publicou, rebooted');
});

it('says only the time for a watch that ends today', () => {
  const now = new Date(2026, 9, 21, 9, 0);
  expect(watchUntilLabel({ expires_at: new Date(2026, 9, 21, 14, 32).toISOString() }, now)).toBe('até 14:32');
  expect(watchUntilLabel({ expires_at: new Date(2026, 9, 23, 9, 5).toISOString() }, now)).toMatch(/^até 23\/10.*09:05$/);
});

// TER-1100: a reminder says when (and how often), not "avisa em"; its label is its note, said once.
it('shows a reminder with its next time, its pace and no repeated note', () => {
  const now = new Date(2026, 9, 21, 9, 0);
  const next = new Date(2026, 9, 21, 18, 0).toISOString();
  render(
    <ChatWatches
      watches={[watch('r1', { kind: 'reminder', target_id: null, label: 'Conferir o build', note: 'Conferir o build', events: ['due'], next_at: next, every_minutes: null })]}
      cancelingId={null}
      errors={{}}
      onCancel={vi.fn()}
    />,
  );
  expect(screen.getByText('Lembrete')).toBeInTheDocument();
  expect(screen.getAllByText('Conferir o build', { exact: false })).toHaveLength(1);
  expect(screen.queryByText(/avisa em/)).not.toBeInTheDocument();
  expect(reminderDetails({ next_at: next, every_minutes: null, recurring: false, expires_at: next }, now)).toBe('às 18:00');
  expect(reminderDetails({ next_at: next, every_minutes: 10, recurring: true, expires_at: new Date(2026, 9, 21, 20, 0).toISOString() }, now)).toBe('às 18:00 · a cada 10 min · até 20:00');
});
