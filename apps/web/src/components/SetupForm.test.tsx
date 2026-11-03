// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Integration, Project, ProjectSetupData } from '../lib/types';

const getMock = vi.fn();
const saveMock = vi.fn();
const integrationsListMock = vi.fn();
const syncTicketsMock = vi.fn();
const testMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      setup: {
        get: (...a: unknown[]) => getMock(...a),
        save: (...a: unknown[]) => saveMock(...a),
        syncTickets: (...a: unknown[]) => syncTicketsMock(...a),
        // the project's AI accounts card (TER-589): nothing configured, nothing available
        ai: { get: () => Promise.resolve({ ai: { accounts: [], models: { claude: null, chatgpt: null } }, available: [] }), save: () => Promise.reject(new Error('unused')) },
      },
      integrations: {
        list: (...a: unknown[]) => integrationsListMock(...a),
        test: (...a: unknown[]) => testMock(...a),
      },
    },
  };
});

vi.mock('../lib/data', () => ({
  useData: () => ({ machines: [], refresh: () => {} }),
}));

import { SetupForm } from './SetupForm';

const source0 = { provider: 'github' as const, integration_id: 'g', scope: 'acme/api', filter: null, sync_minutes: 0 };

const setupData = (over: Partial<ProjectSetupData> = {}): ProjectSetupData => ({
  repo: null,
  tickets: { ...source0, include_done: false },
  ticket_sources: [source0],
  runner: { machine_id: null, cwd: null, setup_command: null, worktree: true },
  agent: { command: 'claude', plugins: ['superpowers'], model: null, extra_args: null },
  verify: { type: 'none', target: null, build_command: null },
  approvals: { spec: 'ask', plan: 'ask', pr: 'ask', merge: 'ask', tool_permissions: 'ask', questions: 'ask' },
  ...over,
});

const integration: Integration = { id: 'g', provider: 'github', name: 'GitHub principal', config: {}, owner_id: null, created_at: '', updated_at: '' };

const project = { id: 'p1', key: 'P1', name: 'p1', machines: [] } as unknown as Project;

/** Native selects are comboboxes too: this is the open field's filter. */
const scopeFilter = () => screen.getByRole('combobox', { name: 'Filtrar: Repositório' });

const mount = () => render(<SetupForm project={project} />);

