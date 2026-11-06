// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatBlock } from '../lib/types';

const listMock = vi.fn();
const createMock = vi.fn();
const deleteMock = vi.fn();
const setDefaultMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      listChatBlocks: () => listMock(),
      createChatBlock: (input: unknown) => createMock(input),
      deleteChatBlock: (id: string) => deleteMock(id),
      setChatDefault: (kind: string, allowed: boolean) => setDefaultMock(kind, allowed),
      projects: { list: async () => ({ projects: [{ id: 'p1', name: 'piki', status: 'active' }, { id: 'p2', name: 'old', status: 'archived' }] }) },
      chatMemory: async () => { throw new Error('not in this test'); },
    },
  };
});

import { ChatBlocksView } from './ChatBlocksView';

const block = (o: Partial<ChatBlock> & { id: string }): ChatBlock => ({ kind: 'board', project_id: null, project_name: null, words: [], effect: 'ask', source: 'block', created_at: '2026-11-06T10:00:00.000Z', ...o });

beforeEach(() => {
  listMock.mockReset();
  createMock.mockReset().mockResolvedValue({ block: block({ id: 'b9' }) });
  deleteMock.mockReset().mockResolvedValue({ block: { id: 'b1', revoked_at: 'x' } });
  setDefaultMock.mockReset().mockResolvedValue({ defaults: [] });
});
afterEach(() => cleanup());

it('shows the fixed core and the blocks, a command block and a restricted default among them', async () => {
  listMock.mockResolvedValue({ blocks: [block({ id: 'b1', kind: 'run_command', words: ['git', 'push'], project_id: 'p1', project_name: 'piki', effect: 'never' }), block({ id: 'restriction:terminal', kind: 'terminal', source: 'restriction' })] });
  render(<ChatBlocksView />);
  const list = await screen.findByRole('region', { name: 'Bloqueios' });
  expect(within(list).getByText('Rodar «git push…»')).toBeInTheDocument();
  expect(within(list).getByText('no projeto piki · nunca')).toBeInTheDocument();
  expect(within(list).getByText('em todos os projetos · pedir antes · desmarcado antes em Liberadas por padrão')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Sempre pedem confirmação' })).toHaveTextContent('git push --force');
});

it('lifts a block, and a restricted default by turning it back on', async () => {
  listMock.mockResolvedValue({ blocks: [block({ id: 'b1' }), block({ id: 'restriction:terminal', kind: 'terminal', source: 'restriction' })] });
  render(<ChatBlocksView />);
  const buttons = await screen.findAllByRole('button', { name: 'Tirar' });
  fireEvent.click(buttons[0]!);
  await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('b1'));
  fireEvent.click(buttons[1]!);
  await waitFor(() => expect(setDefaultMock).toHaveBeenCalledWith('terminal', true));
});

it('adds a command block for one project; archived projects are not offered', async () => {
  listMock.mockResolvedValue({ blocks: [] });
  render(<ChatBlocksView />);
  expect(await screen.findByText('Nenhum bloqueio: o chat faz tudo o que não está na lista acima sem pedir.')).toBeInTheDocument();
  await screen.findByRole('option', { name: 'piki' });
  expect(screen.queryByRole('option', { name: 'old' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'git push' } });
  fireEvent.change(screen.getByLabelText('Onde'), { target: { value: 'p1' } });
  fireEvent.change(screen.getByLabelText('Efeito'), { target: { value: 'never' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar bloqueio' }));
  await waitFor(() => expect(createMock).toHaveBeenCalledWith({ kind: 'run_command', project_id: 'p1', command: 'git push', effect: 'never' }));
});

it('adds a block for every project without a command for another kind', async () => {
  listMock.mockResolvedValue({ blocks: [] });
  render(<ChatBlocksView />);
  fireEvent.change(await screen.findByLabelText('O chat não pode'), { target: { value: 'board' } });
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar bloqueio' }));
  await waitFor(() => expect(createMock).toHaveBeenCalledWith({ kind: 'board', project_id: null, effect: 'ask' }));
});
