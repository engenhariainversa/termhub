// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccount, Machine } from '../lib/types';

const listMock = vi.fn();
const usageMock = vi.fn();
const usageOfMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      aiAccounts: {
        list: (...a: unknown[]) => listMock(...a),
        usage: (...a: unknown[]) => usageMock(...a),
        usageOf: (...a: unknown[]) => usageOfMock(...a),
        create: (...a: unknown[]) => createMock(...a),
        update: (...a: unknown[]) => updateMock(...a),
      },
    },
  };
});
const machines = [
  { id: 'm1', name: 'mac', subtitle: null },
  { id: 'm2', name: 'jarvis', subtitle: 'servidor de casa' },
  { id: 'm3', name: 'hulk', subtitle: null },
] as Machine[];
const projects = [{ id: 'p9', name: 'DR Horton' }, { id: 'p1', name: 'termhub' }];
vi.mock('../lib/data', () => ({ useData: () => ({ machines, projects, statuses: { m1: 'online', m2: 'offline' } }) }));
vi.mock('./AutoSwapSettings', () => ({ AutoSwapSettings: () => null }));

import { AiAccountsView } from './AiAccountsView';

const account = (over: Partial<AiAccount> & { id: string }): AiAccount => ({ provider: 'claude', label: over.id, machine_id: 'm1', config_dir: null, created_at: '', ...over });

beforeEach(() => {
  localStorage.clear();
  listMock.mockResolvedValue({ accounts: [] });
  usageMock.mockResolvedValue({ usage: [] });
  usageOfMock.mockResolvedValue({ usage: { account_id: 'x', ok: false, windows: [], error: null, hint: null, plan: null, fetched_at: '', stale: false } });
  createMock.mockImplementation(async (input: Partial<AiAccount>) => ({ account: account({ id: 'new', ...input }) }));
  updateMock.mockImplementation(async (id: string, input: Partial<AiAccount>) => ({ account: account({ id, ...input }) }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openNew() {
  render(<AiAccountsView />);
  await waitFor(() => expect(listMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '+ conta' }));
  return within(screen.getByRole('dialog'));
}

describe('AiAccountsView: which login an account is (TER-499)', () => {
  it("adds the machine's default login when nothing else is chosen", async () => {
    const form = await openNew();
    expect(form.getByRole('radio', { name: /Conta padrão da máquina/ })).toBeChecked();
    expect(form.queryByLabelText('Diretório de config')).not.toBeInTheDocument();
    fireEvent.click(form.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ provider: 'claude', label: 'Claude', machine_id: 'm1', config_dir: null }));
  });

  it('asks for the directory of another login and sends it', async () => {
    const form = await openNew();
    fireEvent.click(form.getByRole('radio', { name: /Outro diretório de config/ }));
    expect(form.getByRole('button', { name: 'Adicionar' })).toBeDisabled();
    fireEvent.change(form.getByLabelText('Diretório de config'), { target: { value: ' ~/.claude-work ' } });
    fireEvent.click(form.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ config_dir: '~/.claude-work' })));
  });

  it('opens an account on the login it has, and can turn it into the default one', async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'work', config_dir: '~/.claude-work' })] });
    render(<AiAccountsView />);
    fireEvent.click(await screen.findByTitle('Editar'));
    const form = within(screen.getByRole('dialog'));
    expect(form.getByRole('radio', { name: /Outro diretório de config/ })).toBeChecked();
    expect(form.getByLabelText('Diretório de config')).toHaveValue('~/.claude-work');
    fireEvent.click(form.getByRole('radio', { name: /Conta padrão da máquina/ }));
    fireEvent.click(form.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('work', { label: 'work', machine_id: 'm1', config_dir: null }));
  });

  it('says on the card which account is the default login, and shows the directory of the others', async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'home' }), account({ id: 'work', config_dir: '~/.claude-work' })] });
    render(<AiAccountsView />);
    const [home, work] = await screen.findAllByRole('listitem');
    expect(home).toHaveTextContent('login padrão');
    expect(work).toHaveTextContent('~/.claude-work');
    expect(work).not.toHaveTextContent('login padrão');
  });
});

