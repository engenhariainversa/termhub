// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatContextBadge } from './ChatContextBadge';

afterEach(() => cleanup());

const NOW = new Date(2026, 9, 29, 15, 0);

const badge = (over: Partial<Parameters<typeof ChatContextBadge>[0]> = {}) =>
  render(<ChatContextBadge tokens={100_000} window={200_000} compacting={false} canCompact onCompact={() => undefined} now={NOW} {...over} />);

it.each([
  [0, '0%', 'text-fg-dim'],
  [100_000, '50%', 'text-fg-dim'],
  [170_000, '85%', 'text-warn'],
  [190_000, '95%', 'text-danger'],
])('at %i of 200 mil tokens it reads %s (%s)', (tokens, label, color) => {
  badge({ tokens });
  const m = screen.getByRole('meter', { name: 'Contexto da conversa' });
  expect(m).toHaveTextContent(label);
  expect(m).toHaveAttribute('aria-valuenow', String(tokens));
  expect(m).toHaveAttribute('aria-valuemax', '200000');
  expect(m.className).toContain(color);
});

it("measures against the person's own limit first", () => {
  badge({ tokens: 170_000, window: 1_000_000, limit: 200_000 });
  const m = screen.getByRole('meter');
  expect(m).toHaveTextContent('85%');
  expect(m).toHaveAttribute('aria-valuemax', '200000');
  expect(m.className).toContain('text-warn');
  fireEvent.click(m);
  expect(screen.getByRole('dialog')).toHaveTextContent('170 mil de 200 mil tokens (o seu limite)');
});

it('is not there before the first answer', () => {
  badge({ tokens: null });
  expect(screen.queryByRole('meter')).toBeNull();
});

it('without a window it shows the tokens alone', () => {
  badge({ window: null });
  expect(screen.getByRole('meter')).toHaveTextContent(/^100 mil$/);
});

it('a click opens the numbers, the last compaction and "Compactar"', () => {
  const onCompact = vi.fn();
  badge({ onCompact, compactedAt: new Date(2026, 9, 29, 14, 5).toISOString() });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('meter'));
  expect(screen.getByRole('dialog')).toHaveTextContent('100 mil de 200 mil tokens · compactado às 14:05');
  fireEvent.click(screen.getByRole('button', { name: 'Compactar' }));
  expect(onCompact).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('names the day of a compaction before today', () => {
  badge({ compactedAt: new Date(2026, 9, 28, 9, 30).toISOString() });
  fireEvent.click(screen.getByRole('meter'));
  expect(screen.getByRole('dialog')).toHaveTextContent(/compactado em 28\/10\/2026,? 09:30/);
});

it('Escape closes it, and "Compactar" is disabled while compacting', () => {
  badge({ compacting: true, canCompact: false });
  fireEvent.click(screen.getByRole('meter'));
  expect(screen.getByRole('button', { name: 'Compactando…' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
