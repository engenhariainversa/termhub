// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../lib/types';

const listMock = vi.fn();
const createMock = vi.fn();
const moveMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: { tasks: { list: (...a: unknown[]) => listMock(...a), create: (...a: unknown[]) => createMock(...a), move: (...a: unknown[]) => moveMock(...a) } },
  };
});
vi.mock('../lib/data', () => ({ useData: () => ({ setOpenTasks: () => {} }) }));

import { BacklogView } from './BacklogView';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 9, ref: `P1-${over.id}`, title: over.id, description: null, status: 'backlog', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: null, created_at: '', updated_at: '', ...over,
});
const epic = (id: string, title: string, number: number) => task({ id, title, number, ref: `P1-${number}`, type: 'epic', epic_id: null });

function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{`${l.pathname}${l.search}|${(l.state as { boardCard?: boolean } | null)?.boardCard ? 'pushed' : ''}`}</output>;
}

function mount() {
  render(
    <MemoryRouter initialEntries={['/projects/p1/backlog']}>
      <BacklogView projectId="p1" />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listMock.mockResolvedValue({
    columns: [],
    agent_column_id: null,
    tasks: [
      epic('e2', 'Checkout', 5),
      epic('e1', 'Geral', 1),
      task({ id: 'second', position: 1 }),
      task({ id: 'first', position: 0, type: 'bug' }),
      task({ id: 'on board', status: 'done', column_id: 'c3' }),
      task({ id: 'doing', status: 'doing', column_id: 'c2' }),
      task({ id: 'pay', epic_id: 'e2', type: 'story' }),
    ],
  });
  moveMock.mockResolvedValue({ task: task({ id: 'first' }) });
  createMock.mockResolvedValue({ task: task({ id: 'new' }) });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BacklogView', () => {
  it('groups backlog items by epic, the default epic first, with progress over the board', async () => {
    mount();
    await screen.findByText('first');
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Geral', 'Checkout']);
    const geral = screen.getByRole('region', { name: 'Geral' });
    expect(within(geral).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('first'), expect.stringContaining('second')]);
    expect(within(geral).getByText('1/2 feitas')).toBeInTheDocument();
    expect(within(geral).queryByText('on board')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Checkout' })).getByText('pay')).toBeInTheDocument();
  });

  it('sends an item to the board (first A fazer column)', async () => {
    mount();
    await screen.findByText('first');
    const row = screen.getByText('first').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Enviar para o board' }));
    await waitFor(() => expect(moveMock).toHaveBeenCalledWith('first', { status: 'todo' }, 0));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('opens a card on the Board (?card=), in a history entry that closing goes back from', async () => {
    mount();
    await screen.findByText('first');
    fireEvent.click(within(screen.getByText('first').closest('li')!).getByRole('button', { name: 'Abrir' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks?card=P1-first|pushed');
  });

  it('adds an item of the chosen type to that epic', async () => {
    mount();
    await screen.findByText('pay');
    const section = screen.getByRole('region', { name: 'Checkout' });
    fireEvent.change(within(section).getByLabelText('Tipo do item'), { target: { value: 'bug' } });
    const input = within(section).getByPlaceholderText('+ item (Enter)');
    fireEvent.change(input, { target: { value: 'crash' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(createMock).toHaveBeenCalledWith('p1', { title: 'crash', type: 'bug', epic_id: 'e2', status: 'backlog' }));
  });

  it('creates a new epic', async () => {
    mount();
    await screen.findByText('first');
    fireEvent.click(screen.getByRole('button', { name: '+ Novo épico' }));
    fireEvent.change(screen.getByLabelText('Título do épico'), { target: { value: 'Pagamentos' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith('p1', { title: 'Pagamentos', type: 'epic', status: 'backlog' }));
  });

  it('reorders by dropping inside the section', async () => {
    mount();
    await screen.findByText('first');
    const [firstRow, secondRow] = within(screen.getByRole('region', { name: 'Geral' })).getAllByRole('listitem');
    const dataTransfer = { effectAllowed: '', setData: vi.fn() };
    fireEvent.dragStart(secondRow, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'second');
    fireEvent.drop(firstRow, { dataTransfer });
    await waitFor(() => expect(moveMock).toHaveBeenCalledWith('second', { status: 'backlog' }, 0));
  });
});
