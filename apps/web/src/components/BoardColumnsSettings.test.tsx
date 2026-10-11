// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task, TaskColumn } from '../lib/types';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), setAgent: vi.fn() }));
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
      tasks: { list: mocks.list },
      columns: { create: mocks.create, update: mocks.update, move: mocks.move, remove: mocks.remove, setAgent: mocks.setAgent },
    },
  };
});

import { ApiError } from '../lib/api';
import { BoardColumnsSettings } from './BoardColumnsSettings';
import { actRightAfterCommit } from '../test-commit';

const col = (id: string, name: string, category: TaskColumn['category'], position: number): TaskColumn => ({ id, project_id: 'p1', name, category, position, created_at: '' });
const columns = [col('c1', 'A fazer', 'todo', 0), col('c2', 'Fazendo', 'doing', 1), col('c4', 'QA', 'doing', 2), col('c3', 'Feito', 'done', 3)];
const card = (id: string, column_id: string) => ({ id, column_id, parent_id: null }) as Task;
const project = { id: 'p1', name: 'p1' } as Project;

beforeEach(() => {
  mocks.list.mockResolvedValue({ tasks: [card('a', 'c4'), card('b', 'c4'), card('x', 'c1')], columns, agent_column_id: null });
  for (const m of [mocks.create, mocks.update, mocks.move, mocks.remove, mocks.setAgent]) m.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * Every change reloads the block: the component calls the API, then lists the columns again and sets
 * its state. A test that ends on the API call leaves that reload for after `cleanup()`, and one that
 * goes on to the next action races it. `calls` is how many times the list has been asked for by then:
 * one for the first render, one more for each action.
 */
const reloaded = async (calls = 2) => {
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls));
  await act(async () => {}); // the reload's own setState lands inside act
};

describe('BoardColumnsSettings', () => {
  it('lists the columns in order and locks the last column of each category', async () => {
    render(<BoardColumnsSettings project={project} />);
    expect(await screen.findByDisplayValue('QA')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: /^Nome da coluna / }).map((i) => (i as HTMLInputElement).value)).toEqual(['A fazer', 'Fazendo', 'QA', 'Feito']);
    expect(screen.getByLabelText('Tipo da coluna A fazer')).toBeDisabled();
    expect(screen.getByLabelText('Tipo da coluna QA')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Excluir Feito' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Subir A fazer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Descer Feito' })).toBeDisabled();
  });

  it('renames on blur', async () => {
    render(<BoardColumnsSettings project={project} />);
    const qa = await screen.findByDisplayValue('QA');
    fireEvent.change(qa, { target: { value: 'Em revisão' } });
    fireEvent.blur(qa);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('c4', { name: 'Em revisão' }));
    await reloaded();
  });

  it('keeps a name typed the moment the columns appear', async () => {
    render(<BoardColumnsSettings project={project} />);
    await actRightAfterCommit(
      () => !!screen.queryByDisplayValue('QA'),
      () => fireEvent.change(screen.getByDisplayValue('QA'), { target: { value: 'Em revisão' } }),
    );
    await act(async () => {});
    const input = screen.getByDisplayValue('Em revisão');
    fireEvent.blur(input);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('c4', { name: 'Em revisão' }));
    await reloaded();
  });

  it('does not rename when the name did not change', async () => {
    render(<BoardColumnsSettings project={project} />);
    const qa = await screen.findByDisplayValue('QA');
    fireEvent.blur(qa);
    await act(async () => {});
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('changes a category', async () => {
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.change(screen.getByLabelText('Tipo da coluna Fazendo'), { target: { value: 'todo' } });
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('c2', { category: 'todo' }));
    await reloaded();
  });

  it('moves a column', async () => {
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.click(screen.getByRole('button', { name: 'Subir QA' }));
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith('c4', 1));
    await reloaded();
  });

  it('says how many cards move and where before deleting', async () => {
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir QA' }));
    expect(screen.getByText(/2 cards vão para "Fazendo"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('c4'));
    await reloaded();
  });

  it('adds a column and sets the agent column', async () => {
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.change(screen.getByLabelText('Nome da nova coluna'), { target: { value: ' Bloqueado ' } });
    fireEvent.change(screen.getByLabelText('Tipo da nova coluna'), { target: { value: 'doing' } });
    fireEvent.click(screen.getByRole('button', { name: '+ coluna' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('p1', { name: 'Bloqueado', category: 'doing' }));
    await reloaded();
    const agent = screen.getByLabelText('Coluna do agente') as HTMLSelectElement;
    expect(agent.options[0].textContent).toBe('Automática (primeira Fazendo)');
    // only doing columns are offered
    expect(Array.from(agent.options).map((o) => o.textContent)).toEqual(['Automática (primeira Fazendo)', 'Fazendo', 'QA']);
    fireEvent.change(agent, { target: { value: 'c4' } });
    await waitFor(() => expect(mocks.setAgent).toHaveBeenCalledWith('p1', 'c4'));
    await reloaded(3);
  });

  it('shows the server refusal', async () => {
    mocks.remove.mockRejectedValueOnce(new ApiError(409, 'O board precisa de ao menos uma coluna de cada tipo'));
    render(<BoardColumnsSettings project={project} />);
    await screen.findByDisplayValue('QA');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir QA' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    expect(await screen.findByText('O board precisa de ao menos uma coluna de cada tipo')).toBeInTheDocument();
    await reloaded();
  });
});
