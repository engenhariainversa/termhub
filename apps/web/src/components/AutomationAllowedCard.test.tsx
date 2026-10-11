// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../lib/types';

const updateMachineMock = vi.fn();
vi.mock('../lib/data', () => ({ useData: () => ({ updateMachine: updateMachineMock }) }));

import { AutomationAllowedCard } from './AutomationAllowedCard';

const machine = { id: 'm1', name: 'mini', type: 'agent', automation_allowed: true } as Machine;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('AutomationAllowedCard', () => {
  it('shows the machine value and saves the toggle', async () => {
    updateMachineMock.mockResolvedValue({});
    render(<AutomationAllowedCard machine={machine} />);
    const box = screen.getByLabelText('Aceita trabalho automático') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', { automation_allowed: false }));
    expect(box.checked).toBe(false);
  });

  it('reverts the toggle when saving fails', async () => {
    updateMachineMock.mockRejectedValue(new Error('x'));
    render(<AutomationAllowedCard machine={machine} />);
    const box = screen.getByLabelText('Aceita trabalho automático') as HTMLInputElement;
    fireEvent.click(box);
    await screen.findByText('Erro ao salvar');
    expect(box.checked).toBe(true);
  });
});
