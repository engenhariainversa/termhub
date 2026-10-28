// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { Machine } from '../lib/types';

const updateMachineMock = vi.fn(async (_id: string, input: Partial<Machine>) => input);
vi.mock('../lib/data', () => ({ useData: () => ({ updateMachine: updateMachineMock }) }));

import { IdleTabCloseCard } from './IdleTabCloseCard';

const machine = (idle_tab_close_hours: number | null) => ({ id: 'm1', name: 'hulk', type: 'agent', idle_tab_close_hours }) as Machine;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  updateMachineMock.mockImplementation(async (_id: string, input: Partial<Machine>) => input);
});

describe('IdleTabCloseCard (TER-1138)', () => {
  it('is off by default and turns on with 24 hours', async () => {
    render(<IdleTabCloseCard machine={machine(null)} />);
    const box = screen.getByLabelText('Fechar abas paradas') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByLabelText('Horas parada antes de fechar')).not.toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', { idle_tab_close_hours: 24 }));
    expect(screen.getByLabelText('Horas parada antes de fechar')).toHaveValue(24);
  });

  it('saves the hours on blur, refuses a value out of bounds, and turns off', async () => {
    render(<IdleTabCloseCard machine={machine(24)} />);
    const hours = screen.getByLabelText('Horas parada antes de fechar');
    fireEvent.change(hours, { target: { value: '1' } });
    fireEvent.blur(hours);
    expect(await screen.findByText('Use de 2 a 720 horas')).toBeInTheDocument();
    expect(updateMachineMock).not.toHaveBeenCalled();
    fireEvent.change(hours, { target: { value: '48' } });
    fireEvent.blur(hours);
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', { idle_tab_close_hours: 48 }));
    fireEvent.click(screen.getByLabelText('Fechar abas paradas'));
    await waitFor(() => expect(updateMachineMock).toHaveBeenLastCalledWith('m1', { idle_tab_close_hours: null }));
  });

  it('reverts and shows the server message when saving fails', async () => {
    updateMachineMock.mockRejectedValue(new ApiError(403, 'Sem permissão'));
    render(<IdleTabCloseCard machine={machine(null)} />);
    const box = screen.getByLabelText('Fechar abas paradas') as HTMLInputElement;
    fireEvent.click(box);
    await screen.findByText('Sem permissão');
    expect(box.checked).toBe(false);
  });
});
