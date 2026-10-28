// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import type { ChatMemory } from '../../lib/types';
import { ConciergeModelsField } from './ConciergeModelsField';

const memory = (blocked: string[]): ChatMemory => ({ enabled: true, autodecide: false, codex_replies: false, available: true, count: 0, notes: 0, blocked_models: blocked });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('"Nunca usar fable" saves the family and shows what the server kept (TER-1145)', async () => {
  const set = vi.spyOn(api, 'setChatMemory').mockResolvedValue(memory(['fable']));
  const onSaved = vi.fn();
  render(<ConciergeModelsField memory={memory([])} onSaved={onSaved} />);
  fireEvent.click(screen.getByLabelText('Nunca usar fable'));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(memory(['fable'])));
  expect(set).toHaveBeenCalledWith({ blocked_models: ['fable'] });
});

it('never lets the last allowed family be ruled out', () => {
  render(<ConciergeModelsField memory={memory(['fable', 'opus', 'sonnet'])} onSaved={vi.fn()} />);
  expect((screen.getByLabelText('Nunca usar haiku') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Nunca usar fable') as HTMLInputElement).disabled).toBe(false);
});