describe('AiAccountsView: accounts grouped by machine (TER-640)', () => {
  const sections = () => screen.getAllByRole('region');
  // the section's header is the button that says whether it is expanded (the other one adds an account)
  const toggleOf = (name: string) => within(screen.getByRole('region', { name })).getAllByRole('button').find((b) => b.hasAttribute('aria-expanded'))!;

  it('shows one section per machine with accounts, in the order of the Máquinas page', async () => {
    listMock.mockResolvedValue({
      accounts: [account({ id: 'a', machine_id: 'm3' }), account({ id: 'b', machine_id: 'm1' }), account({ id: 'c', machine_id: 'm3', provider: 'chatgpt' })],
    });
    render(<AiAccountsView />);
    await screen.findAllByRole('listitem');
    expect(sections().map((s) => s.getAttribute('aria-label'))).toEqual(['mac', 'hulk']);
    const hulk = within(screen.getByRole('region', { name: 'hulk' }));
    expect(hulk.getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('a'), expect.stringContaining('c')]);
    expect(hulk.getByText('2 contas')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'mac' })).getByText('1 conta')).toBeInTheDocument();
  });

  it("shows the machine's subtitle and whether it is online", async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'a', machine_id: 'm2' }), account({ id: 'b', machine_id: 'm1' })] });
    render(<AiAccountsView />);
    await screen.findAllByRole('listitem');
    const jarvis = within(screen.getByRole('region', { name: 'jarvis' }));
    expect(jarvis.getByText('servidor de casa')).toBeInTheDocument();
    expect(jarvis.getByTitle('offline')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'mac' })).getByTitle('online')).toBeInTheDocument();
  });

  it('puts accounts of a machine outside the list in a last section', async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'gone', machine_id: 'mx' }), account({ id: 'b', machine_id: 'm1' })] });
    render(<AiAccountsView />);
    await screen.findAllByRole('listitem');
    expect(sections().map((s) => s.getAttribute('aria-label'))).toEqual(['mac', 'Máquina desconhecida']);
  });

  it('starts open, collapses on click and remembers it per machine', async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'a', machine_id: 'm1' }), account({ id: 'b', machine_id: 'm3' })] });
    render(<AiAccountsView />);
    await screen.findAllByRole('listitem');
    const toggle = toggleOf('mac');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(screen.getByRole('region', { name: 'mac' })).queryByRole('listitem')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'hulk' })).getAllByRole('listitem')).toHaveLength(1);

    cleanup();
    render(<AiAccountsView />);
    await screen.findAllByRole('listitem');
    expect(toggleOf('mac')).toHaveAttribute('aria-expanded', 'false');
    expect(toggleOf('hulk')).toHaveAttribute('aria-expanded', 'true');
  });

  it("adds an account from a section with that section's machine already chosen", async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'a', machine_id: 'm1' }), account({ id: 'b', machine_id: 'm3' })] });
    render(<AiAccountsView />);
    await screen.findAllByRole('listitem');
    fireEvent.click(within(screen.getByRole('region', { name: 'hulk' })).getByRole('button', { name: 'Adicionar conta em hulk' }));
    const form = within(screen.getByRole('dialog'));
    expect(form.getByLabelText('Máquina onde o CLI está logado')).toHaveValue('m3');
    fireEvent.click(form.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ machine_id: 'm3' })));
  });

  it('still edits an account from inside its section', async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'b', machine_id: 'm3' })] });
    render(<AiAccountsView />);
    fireEvent.click(await within(await screen.findByRole('region', { name: 'hulk' })).findByTitle('Editar'));
    expect(within(screen.getByRole('dialog')).getByLabelText('Máquina onde o CLI está logado')).toHaveValue('m3');
  });
});

describe('AiAccountsView: accounts exclusive to a project (TER-990)', () => {
  it('shows the badge on the card', async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'drh', exclusive_project: { id: 'p9', name: 'DR Horton' } }), account({ id: 'free' })] });
    render(<AiAccountsView />);
    const [drh, free] = await screen.findAllByRole('listitem');
    expect(within(drh).getByText('Exclusiva: DR Horton')).toBeInTheDocument();
    expect(free).not.toHaveTextContent('Exclusiva');
  });

  it('marks an account exclusive from its form, and only sends the field when it changed', async () => {
    listMock.mockResolvedValue({ accounts: [account({ id: 'drh' })] });
    render(<AiAccountsView />);
    fireEvent.click(await screen.findByTitle('Editar'));
    let form = within(screen.getByRole('dialog'));
    expect(form.getByLabelText('Exclusiva de um projeto')).toHaveValue('');
    fireEvent.click(form.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('drh', { label: 'drh', machine_id: 'm1', config_dir: null }));
    fireEvent.click(await screen.findByTitle('Editar'));
    form = within(screen.getByRole('dialog'));
    fireEvent.change(form.getByLabelText('Exclusiva de um projeto'), { target: { value: 'p9' } });
    fireEvent.click(form.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateMock).toHaveBeenLastCalledWith('drh', { label: 'drh', machine_id: 'm1', config_dir: null, exclusive_project_id: 'p9' }));
  });

  it('a new account is created free, then marked exclusive', async () => {
    const form = await openNew();
    fireEvent.change(form.getByLabelText('Exclusiva de um projeto'), { target: { value: 'p9' } });
    fireEvent.click(form.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('new', { exclusive_project_id: 'p9' }));
    expect(createMock).toHaveBeenCalledWith({ provider: 'claude', label: 'Claude', machine_id: 'm1', config_dir: null });
  });
});
