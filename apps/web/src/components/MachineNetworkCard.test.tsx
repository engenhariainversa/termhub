// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine, MachineNetworkInfo } from '../lib/types';

const networkMock = vi.fn();
const wakeMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: { machines: { network: (...a: unknown[]) => networkMock(...a), wake: (...a: unknown[]) => wakeMock(...a) } },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { MachineNetworkCard } from './MachineNetworkCard';

const machine = { id: 'hulk', name: 'hulk', type: 'agent', os: 'macos' } as Machine;

const info = (over: Partial<MachineNetworkInfo> = {}): MachineNetworkInfo => ({
  network: {
    hostname: 'hulk.local',
    default_interface: 'en0',
    gateway: '192.168.1.1',
    interfaces: [{ name: 'en0', mac: 'aa:bb:cc:dd:ee:01', kind: 'ethernet', addresses: [{ family: 'ipv4', address: '192.168.1.20', cidr: '192.168.1.20/24' }] }],
  },
  updated_at: new Date().toISOString(),
  online: false,
  relays: [{ id: 'jarvis', name: 'jarvis', online: true, capable: true, same_network: true }],
  ...over,
});

afterEach(() => {
  cleanup();
  networkMock.mockReset();
  wakeMock.mockReset();
});

describe('MachineNetworkCard', () => {
  it('shows the saved interfaces and wakes the machine through the chosen relay', async () => {
    networkMock.mockResolvedValue(info());
    wakeMock.mockResolvedValue({ machine_id: 'hulk', via: { id: 'jarvis', name: 'jarvis' }, macs: ['aa:bb:cc:dd:ee:01'], broadcasts: [], sent: 4, warnings: ['macos'] });
    render(<MachineNetworkCard machine={machine} />);
    await waitFor(() => expect(screen.getByText('aa:bb:cc:dd:ee:01')).toBeTruthy());
    expect(screen.getByText('hulk.local')).toBeTruthy();
    expect(screen.getByText('192.168.1.20/24')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Enviar por'), { target: { value: 'jarvis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Acordar' }));
    await waitFor(() => expect(screen.getByText(/Pacote enviado por jarvis/)).toBeTruthy());
    expect(wakeMock).toHaveBeenCalledWith('hulk', 'jarvis');
  });

  it('says to update the agent before any network was reported, with no wake button', async () => {
    networkMock.mockResolvedValue(info({ network: null, updated_at: null }));
    render(<MachineNetworkCard machine={machine} />);
    await waitFor(() => expect(screen.getByText(/ainda não informou a rede/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Acordar' })).toBeNull();
  });

  it('disables the button when no machine of the network can send the packet', async () => {
    networkMock.mockResolvedValue(info({ relays: [{ id: 'far', name: 'far', online: true, capable: true, same_network: false }] }));
    render(<MachineNetworkCard machine={machine} />);
    await waitFor(() => expect(screen.getByText(/Nenhuma máquina online na mesma rede local/)).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Acordar' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
