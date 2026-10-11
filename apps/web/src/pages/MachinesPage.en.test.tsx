// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';

vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: () => true, viewAs: 'self' }) }));
vi.mock('../lib/data', () => {
  const machines = [
    { id: 'm1', name: 'mac', subtitle: null, type: 'agent', capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: null },
    { id: 'm2', name: 'box', type: 'ssh', host: 'box', ssh_port: 22, capabilities: [], is_local: false, os: null, owner_name: null, hooks_installed_at: null },
  ];
  return {
    useData: () => ({
      machines,
      projects: [],
      hiddenLocal: [{ id: 'm3', name: 'other' }, { id: 'm4', name: 'another' }],
      claimLocal: vi.fn(),
      statuses: { m1: 'online' },
      missingTmux: { m2: true },
      deleteMachine: vi.fn(),
      checkStatus: vi.fn(),
    }),
  };
});
vi.mock('../components/MachineForm', () => ({ MachineForm: () => null }));

import { MachinesPage } from './MachinesPage';

beforeEach(() => {
  void i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  void i18n.changeLanguage('pt-BR');
});

describe('MachinesPage in English', () => {
  it('shows the machine list in English, machine names as they are', () => {
    render(
      <MemoryRouter>
        <MachinesPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Machines' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ machine' })).toBeInTheDocument();
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getAllByText('no project')).toHaveLength(2);
    expect(screen.getByText('SSH (legacy)')).toBeInTheDocument();
    expect(screen.getByText('no tmux')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'no monitor' })).toBeInTheDocument();
    expect(screen.getByText('2 local machines from other computers')).toBeInTheDocument();
    expect(screen.getByTitle('online — click to check')).toBeInTheDocument();
  });

  it('tells how to remove an agent by hand when it cannot uninstall itself', () => {
    render(
      <MemoryRouter>
        <MachinesPage />
      </MemoryRouter>,
    );
    fireEvent.click(within(screen.getByText('mac').closest('li')!).getByRole('button', { name: '✕' }));
    expect(screen.getByText('The agent stays installed on the machine. To remove it, run there:')).toBeInTheDocument();
  });
});
