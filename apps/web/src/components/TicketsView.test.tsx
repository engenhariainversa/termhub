// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Integration, Project, ProjectSetup, Ticket } from '../lib/types';

const listMock = vi.fn();
const integrationsListMock = vi.fn();
const setupGetMock = vi.fn();
const syncTicketsMock = vi.fn();
const importMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      tickets: { list: (...a: unknown[]) => listMock(...a), import: (...a: unknown[]) => importMock(...a) },
      integrations: { list: (...a: unknown[]) => integrationsListMock(...a) },
      setup: { get: (...a: unknown[]) => setupGetMock(...a), syncTickets: (...a: unknown[]) => syncTicketsMock(...a) },
    },
  };
});

vi.mock('../lib/data', () => ({
  useData: () => ({ refresh: () => Promise.resolve() }),
}));

import { TicketsView } from './TicketsView';

const ticket = (over: Partial<Ticket> & { id: string; key: string }): Ticket => ({
  project_id: 'p1',
  integration_id: 'gh',
  provider: 'github',
  sync_key: over.key,
  scope: null,
  title: 'title',
  description: null,
  url: 'https://x',
  state: 'open',
  status: 'backlog',
  meta: {},
  task_id: null,
  synced_at: '',
  created_at: '',
  ...over,
});

const t1 = ticket({ id: 't1', key: 'acme/api#1', integration_id: 'gh', provider: 'github', scope: 'acme/api', title: 'Bug no login' });
const t2 = ticket({ id: 't2', key: 'EI-2', integration_id: 'li', provider: 'linear', scope: 'EI', title: 'Nova tela' });

const integrations: Integration[] = [
  { id: 'gh', provider: 'github', name: 'GitHub principal', config: {}, owner_id: null, created_at: '', updated_at: '' },
  { id: 'li', provider: 'linear', name: 'Linear time', config: {}, owner_id: null, created_at: '', updated_at: '' },
];

const setup: ProjectSetup = {
  project_id: 'p1',
  version: 2,
  data: {
    repo: null,
    tickets: null,
    ticket_sources: [
      { provider: 'github', integration_id: 'gh', scope: 'acme/api', filter: null, sync_minutes: 0 },
      { provider: 'linear', integration_id: 'li', scope: 'EI', filter: null, sync_minutes: 0 },
    ],
    runner: { machine_id: null, cwd: null, setup_command: null, worktree: true },
    agent: { command: 'claude', plugins: [], model: null, extra_args: null },
    verify: { type: 'none', target: null, build_command: null },
    approvals: { spec: 'ask', plan: 'ask', pr: 'ask', merge: 'ask', tool_permissions: 'ask', questions: 'ask' },
  },
  updated_at: null,
};

const project = { id: 'p1', key: 'P1', name: 'p1' } as Project;

const mount = () =>
  render(
    <MemoryRouter>
      <TicketsView project={project} />
    </MemoryRouter>,
  );

beforeEach(() => {
  listMock.mockResolvedValue({ tickets: [t1, t2] });
  integrationsListMock.mockResolvedValue({ integrations });
  setupGetMock.mockResolvedValue({ setup });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TicketsView', () => {
  it("shows each ticket's title with its key underneath", async () => {
    mount();
    expect(await screen.findByText('Bug no login')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'acme/api#1' })).toBeInTheDocument();
    expect(screen.getByText('Nova tela')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'EI-2' })).toBeInTheDocument();
  });

  it("choosing EI in the source select leaves only EI-2's ticket", async () => {
    mount();
    await screen.findByText('Bug no login');
    fireEvent.click(screen.getByRole('button', { name: 'Fonte' }));
    fireEvent.click(screen.getByRole('option', { name: 'EI' }));
    expect(screen.queryByText('Bug no login')).not.toBeInTheDocument();
    expect(screen.getByText('Nova tela')).toBeInTheDocument();
  });

  it('shows the truncation warning once a source syncs over 500 tickets', async () => {
    syncTicketsMock.mockResolvedValue({
      ok: true,
      sources: [{ provider: 'linear', integration_id: 'li', scope: 'EI', truncated: true, fetched: 500 }],
      synced_at: '',
      cached: false,
    });
    mount();
    await screen.findByText('Bug no login');
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar' }));
    expect(await screen.findByText('EI tem mais de 500 tickets abertos; a lista está incompleta.')).toBeInTheDocument();
  });
});
