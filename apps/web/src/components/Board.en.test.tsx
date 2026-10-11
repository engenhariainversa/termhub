// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import type { Project, Task, TaskColumn } from '../lib/types';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      tasks: { list: mocks.list, create: vi.fn(), move: vi.fn() },
      columns: { create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), setAgent: vi.fn() },
    },
  };
});
vi.mock('../lib/data', () => ({ useData: () => ({ setOpenTasks: () => {} }) }));

import { BacklogView } from './BacklogView';
import { BoardColumnsSettings } from './BoardColumnsSettings';

const col = (id: string, name: string, category: TaskColumn['category'], position: number): TaskColumn => ({ id, project_id: 'p1', name, category, position, created_at: '' });
const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 9, ref: `P1-${over.id}`, title: over.id, description: null, status: 'backlog', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: null, created_at: '', updated_at: '', ...over,
});

beforeEach(() => {
  void i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  void i18n.changeLanguage('pt-BR');
});

describe('board screens in English', () => {
  it('shows the board columns settings in English, keeping the column names as the user wrote them', async () => {
    // column names are user data: "A fazer" stays "A fazer", while its type (a termhub word) is translated
    mocks.list.mockResolvedValue({
      tasks: [{ id: 'a', column_id: 'c2', parent_id: null }, { id: 'b', column_id: 'c2', parent_id: null }],
      columns: [col('c1', 'A fazer', 'todo', 0), col('c2', 'QA', 'doing', 1), col('c4', 'Fazendo', 'doing', 2), col('c3', 'Feito', 'done', 3)],
      agent_column_id: null,
    });
    render(<BoardColumnsSettings project={{ id: 'p1', name: 'p1' } as Project} />);
    expect(await screen.findByRole('heading', { name: 'Board columns' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('A fazer')).toBeInTheDocument();
    const typeSelect = screen.getByRole('combobox', { name: 'Type of column A fazer' });
    expect(within(typeSelect).getByRole('option', { name: 'To do' })).toBeInTheDocument();
    expect(within(typeSelect).getByRole('option', { name: 'In progress' })).toBeInTheDocument();
    expect(typeSelect).toHaveAttribute('title', 'The board needs at least one column of each type');
    expect(screen.getByRole('option', { name: 'Automatic (first In progress)' })).toBeInTheDocument();
    expect(screen.getByText(/takes up to 12\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete QA' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2 cards go to "Fazendo"\./)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('shows the backlog in English with the type names translated', async () => {
    mocks.list.mockResolvedValue({
      columns: [],
      agent_column_id: null,
      tasks: [task({ id: 'e1', title: 'Geral', number: 1, ref: 'P1-1', type: 'epic', epic_id: null }), task({ id: 'fix login', type: 'bug' })],
    });
    render(
      <MemoryRouter>
        <BacklogView projectId="p1" />
      </MemoryRouter>,
    );
    const section = await screen.findByRole('region', { name: 'Geral' });
    await act(async () => {});
    expect(within(section).getByText('0/0 done')).toBeInTheDocument();
    expect(within(section).getByRole('img', { name: 'Bug' })).toBeInTheDocument();
    expect(within(section).getByRole('img', { name: 'Epic' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Send to the board' })).toBeInTheDocument();
    expect(within(section).getByRole('combobox', { name: 'Item type' })).toHaveDisplayValue('Task');
    expect(screen.getByRole('button', { name: '+ New epic' })).toBeInTheDocument();
  });
});
