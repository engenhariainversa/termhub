// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createProject, keyAvailable } = vi.hoisted(() => ({ createProject: vi.fn(), keyAvailable: vi.fn() }));
vi.mock('../lib/data', () => ({
  useData: () => ({
    createProject,
    machines: [
      { id: 'm1', name: 'mac', type: 'agent', capabilities: [] },
      { id: 'm2', name: 'jarvis', type: 'agent', capabilities: [] },
    ],
    statuses: {},
    projects: [
      { id: 'p1', name: 'Opa Pingou', status: 'active' },
      { id: 'p2', name: 'Velho', status: 'archived' },
    ],
  }),
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { projects: { keyAvailable } } }));
vi.mock('./DirectoryBrowser', () => ({ DirectoryBrowser: () => null }));
const perms = vi.hoisted(() => ({ machinesCreate: true }));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ can: (res: string, act?: string) => !(res === 'machines' && act === 'create') || perms.machinesCreate }),
}));
vi.mock('./MachineForm', () => ({ MachineForm: () => null }));

import { ProjectForm } from './ProjectForm';

afterEach(() => {
  cleanup();
  perms.machinesCreate = true;
  vi.clearAllMocks();
});

const mount = (machineId?: string) =>
  render(
    <MemoryRouter>
      <ProjectForm open onClose={() => {}} machineId={machineId} />
    </MemoryRouter>,
  );

const fillStep1 = async (name: string) => {
  fireEvent.change(screen.getByLabelText('Nome'), { target: { value: name } });
  await screen.findByText('disponível');
};

describe('ProjectForm', () => {
  it('step 1: suggests a key from the name and checks its availability', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    mount();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Hub Community' } });
    expect((screen.getByLabelText('Chave') as HTMLInputElement).value).toBe('HC');
    await waitFor(() => expect(keyAvailable).toHaveBeenCalledWith('HC'));
    await screen.findByText('disponível');
    expect(screen.getByRole('button', { name: 'Continuar' })).not.toBeDisabled();
  });

  it('step 1: "Continuar" is disabled while the key is taken', async () => {
    keyAvailable.mockResolvedValue({ available: false, reason: 'taken' });
    mount();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Hub Community' } });
    await screen.findByText('já em uso');
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
  });

  it('step 2: "Pular por enquanto" creates the project right away with no machine', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    createProject.mockResolvedValue({ id: 'new' });
    mount();
    await fillStep1('Novo');
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByText('Passo 2 de 3');
    fireEvent.click(screen.getByRole('button', { name: 'Pular por enquanto' }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: 'Novo', key: 'NOV', description: null }));
  });

  it('step 2: "Cadastrar nova máquina" shows only to who can create machines', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    perms.machinesCreate = false;
    mount();
    await fillStep1('Novo');
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByText('Passo 2 de 3');
    expect(screen.queryByRole('button', { name: 'Cadastrar nova máquina' })).toBeNull();
  });

  it('step 1: "Herdar regras de" lists the active projects and sends the one picked (TER-1169)', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    createProject.mockResolvedValue({ id: 'new' });
    mount();
    await fillStep1('Novo');
    const select = screen.getByLabelText('Herdar regras de (opcional)') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Nenhum projeto', 'Opa Pingou']);
    fireEvent.change(select, { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByText('Passo 2 de 3');
    fireEvent.click(screen.getByRole('button', { name: 'Pular por enquanto' }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: 'Novo', key: 'NOV', description: null, inherit_rules_from: 'p1' }));
  });

  it('step 2 → 3: picking a machine and a directory creates the project with machine_id/cwd/create_dir', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    createProject.mockResolvedValue({ id: 'new' });
    mount();
    await fillStep1('Outro');
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByText('Passo 2 de 3');
    fireEvent.click(screen.getByLabelText('mac'));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByText('Passo 3 de 3');
    fireEvent.change(screen.getByLabelText('Diretório (caminho absoluto na máquina)'), { target: { value: '/src/outro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar projeto' }));
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({ name: 'Outro', key: 'OUT', description: null, machine_id: 'm1', cwd: '/src/outro', create_dir: true }),
    );
  });

  it('the machineId prop preselects the machine so "Continuar" is enabled on step 2', async () => {
    keyAvailable.mockResolvedValue({ available: true });
    mount('m2');
    await fillStep1('Terceiro');
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByText('Passo 2 de 3');
    expect(screen.getByRole('button', { name: 'Continuar' })).not.toBeDisabled();
  });
});
