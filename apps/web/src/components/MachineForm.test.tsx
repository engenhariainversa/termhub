// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../lib/types';

const { createMock, updateMachineMock } = vi.hoisted(() => ({ createMock: vi.fn(), updateMachineMock: vi.fn() }));

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { role_info: { is_admin: false } } }) }));
vi.mock('../lib/data', () => ({ useData: () => ({ machines: [], updateMachine: updateMachineMock, refresh: vi.fn(async () => {}), claimLocal: vi.fn() }) }));
vi.mock('../lib/api', () => ({
  api: { machines: { create: createMock }, users: { list: vi.fn() } },
  ApiError: class ApiError extends Error {},
}));
vi.mock('./AgentEnrollment', () => ({ AgentEnrollment: () => null }));
vi.mock('./AgentUpdateCard', () => ({ AgentUpdateCard: () => <p>agent card</p> }));
vi.mock('./MonitorHooksCard', async (orig) => ({ ...(await orig<typeof import('./MonitorHooksCard')>()), MonitorHooksCard: () => <p>monitor card</p> }));
vi.mock('./SimulatorSetupCard', () => ({ SimulatorSetupCard: () => <p>simulator card</p> }));
vi.mock('./AutomationAllowedCard', () => ({ AutomationAllowedCard: () => null }));

import { MachineForm } from './MachineForm';

const machine = {
  id: 'm1', name: 'mini', subtitle: 'MacBook do escritório', host: null, ssh_user: null, ssh_port: 22, type: 'agent', os: 'macos', capabilities: [],
  checked_at: null, agent_version: null, agent_last_seen_at: null, agent_auto_update: false, is_local: false, owner_id: 'u1', owner_name: null,
  created_at: '',
} as Machine;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MachineForm subtitle', () => {
  it('offers a "Subtítulo" field under the name and sends it on create', async () => {
    createMock.mockResolvedValue({ machine: { ...machine, id: 'm-new' } });
    render(<MachineForm open onClose={() => {}} />);
    const subtitle = screen.getByLabelText('Subtítulo');
    expect(subtitle).toHaveAttribute('placeholder', expect.stringContaining('MacBook do escritório'));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'mini' } });
    fireEvent.change(subtitle, { target: { value: 'notebook da sala' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'mini', subtitle: 'notebook da sala' })));
  });

  it('starts from the machine\'s subtitle on edit and sends the new one, a cleared field as null', async () => {
    updateMachineMock.mockResolvedValue(machine);
    render(<MachineForm open onClose={() => {}} machine={machine} />);
    const subtitle = screen.getByLabelText('Subtítulo');
    expect(subtitle).toHaveValue('MacBook do escritório');
    fireEvent.change(subtitle, { target: { value: 'servidor da sala' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', expect.objectContaining({ subtitle: 'servidor da sala' })));
    fireEvent.change(subtitle, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateMachineMock).toHaveBeenLastCalledWith('m1', expect.objectContaining({ subtitle: null })));
  });
});

describe('MachineForm tabs', () => {
  it('has no tabs when creating a machine', () => {
    render(<MachineForm open onClose={() => {}} />);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('opens on Geral, shows Simulador iOS only on a Mac with Xcode, and keeps what was typed across tabs', async () => {
    updateMachineMock.mockResolvedValue(machine);
    render(<MachineForm open onClose={() => {}} machine={machine} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Geral', 'Agente', 'Monitor']);
    expect(screen.getByRole('tab', { name: 'Geral' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'renomeada' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Agente' }));
    expect(screen.getByText('agent card')).toBeVisible();
    expect(screen.getByLabelText('Nome')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', expect.objectContaining({ name: 'renomeada' })));
  });

  it('adds the simulator tab on a Mac with Xcode', () => {
    render(<MachineForm open onClose={() => {}} machine={{ ...machine, capabilities: ['xcodebuild'] }} />);
    expect(screen.getByRole('tab', { name: 'Simulador iOS' })).toBeInTheDocument();
  });

  it('opens on the tab a direct link asks for, and moves with the arrow keys', () => {
    render(<MachineForm open onClose={() => {}} machine={machine} initialTab="agent" />);
    const agent = screen.getByRole('tab', { name: 'Agente' });
    expect(agent).toHaveAttribute('aria-selected', 'true');
    expect(agent).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(agent, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Monitor' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Monitor' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Monitor' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Geral' })).toHaveAttribute('aria-selected', 'true');
  });

  it('ignores a direct link to a tab the machine does not have', () => {
    render(<MachineForm open onClose={() => {}} machine={machine} initialTab="simulator" />);
    expect(screen.getByRole('tab', { name: 'Geral' })).toHaveAttribute('aria-selected', 'true');
  });

  it('badges the Agente tab when an update is available and Monitor when hooks are missing', () => {
    render(<MachineForm open onClose={() => {}} machine={{ ...machine, update_available: true, hooks_installed_at: null }} />);
    expect(screen.getByRole('tab', { name: /Agente/ })).toHaveTextContent('nova versão');
    expect(screen.getByRole('tab', { name: /Monitor/ })).toHaveTextContent('não instalado');
  });

  it('badges Monitor when the machine has tabs but none reports state', () => {
    render(<MachineForm open onClose={() => {}} machine={{ ...machine, hooks_installed_at: '2026-10-01T00:00:00Z', tabs: 3, tabs_reporting: 0 }} />);
    expect(screen.getByRole('tab', { name: /Monitor/ })).toHaveTextContent('sem reportar');
  });
});