beforeEach(() => {
  getMock.mockResolvedValue({ setup: { project_id: 'p1', version: 2, data: setupData(), updated_at: null } });
  integrationsListMock.mockResolvedValue({ integrations: [integration] });
  testMock.mockResolvedValue({ ok: true, options: {} });
  saveMock.mockImplementation((_id: string, data: ProjectSetupData) => Promise.resolve({ setup: { project_id: 'p1', version: 2, data, updated_at: 'now' } }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SetupForm — ticket sources', () => {
  it('"Adicionar fonte" appends a second source row using the only integration', async () => {
    mount();
    await screen.findByText('Fontes das tarefas: tickets abertos de cada fonte aparecem em Tickets; os que você escolher entram no backlog do épico padrão.');
    expect(screen.getAllByRole('button', { name: 'Remover' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar fonte' }));
    expect(screen.getAllByRole('button', { name: 'Remover' })).toHaveLength(2);
    const scopes = screen.getAllByRole('button', { name: 'Repositório' });
    expect(scopes).toHaveLength(2);
    expect(scopes[1]).toHaveTextContent('owner/repo');
  });

  it('typing a scope that repeats another source shows "Fonte repetida" and disables Salvar', async () => {
    mount();
    await screen.findByRole('button', { name: 'Adicionar fonte' });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar fonte' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Repositório' })[1]);
    fireEvent.change(scopeFilter(), { target: { value: 'acme/api' } });
    fireEvent.keyDown(scopeFilter(), { key: 'Enter' });
    expect(await screen.findByText('Fonte repetida')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar setup' })).toBeDisabled();
  });

  describe('the scope field', () => {
    const repos = [
      { id: 'the-door-app/ccroad', name: 'the-door-app/ccroad' },
      { id: 'a-supernova/financeiro', name: 'a-supernova/financeiro' },
      { id: 'a-supernova/financeiro-api', name: 'a-supernova/financeiro-api' },
    ];

    it('has no datalist: typing "fin" filters the listed repositories and Enter fills the field', async () => {
      testMock.mockResolvedValue({ ok: true, options: { repos } });
      mount();
      const field = await screen.findByRole('button', { name: 'Repositório' });
      expect(document.querySelector('datalist')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'listar' }));
      await waitFor(() => expect(testMock).toHaveBeenCalledTimes(1));
      fireEvent.click(field);
      expect(await screen.findByRole('option', { name: 'the-door-app/ccroad' })).toBeInTheDocument();
      expect(scopeFilter()).toHaveAttribute('autocomplete', 'off');
      fireEvent.change(scopeFilter(), { target: { value: 'fin' } });
      const listed = within(screen.getByRole('listbox')).getAllByRole('option');
      expect(listed.map((o) => o.textContent)).toEqual(['a-supernova/financeiro', 'a-supernova/financeiro-api', 'Usar "fin"']);
      fireEvent.keyDown(scopeFilter(), { key: 'Enter' });
      expect(field).toHaveTextContent('a-supernova/financeiro');
      expect(testMock).toHaveBeenCalledTimes(1);
    });

    it('loads the list the first time it opens, and a repository off the list can be typed', async () => {
      testMock.mockResolvedValue({ ok: true, options: { repos } });
      mount();
      const field = await screen.findByRole('button', { name: 'Repositório' });
      fireEvent.click(field);
      expect(await screen.findByRole('option', { name: 'a-supernova/financeiro' })).toBeInTheDocument();
      expect(testMock).toHaveBeenCalledTimes(1);
      fireEvent.change(scopeFilter(), { target: { value: 'owner/novo' } });
      fireEvent.keyDown(scopeFilter(), { key: 'Enter' });
      expect(field).toHaveTextContent('owner/novo');
    });

    it('shows why the list failed and still takes a typed repository', async () => {
      testMock.mockResolvedValue({ ok: false, error: 'token inválido' });
      mount();
      const field = await screen.findByRole('button', { name: 'Repositório' });
      fireEvent.click(field);
      expect(await screen.findByText('token inválido')).toBeInTheDocument();
      fireEvent.change(scopeFilter(), { target: { value: 'owner/novo' } });
      fireEvent.keyDown(scopeFilter(), { key: 'Enter' });
      expect(field).toHaveTextContent('owner/novo');
    });
  });

  it('"Remover" on the second row removes just that row', async () => {
    mount();
    await screen.findByRole('button', { name: 'Adicionar fonte' });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar fonte' }));
    expect(screen.getAllByRole('button', { name: 'Remover' })).toHaveLength(2);
    const removeButtons = screen.getAllByRole('button', { name: 'Remover' });
    fireEvent.click(removeButtons[1]);
    expect(screen.getAllByRole('button', { name: 'Remover' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Repositório' })).toHaveLength(1);
  });

  it('saving sends ticket_sources with the one configured source', async () => {
    mount();
    await screen.findByRole('button', { name: 'Adicionar fonte' });
    // touch something unrelated to ticket_sources so the form becomes dirty
    fireEvent.click(screen.getByRole('checkbox', { name: /Usar git worktree por run/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar setup' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const sentData = saveMock.mock.calls[0][1] as ProjectSetupData;
    expect(sentData.ticket_sources).toHaveLength(1);
    expect(sentData.ticket_sources[0]).toEqual(source0);
  });
});

describe('SetupForm — ai-memory (TER-1019)', () => {
  it('turns "Publicar regras vigentes no ai-memory" on and sends it', async () => {
    getMock.mockResolvedValue({ setup: { project_id: 'p1', version: 2, data: setupData({ ai_memory: { publish_rules: false } }), updated_at: null } });
    mount();
    const box = await screen.findByRole('checkbox', { name: 'Publicar regras vigentes no ai-memory' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar setup' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect((saveMock.mock.calls[0][1] as ProjectSetupData).ai_memory).toEqual({ publish_rules: true });
  });

  it('turns "Usar o ai-memory nas execuções do termhub" on and keeps publish_rules (TER-1020)', async () => {
    getMock.mockResolvedValue({ setup: { project_id: 'p1', version: 2, data: setupData({ ai_memory: { publish_rules: true, use_in_runs: false } }), updated_at: null } });
    mount();
    const box = await screen.findByRole('checkbox', { name: 'Usar o ai-memory nas execuções do termhub' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar setup' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect((saveMock.mock.calls[0][1] as ProjectSetupData).ai_memory).toEqual({ publish_rules: true, use_in_runs: true });
  });

  it('hides the option for a server that does not know it', async () => {
    mount();
    await screen.findByRole('button', { name: 'Adicionar fonte' });
    expect(screen.queryByRole('checkbox', { name: 'Publicar regras vigentes no ai-memory' })).not.toBeInTheDocument();
  });
});
