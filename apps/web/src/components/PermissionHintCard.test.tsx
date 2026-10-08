// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { Machine } from '../lib/types';

const setHintMock = vi.fn();
vi.mock('../lib/data', () => ({ useData: () => ({ setMachinePermissionHint: setHintMock }) }));

import { PermissionHintCard } from './PermissionHintCard';

const machine = { id: 'm1', name: 'mini', type: 'agent', permission_hint: false } as Machine;
const box = () => screen.getByLabelText('Mostrar o que a permissão aprova') as HTMLInputElement;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('PermissionHintCard (TER-614)', () => {
  it('starts off, as every machine does, and turns on', async () => {
    setHintMock.mockResolvedValue(undefined);
    render(<PermissionHintCard machine={machine} />);
    expect(box().checked).toBe(false);
    fireEvent.click(box());
    await waitFor(() => expect(setHintMock).toHaveBeenCalledWith('m1', true));
    expect(box().checked).toBe(true);
  });

  it("reverts with the server's reason when the machine refused", async () => {
    setHintMock.mockRejectedValue(new ApiError(409, 'Atualize o agente desta máquina'));
    render(<PermissionHintCard machine={machine} />);
    fireEvent.click(box());
    await screen.findByText('Atualize o agente desta máquina');
    expect(box().checked).toBe(false);
  });
});
