// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../lib/types';

const networkCheckMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: { machines: { networkCheck: (...a: unknown[]) => networkCheckMock(...a) } },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { ApiError } from '../lib/api';
import { NetworkCheckCard } from './NetworkCheckCard';

const machine = { id: 'm1', name: 'mini', type: 'agent' } as Machine;

afterEach(() => {
  cleanup();
  networkCheckMock.mockReset();
});

describe('NetworkCheckCard', () => {
  it('shows ✓ for a 401 and what to open in the firewall for the rest, with the host', async () => {
    networkCheckMock.mockResolvedValue({
      checks: [
        { name: 'hooks', url: 'https://termhub.dev/api/hooks/events', host: 'termhub.dev', ok: true, status: 401, error: null },
        { name: 'mcp', url: 'https://termhub.dev/mcp', host: 'termhub.dev', ok: false, status: null, error: 'ECONNREFUSED' },
      ],
    });
    render(<NetworkCheckCard machine={machine} />);
    await waitFor(() => expect(screen.getByText('Hooks do monitor', { exact: false })).toBeTruthy());
    expect(networkCheckMock).toHaveBeenCalledWith('m1');
    expect(screen.getByText(': ECONNREFUSED')).toBeTruthy();
    expect(screen.getByText('Libere https://termhub.dev/mcp no firewall/proxy desta máquina.')).toBeTruthy();
    expect(screen.queryByText(/api\/hooks\/events no firewall/)).toBeNull();
  });

  it('shows the server message for an outdated agent', async () => {
    networkCheckMock.mockRejectedValue(new ApiError(409, 'Atualize o agente desta máquina'));
    render(<NetworkCheckCard machine={machine} />);
    await waitFor(() => expect(screen.getByText('Atualize o agente desta máquina')).toBeTruthy());
  });
});
