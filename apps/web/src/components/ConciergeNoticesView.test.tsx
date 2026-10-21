// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConciergePushSettings } from '../lib/types';
import { ConciergeNoticesView } from './ConciergeNoticesView';

const getMock = vi.fn();
const setMock = vi.fn();
vi.mock('../lib/api', () => ({ api: { auth: { conciergePush: (...a: unknown[]) => getMock(...a), setConciergePush: (...a: unknown[]) => setMock(...a) } } }));

const rules: ConciergePushSettings = { needs_you: true, done: true, quiet_start: null, quiet_end: null, group_minutes: 5 };

beforeEach(() => {
  getMock.mockResolvedValue({ concierge: rules });
  setMock.mockImplementation(async (concierge: ConciergePushSettings) => ({ concierge }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConciergeNoticesView (TER-1101)', () => {
  it('turns a level off, saving at once with the browser\'s zone', async () => {
    render(<ConciergeNoticesView />);
    const done = await screen.findByRole('checkbox', { name: /Concluído/ });
    fireEvent.click(done);
    await waitFor(() => expect(setMock).toHaveBeenCalledWith({ ...rules, done: false }, expect.any(String)));
    expect(done).not.toBeChecked();
  });

  it('quiet hours: 22:00–07:00 when turned on, then each end can change', async () => {
    render(<ConciergeNoticesView />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Horário de silêncio' }));
    await waitFor(() => expect(setMock).toHaveBeenLastCalledWith({ ...rules, quiet_start: '22:00', quiet_end: '07:00' }, expect.any(String)));
    fireEvent.change(screen.getByLabelText('Fim do silêncio'), { target: { value: '08:30' } });
    await waitFor(() => expect(setMock).toHaveBeenLastCalledWith({ ...rules, quiet_start: '22:00', quiet_end: '08:30' }, expect.any(String)));
  });

  it('grouping window, and a failed save goes back and says so', async () => {
    render(<ConciergeNoticesView />);
    setMock.mockRejectedValueOnce(new Error('down'));
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: '0' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível salvar');
    expect(select).toHaveValue('5');
  });
});
