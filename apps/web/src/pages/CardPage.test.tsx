// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationFeedEvent, Tab, Task, TaskColumn } from '../lib/types';

const byRefMock = vi.fn();
const listMock = vi.fn();
const activityMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      tasks: {
        byRef: (...a: unknown[]) => byRefMock(...a),
        list: (...a: unknown[]) => listMock(...a),
        activity: (...a: unknown[]) => activityMock(...a),
      },
    },
  };
});
vi.mock('../lib/data', () => ({ useData: () => ({ projects: [{ id: 'p1', key: 'TER', name: 'termhub' }] }) }));
let openTabs: Tab[] = [];
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ openTabs }) }));
// their own requests; not this page's concern
vi.mock('../components/CardPullRequests', () => ({ CardPullRequests: ({ taskId }: { taskId: string }) => <div>prs {taskId}</div> }));
vi.mock('../components/UsageCost', () => ({ CardUsageCost: () => null }));

import { ApiError } from '../lib/api';
import { CardPage } from './CardPage';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 12, ref: 'TER-12', title: over.id, description: null, status: 'doing', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c2', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-02T10:00:00Z', ...over,
});
const columns: TaskColumn[] = [
  { id: 'c1', project_id: 'p1', name: 'A fazer', category: 'todo', position: 0, created_at: '' },
  { id: 'c2', project_id: 'p1', name: 'Em revisão', category: 'doing', position: 1, created_at: '' },
];
const epic = task({ id: 'e1', type: 'epic', number: 1, ref: 'TER-1', title: 'Board', epic_id: null, column_id: null, status: 'backlog' });
const card = task({
  id: 'k12',
  title: 'Board pisca',
  type: 'bug',
  description: '## O que fazer\n\nAbrir **sem** piscar.',
  tab_id: 'tab1',
  external_ref: { provider: 'linear', key: 'EI-7', url: 'https://linear.app/x/EI-7', state: 'In Progress', status: 'doing', pushed_at: null } as Task['external_ref'],
  subtasks: [
    task({ id: 's2', ref: 'TER-14', title: 'segunda', type: 'subtask', parent_id: 'k12', status: 'todo', position: 1, epic_id: null, column_id: null }),
    task({ id: 's1', ref: 'TER-13', title: 'primeira', type: 'subtask', parent_id: 'k12', status: 'done', position: 0, epic_id: null, column_id: null }),
  ],
});
const event: AutomationFeedEvent = {
  id: 'v1', kind: 'pr_opened', created_at: new Date().toISOString(), project_id: 'p1', task_id: 'k12', run_id: 'run123456',
  tab_id: null, ref: 'TER-12', epic: 'Board', machine: 'jarvis', account: null, branch: 'b1', workflow: null, version: null, pr: 9, url: 'https://gh/pr/9', until: null, paused: null, reason_text: null,
};

function mount(ref: string) {
  render(
    <MemoryRouter initialEntries={[`/project/${ref}`]}>
      <Routes>
        <Route path="/project/:ref" element={<CardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  openTabs = [{ id: 'tab1', name: 'claude TER-12', project_id: 'p1', machine_id: 'm1', kind: 'terminal' } as Tab];
  listMock.mockResolvedValue({ tasks: [epic, card], columns, agent_column_id: null });
  activityMock.mockResolvedValue({ events: [event] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CardPage — the card\'s own page', () => {
  it('shows the card: title, rendered description, type, epic, column, ticket, tab and subtasks', async () => {
    byRefMock.mockResolvedValue({ task: card, project_id: 'p1' });
    mount('ter-12');
    expect(await screen.findByRole('heading', { name: 'TER-12 Board pisca' })).toBeInTheDocument();
    expect(byRefMock).toHaveBeenCalledWith('ter-12');
    expect(screen.getByRole('heading', { name: 'O que fazer' })).toBeInTheDocument();
    expect(screen.getByText('sem').tagName).toBe('STRONG');
    expect(screen.getByRole('img', { name: 'Bug' })).toBeInTheDocument();
    expect(screen.getByText('TER-1 Board')).toBeInTheDocument();
    expect(screen.getByText('Em revisão')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'EI-7' })).toHaveAttribute('href', 'https://linear.app/x/EI-7');
    expect(screen.getByRole('link', { name: 'claude TER-12' })).toHaveAttribute('href', '/projects/p1?tab=tab1');
    const subtasks = within(screen.getByRole('region', { name: 'Subtarefas' }));
    expect(subtasks.getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('primeira'), expect.stringContaining('segunda')]);
    expect(subtasks.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('prs k12')).toBeInTheDocument();
  });

  it('links to the Board with the card open (?card=)', async () => {
    byRefMock.mockResolvedValue({ task: card, project_id: 'p1' });
    mount('TER-12');
    expect(await screen.findByRole('link', { name: 'Abrir no board' })).toHaveAttribute('href', '/projects/p1/tasks?card=TER-12');
  });

  it('lists what the automatic work did on the card', async () => {
    byRefMock.mockResolvedValue({ task: card, project_id: 'p1' });
    mount('TER-12');
    const feed = await screen.findByRole('region', { name: 'Automático' });
    expect(activityMock).toHaveBeenCalledWith('k12');
    expect(within(feed).getByRole('link', { name: 'PR #9' })).toHaveAttribute('href', 'https://gh/pr/9');
  });

  it('a subtask\'s ref shows its parent card', async () => {
    byRefMock.mockResolvedValue({ task: card.subtasks![1], project_id: 'p1' });
    mount('TER-13');
    expect(await screen.findByRole('heading', { name: 'TER-12 Board pisca' })).toBeInTheDocument();
  });

  it('stands without a description or the automatic events', async () => {
    const bare = task({ id: 'k5', ref: 'TER-5', title: 'Simples' });
    listMock.mockResolvedValue({ tasks: [epic, bare], columns, agent_column_id: null });
    activityMock.mockRejectedValue(new Error('offline'));
    byRefMock.mockResolvedValue({ task: bare, project_id: 'p1' });
    mount('TER-5');
    expect(await screen.findByText('Sem descrição.')).toBeInTheDocument();
    expect(screen.getByText('nenhuma aba ligada')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Automático' })).not.toBeInTheDocument();
  });

  it('says "Card não encontrado" for an unknown ref or one outside the scope', async () => {
    byRefMock.mockRejectedValue(new ApiError(404, 'Card não encontrado'));
    mount('TER-99');
    expect(await screen.findByText('Card não encontrado')).toBeInTheDocument();
  });

  it('says so when the lookup fails for another reason', async () => {
    byRefMock.mockRejectedValue(new ApiError(500, 'Erro interno'));
    mount('TER-1');
    expect(await screen.findByText('Erro ao abrir o card')).toBeInTheDocument();
  });
});
