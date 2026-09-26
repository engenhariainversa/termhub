// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { Machine } from '../lib/types';

const statusMock = vi.fn();
const updateAgentMock = vi.fn();
const updateMachineMock = vi.fn(async (_id: string, input: Partial<Machine>) => ({ ...machine, ...input }));

vi.mock('../lib/api', () => ({
  api: { machines: { status: (...a: unknown[]) => statusMock(...a), updateAgent: (...a: unknown[]) => updateAgentMock(...a) } },
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));
vi.mock('../lib/data', () => ({ useData: () => ({ updateMachine: updateMachineMock, checkStatus: vi.fn() }) }));

import { AgentUpdateCard, POLL_MS } from './AgentUpdateCard';

const machine: Machine = {
  id: 'm1', name: 'mini', host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'macos', capabilities: ['tmux'], checked_at: null,
  agent_version: '0.2.1', agent_last_seen_at: null, agent_auto_update: false, claude_auto_swap: false, is_local: false, owner_id: 'u1', owner_name: null, created_at: '',
};
const status = (agent_version: string, latest = '0.2.5', online = true) => ({ id: 'm1', online, tmux: true, os: 'macos', capabilities: [], agent_version, latest_agent_version: latest, update_available: online && agent_version !== latest });

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  updateMachineMock.mockImplementation(async (_id: string, input: Partial<Machine>) => ({ ...machine, ...input }));
  vi.useRealTimers();
});

describe('AgentUpdateCard', () => {
  it('shows the current version and no button when up to date', async () => {
    statusMock.mockResolvedValue(status('0.2.5'));
    render(<AgentUpdateCard machine={machine} />);
    await screen.findByText('v0.2.5 · atualizado');
    expect(screen.queryByRole('button', { name: 'Atualizar' })).toBeNull();
  });

  it('offers the update, then polls until the new version reports back', async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValueOnce(status('0.2.1')).mockResolvedValueOnce(status('0.2.1', '0.2.5', false)).mockResolvedValue(status('0.2.5'));
    updateAgentMock.mockResolvedValue({ installed_version: '0.2.5', restart: 'service', restarting: true });
    render(<AgentUpdateCard machine={machine} />);
    await act(async () => {});
    expect(screen.getByText('v0.2.1 · v0.2.5 disponível')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await act(async () => {});
    expect(updateAgentMock).toHaveBeenCalledWith('m1');
    expect(screen.getByText(/reinicia/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 2); });
    expect(screen.getByText('Agente atualizado para v0.2.5.')).toBeTruthy();
  });

  it('asks for a manual restart when the agent does not run as a service', async () => {
    statusMock.mockResolvedValue(status('0.2.1'));
    updateAgentMock.mockResolvedValue({ installed_version: '0.2.5', restart: 'manual', restarting: false });
    render(<AgentUpdateCard machine={machine} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Atualizar' }));
    await screen.findByText(/reinicie o agente/);
  });

  it('keeps polling when the gateway cuts the request mid-install (no failure code)', async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValueOnce(status('0.2.1')).mockResolvedValue(status('0.2.5'));
    updateAgentMock.mockRejectedValue(new ApiError(524, 'timeout', undefined));
    render(<AgentUpdateCard machine={machine} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await act(async () => {});
    expect(screen.getByText(/A conexão caiu durante a instalação/)).toBeTruthy();
    expect(screen.queryByText('timeout')).toBeNull();
    expect(statusMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(statusMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(screen.getByText('Agente atualizado para v0.2.5.')).toBeTruthy();
  });

  it('shows the real failure and stops when the agent reports AGENT_UPDATE_FAILED', async () => {
    vi.useFakeTimers();
    statusMock.mockResolvedValue(status('0.2.1'));
    updateAgentMock.mockRejectedValue(new ApiError(502, 'Falha ao atualizar o agente: npm exited with code 243', 'AGENT_UPDATE_FAILED'));
    render(<AgentUpdateCard machine={machine} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await act(async () => {});
    expect(screen.getByText('Falha ao atualizar o agente: npm exited with code 243')).toBeTruthy();
    expect(statusMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 2); });
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it('toggles automatic updates through updateMachine', async () => {
    statusMock.mockResolvedValue(status('0.2.5'));
    render(<AgentUpdateCard machine={machine} />);
    fireEvent.click(await screen.findByLabelText('Atualizar automaticamente quando ociosa'));
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', { agent_auto_update: true }));
  });

  it('stops polling once the card unmounts, even if a poll tick is still in flight', async () => {
    vi.useFakeTimers();
    let resolvePoll: ((v: ReturnType<typeof status>) => void) | undefined;
    const pending = new Promise<ReturnType<typeof status>>((resolve) => {
      resolvePoll = resolve;
    });
    statusMock.mockResolvedValueOnce(status('0.2.1')).mockImplementationOnce(() => pending);
    updateAgentMock.mockResolvedValue({ installed_version: '0.2.5', restart: 'service', restarting: true });
    const { unmount } = render(<AgentUpdateCard machine={machine} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await act(async () => {});
    // trigger the first poll tick: it calls status() again, which is now the pending (unresolved) promise
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(statusMock).toHaveBeenCalledTimes(2);
    unmount();
    // resolve the in-flight status() call after the component is gone
    await act(async () => {
      resolvePoll?.(status('0.2.1', '0.2.5', true));
    });
    // give the poll's tick() a chance to reschedule (it must not, since the card is unmounted)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(statusMock).toHaveBeenCalledTimes(2);
  });
});
