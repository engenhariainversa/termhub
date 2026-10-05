// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileDate, folderOf, RecentFiles } from './RecentFiles';
import { ApiError } from '../lib/api';
import type { FileRecentItem, FileRecentResponse } from '../lib/types';

const recentMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { fileRecent: (...a: unknown[]) => recentMock(...a) } };
});

const jarvis = { id: 'm1', name: 'jarvis' };
const mini = { id: 'm2', name: 'mini' };

const item = (over: Partial<FileRecentItem> = {}): FileRecentItem => ({
  machine: jarvis,
  path: '/home/p/repo/docs/superpowers/specs/a.md',
  rel_path: 'docs/superpowers/specs/a.md',
  name: 'a.md',
  size: 12 * 1024,
  mtime: new Date(Date.now() - 3 * 60_000).toISOString(),
  too_large: false,
  group: 'specs',
  cited: false,
  ...over,
});

const ITEMS: FileRecentItem[] = [
  item(),
  item({ path: '/home/p/repo/docs/superpowers/plans/b.md', rel_path: 'docs/superpowers/plans/b.md', name: 'b.md', group: 'plans', cited: true }),
  item({ path: '/home/p/repo/docs/lessons/c.md', rel_path: 'docs/lessons/c.md', name: 'c.md', group: 'lessons' }),
  item({ path: '/tmp/notes/d.md', rel_path: null, name: 'd.md', group: 'other', cited: true, too_large: true, size: 600 * 1024 }),
];

const response = (over: Partial<FileRecentResponse> = {}): FileRecentResponse => ({ items: ITEMS, skipped: [], ...over });

function renderView() {
  return render(
    <MemoryRouter>
      <RecentFiles projectId="p1" />
    </MemoryRouter>,
  );
}

const rowNames = () =>
  within(screen.getByRole('list', { name: 'Arquivos recentes' }))
    .getAllByRole('link')
    .map((a) => a.querySelector('span')?.textContent);

// Braces: an arrow that returned the mock would be run by vitest as a teardown, calling it once more.
beforeEach(() => {
  recentMock.mockReset();
});
afterEach(cleanup);

