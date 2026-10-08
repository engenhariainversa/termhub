// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Integration, Project, ProjectSetupData } from '../lib/types';

const getMock = vi.fn();
const saveMock = vi.fn();
const integrationsListMock = vi.fn();
const syncTicketsMock = vi.fn();

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
        test: () => Promise.resolve({ ok: true, options: {} }),
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

const mount = () => render(<SetupForm project={project} />);

beforeEach(() => {
  getMock.mockResolvedValue({ setup: { project_id: 'p1', version: 2, data: setupData(), updated_at: null } });
  integrationsListMock.mockResolvedValue({ integrations: [integration] });
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
    const scopeInputs = screen.getAllByPlaceholderText('owner/repo');
    expect(scopeInputs).toHaveLength(2);
    expect((scopeInputs[1] as HTMLInputElement).value).toBe('');
  });

  it('typing a scope that repeats another source shows "Fonte repetida" and disables Salvar', async () => {
    mount();
    await screen.findByRole('button', { name: 'Adicionar fonte' });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar fonte' }));
    const scopeInputs = screen.getAllByPlaceholderText('owner/repo');
    fireEvent.change(scopeInputs[1], { target: { value: 'acme/api' } });
    expect(await screen.findByText('Fonte repetida')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar setup' })).toBeDisabled();
  });

  it('"Remover" on the second row removes just that row', async () => {
    mount();
    await screen.findByRole('button', { name: 'Adicionar fonte' });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar fonte' }));
    expect(screen.getAllByRole('button', { name: 'Remover' })).toHaveLength(2);
    const removeButtons = screen.getAllByRole('button', { name: 'Remover' });
    fireEvent.click(removeButtons[1]);
    expect(screen.getAllByRole('button', { name: 'Remover' })).toHaveLength(1);
    expect(screen.getAllByPlaceholderText('owner/repo')).toHaveLength(1);
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

  it('hides the option for a server that does not know it', async () => {
    mount();
    await screen.findByRole('button', { name: 'Adicionar fonte' });
    expect(screen.queryByRole('checkbox', { name: 'Publicar regras vigentes no ai-memory' })).not.toBeInTheDocument();
  });
});
