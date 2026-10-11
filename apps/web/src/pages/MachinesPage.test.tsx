// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { deleteMachine, canMock } = vi.hoisted(() => ({ deleteMachine: vi.fn(), canMock: vi.fn(() => true) }));

vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: canMock, viewAs: 'self' }) }));
vi.mock('../lib/data', () => {
  const machines = [
    { id: 'm1', name: 'mac', subtitle: 'MacBook do escritório', type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: new Date().toISOString() },
    { id: 'm2', name: 'jarvis', type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: new Date().toISOString() },
    { id: 'm3', name: 'mini', type: 'agent', agent_version: '0.22.0', capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: new Date().toISOString() },
    { id: 'm4', name: 'old', type: 'agent', agent_version: '0.21.3', capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: new Date().toISOString() },
  ];
  const projects = [
    { id: 'p1', key: 'ALPHA', name: 'alpha', status: 'active', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }] },
  ];
  return {
    useData: () => ({
      machines,
      projects,
      hiddenLocal: [],
      claimLocal: vi.fn(),
      statuses: { m3: 'online', m4: 'online' },
      missingTmux: {},
      deleteMachine,
      checkStatus: vi.fn(),
    }),
  };
});
vi.mock('../components/MachineForm', () => ({
  MACHINE_FORM_TABS: ['general', 'agent', 'monitor', 'simulator'],
  MachineForm: ({ open, machine, initialTab }: { open: boolean; machine?: { name: string } | null; initialTab?: string }) =>
    open ? <div>machine-form-marker {machine?.name} {initialTab ?? 'general'}</div> : null,
}));

import { MachinesPage } from './MachinesPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  canMock.mockReturnValue(true);
});

const mount = () =>
  render(
    <MemoryRouter>
      <MachinesPage />
    </MemoryRouter>,
  );

describe('MachinesPage', () => {
  it('lists machines with their linked-project chips', () => {
    mount();
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getByText('jarvis')).toBeInTheDocument();
    const jarvisRow = screen.getByText('jarvis').closest('li')!;
    expect(jarvisRow).toHaveTextContent('nenhum projeto');
    const macRow = screen.getByText('mac').closest('li')!;
    expect(macRow).toHaveTextContent('alpha');
  });

  it('lets the machine list take the full page width (no max-w cap)', () => {
    mount();
    const list = screen.getByText('mac').closest('ul')!;
    expect(list.className).not.toMatch(/max-w-/);
  });

  it('shows a machine\'s subtitle on its card, and nothing for one without', () => {
    mount();
    const macRow = screen.getByText('mac').closest('li')!;
    expect(within(macRow).getByText('MacBook do escritório')).toBeInTheDocument();
    const jarvisRow = screen.getByText('jarvis').closest('li')!;
    expect(jarvisRow).not.toHaveTextContent('MacBook do escritório');
  });

  it('"+ máquina" opens the machine form', () => {
    mount();
    expect(screen.queryByText(/machine-form-marker/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ máquina' }));
    expect(screen.getByText(/machine-form-marker/)).toBeInTheDocument();
  });

  it('deletes a machine after confirming', async () => {
    deleteMachine.mockResolvedValue(undefined);
    mount();
    const macRow = screen.getByText('mac').closest('li')!;
    fireEvent.click(within(macRow).getByRole('button', { name: '✕' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await Promise.resolve();
    expect(deleteMachine).toHaveBeenCalledWith('m1', { uninstall: false });
  });

  const openDelete = (name: string) => {
    const row = screen.getByText(name).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: '✕' }));
  };

  it('offers to uninstall an online agent on 0.22.0+, ticked by default', async () => {
    deleteMachine.mockResolvedValue(undefined);
    mount();
    openDelete('mini');
    const box = screen.getByRole('checkbox', { name: /Também desinstalar da máquina/ });
    expect(box).toBeChecked();
    expect(screen.queryByText(/termhub-agent service uninstall/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await Promise.resolve();
    expect(deleteMachine).toHaveBeenCalledWith('m3', { uninstall: true });
  });

  it('deletes without uninstalling when the box is unticked, and re-ticks it on the next open', async () => {
    deleteMachine.mockResolvedValue(undefined);
    mount();
    openDelete('mini');
    fireEvent.click(screen.getByRole('checkbox', { name: /Também desinstalar da máquina/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await vi.waitFor(() => expect(deleteMachine).toHaveBeenCalledWith('m3', { uninstall: false }));
    await vi.waitFor(() => expect(screen.queryByRole('checkbox')).not.toBeInTheDocument());
    openDelete('mini');
    expect(screen.getByRole('checkbox', { name: /Também desinstalar da máquina/ })).toBeChecked();
  });

  it('sends one request while a delete is running (Enter and the button both confirm)', async () => {
    let finish!: () => void;
    deleteMachine.mockReturnValue(new Promise<void>((r) => (finish = r)));
    mount();
    openDelete('mini');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(deleteMachine).toHaveBeenCalledTimes(1);
    finish();
  });

  it('shows the manual uninstall steps for an offline agent or one older than 0.22.0', () => {
    mount();
    openDelete('mac'); // offline
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/O agente continua instalado na máquina/)).toBeInTheDocument();
    expect(screen.getByText(/termhub-agent service uninstall/)).toHaveTextContent('npm rm -g @termhub/agent');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    openDelete('old'); // online, but 0.21.3
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/termhub-agent disconnect/)).toBeInTheDocument();
  });

  it('uses the shared page header: one title, "+ máquina" among its actions', () => {
    mount();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Máquinas']);
    expect(screen.getByRole('button', { name: '+ máquina' }).closest('header')).not.toBeNull();
  });

  it('opens a machine\'s form on the tab a direct link asks for', () => {
    render(
      <MemoryRouter initialEntries={['/machines?edit=m2&tab=agent']}>
        <MachinesPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('machine-form-marker jarvis agent')).toBeInTheDocument();
  });

  it('falls back to Geral when the link names an unknown tab', () => {
    render(
      <MemoryRouter initialEntries={['/machines?edit=m1&tab=nope']}>
        <MachinesPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('machine-form-marker mac general')).toBeInTheDocument();
  });
});