describe('RecentFiles', () => {
  it('asks for the project and lists the files in the order the server sent them', async () => {
    recentMock.mockResolvedValue(response());
    renderView();
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    await waitFor(() => expect(rowNames()).toEqual(['a.md', 'b.md', 'c.md', 'd.md']));
    expect(recentMock).toHaveBeenCalledWith('p1');
    // folder, size, relative date; one machine only, so no machine name
    expect(screen.getByText('docs/superpowers/specs')).toBeInTheDocument();
    expect(screen.getByText('/tmp/notes')).toBeInTheDocument();
    expect(screen.getAllByText('12 KB')).toHaveLength(3);
    expect(screen.getAllByText('há 3 min')).toHaveLength(4);
    expect(screen.queryByText('jarvis')).toBeNull();
    // badges
    expect(screen.getAllByText('citado')).toHaveLength(2);
    expect(screen.getAllByText('muito grande')).toHaveLength(1);
  });

  it('links each row to the preview tab: the project-relative path when there is one, else the absolute', async () => {
    recentMock.mockResolvedValue(response());
    renderView();
    await waitFor(() => expect(rowNames()).toHaveLength(4));
    const links = within(screen.getByRole('list', { name: 'Arquivos recentes' })).getAllByRole('link');
    expect(links[0].getAttribute('href')).toBe('/projects/p1?file=docs%2Fsuperpowers%2Fspecs%2Fa.md&machine=m1');
    expect(links[3].getAttribute('href')).toBe('/projects/p1?file=%2Ftmp%2Fnotes%2Fd.md&machine=m1');
  });

  it('shows the machine name when the files span more than one machine', async () => {
    recentMock.mockResolvedValue(response({ items: [item(), item({ machine: mini, name: 'z.md', path: '/Users/p/repo/z.md', rel_path: 'z.md', group: 'other' })] }));
    renderView();
    await waitFor(() => expect(rowNames()).toEqual(['a.md', 'z.md']));
    expect(screen.getByText('jarvis')).toBeInTheDocument();
    expect(screen.getByText('mini')).toBeInTheDocument();
    expect(screen.getByText('raiz do projeto')).toBeInTheDocument();
  });

  it('filters by group and by cited, with counts on the chips', async () => {
    recentMock.mockResolvedValue(response());
    renderView();
    await waitFor(() => expect(rowNames()).toHaveLength(4));
    expect(screen.getByRole('button', { name: /Todos/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Planos/ }));
    expect(screen.getByRole('button', { name: /Planos/ })).toHaveAttribute('aria-pressed', 'true');
    expect(rowNames()).toEqual(['b.md']);
    fireEvent.click(screen.getByRole('button', { name: /Citados pelas abas/ }));
    expect(rowNames()).toEqual(['b.md', 'd.md']);
    expect(screen.getByRole('button', { name: /Citados pelas abas/ }).textContent).toBe('Citados pelas abas2');
    fireEvent.click(screen.getByRole('button', { name: /Jurídico/ }));
    expect(screen.getByText('Nenhum arquivo neste filtro')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Outros/ }));
    expect(rowNames()).toEqual(['d.md']);
  });

  it('searches the name and the path', async () => {
    recentMock.mockResolvedValue(response());
    renderView();
    await waitFor(() => expect(rowNames()).toHaveLength(4));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar arquivo' }), { target: { value: 'C.MD' } });
    expect(rowNames()).toEqual(['c.md']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar arquivo' }), { target: { value: 'superpowers' } });
    expect(rowNames()).toEqual(['a.md', 'b.md']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar arquivo' }), { target: { value: '/tmp' } });
    expect(rowNames()).toEqual(['d.md']);
  });

  it('says which machines were left out and why', async () => {
    recentMock.mockResolvedValue(
      response({
        skipped: [
          { machine: { id: 'm2', name: 'mini' }, reason: 'outdated' },
          { machine: { id: 'm3', name: 'hp' }, reason: 'offline' },
          { machine: { id: 'm4', name: 'vps' }, reason: 'unsupported' },
          { machine: { id: 'm5', name: 'nova' }, reason: 'something-new' },
        ],
      }),
    );
    renderView();
    const notices = await screen.findByRole('list', { name: 'Máquinas fora da lista' });
    expect(within(notices).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Atualize o agente de mini para listar os arquivos dela',
      'hp está desconectada',
      'vps não usa o agente do termhub',
      'Não foi possível listar os arquivos de nova',
    ]);
  });

  it('says when there is no file', async () => {
    recentMock.mockResolvedValue(response({ items: [] }));
    renderView();
    expect(await screen.findByText('Nenhum arquivo .md encontrado')).toBeInTheDocument();
  });

  it('shows the error the server gave', async () => {
    recentMock.mockRejectedValue(new ApiError(404, 'Projeto não encontrado'));
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('Projeto não encontrado');
  });

  it('falls back to a generic message for an error that is not the server\'s', async () => {
    recentMock.mockRejectedValue(new Error('boom'));
    renderView();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar os arquivos.');
  });

  it('asks again on Atualizar and shows the new list', async () => {
    recentMock.mockResolvedValueOnce(response({ items: [item()] }));
    renderView();
    await waitFor(() => expect(rowNames()).toEqual(['a.md']));
    recentMock.mockResolvedValueOnce(response());
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(rowNames()).toEqual(['a.md', 'b.md', 'c.md', 'd.md']));
    expect(recentMock).toHaveBeenCalledTimes(2);
  });
});

describe('fileDate', () => {
  const now = new Date(2026, 9, 5, 15, 0).getTime();
  it('is relative within a day, "ontem" for the day before, else a short date', () => {
    expect(fileDate(new Date(2026, 9, 5, 14, 57).toISOString(), now)).toBe('há 3 min');
    expect(fileDate(new Date(2026, 9, 5, 10, 0).toISOString(), now)).toBe('há 5 h');
    expect(fileDate(new Date(2026, 9, 4, 9, 0).toISOString(), now)).toBe('ontem');
    expect(fileDate(new Date(2026, 8, 20, 9, 0).toISOString(), now)).toMatch(/20.*set/);
    expect(fileDate(new Date(2025, 8, 20, 9, 0).toISOString(), now)).toMatch(/2025/);
  });
});

describe('folderOf', () => {
  it('is the dirname of the relative path, or of the absolute one', () => {
    expect(folderOf(item())).toBe('docs/superpowers/specs');
    expect(folderOf(item({ rel_path: 'README.md' }))).toBe('raiz do projeto');
    expect(folderOf(item({ rel_path: null, path: '/tmp/x.md' }))).toBe('/tmp');
    expect(folderOf(item({ rel_path: null, path: '/x.md' }))).toBe('/');
  });
});
