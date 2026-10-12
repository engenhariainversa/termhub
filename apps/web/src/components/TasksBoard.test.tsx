// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, Tab, Task, TaskColumn } from '../lib/types';

const listMock = vi.fn();
const openTerminalMock = vi.fn();
const createMock = vi.fn();
const moveMock = vi.fn();
const pullRequestsMock = vi.fn();
const linkTabMock = vi.fn();
const detachTerminalMock = vi.fn();
const updateMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      tasks: {
        list: (...a: unknown[]) => listMock(...a),
        openTerminal: (...a: unknown[]) => openTerminalMock(...a),
        create: (...a: unknown[]) => createMock(...a),
        move: (...a: unknown[]) => moveMock(...a),
        pullRequests: (...a: unknown[]) => pullRequestsMock(...a),
        linkTab: (...a: unknown[]) => linkTabMock(...a),
        detachTerminal: (...a: unknown[]) => detachTerminalMock(...a),
        update: (...a: unknown[]) => updateMock(...a),
      },
    },
  };
});

const machines = [{ id: 'm1', name: 'mac', capabilities: [] }, { id: 'm2', name: 'jarvis', capabilities: [] }] as Machine[];
let project: Project;
vi.mock('../lib/data', () => ({
  useData: () => ({
    projects: [project],
    machinesOf: (p: Project) => p.machines.map((l) => machines.find((m) => m.id === l.machine_id)!),
    setOpenTasks: () => {},
  }),
}));

/** The open terminal tabs the monitor knows of, across the user's projects. */
let openTabs: Tab[] = [];
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ openTabs }) }));

import { TasksBoard } from './TasksBoard';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 2, ref: `P1-${over.id}`, title: over.id, description: null, status: 'todo', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c1', created_at: '', updated_at: '', ...over,
});
const epic = (id: string, title: string, number: number) => task({ id, title, number, ref: `P1-${number}`, type: 'epic', epic_id: null, column_id: null, status: 'backlog' });
const col = (id: string, name: string, category: TaskColumn['category'], position: number): TaskColumn => ({ id, project_id: 'p1', name, category, position, created_at: '' });
const columns = [col('c3', 'Feito', 'done', 2), col('c1', 'A fazer', 'todo', 0), col('c2', 'Em revisão', 'doing', 1)];
const board = (tasks: Task[]) => ({ tasks, columns, agent_column_id: null });

/** The URL (path and query) and whether the entry was pushed by opening a card on the board. */
function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{`${l.pathname}${l.search}|${(l.state as { boardCard?: boolean } | null)?.boardCard ? 'pushed' : ''}`}</output>;
}

/** The browser's back button. */
function BackButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>voltar</button>;
}

type Entry = string | { pathname: string; search?: string; state?: unknown };

/** The board, with `openCard`'s editor open through `?card=` (a pasted link) when given. */
function mount(openCard?: string, entries: Entry[] = [openCard ? `/projects/p1/tasks?card=P1-${openCard}` : '/projects/p1/tasks']) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <TasksBoard projectId="p1" />
      <LocationProbe />
      <BackButton />
    </MemoryRouter>,
  );
}

/** With the card's editor open (its URL), clicks "Abrir terminal para esta task". */
async function requestTerminal() {
  fireEvent.click(await screen.findByRole('button', { name: /Abrir terminal para esta task/ }));
}

beforeEach(() => {
  localStorage.clear();
  openTabs = [];
  project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }] } as Project;
  listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 't1' })]));
  pullRequestsMock.mockResolvedValue({ pull_requests: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TasksBoard — columns, cards and filter', () => {
  it('renders one column per project column, in order, with each card\'s ref and epic', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 'a' }), task({ id: 'r', column_id: 'c2', status: 'doing' })]));
    mount();
    await screen.findByText('a');
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['A fazer', 'Em revisão', 'Feito']);
    expect(within(screen.getByRole('region', { name: 'Em revisão' })).getByText('r')).toBeInTheDocument();
    expect(screen.getByText('P1-a')).toBeInTheDocument();
    expect(screen.getAllByText('Geral')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: 'A fazer' })).getByRole('img', { name: 'Tarefa' })).toBeInTheDocument();
  });

  it('hides epics by default; the Épico chip shows them and is remembered', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 'epic on board', type: 'epic', epic_id: null, number: 3 }), task({ id: 'a' })]));
    mount();
    await screen.findByText('a');
    expect(screen.queryByText('epic on board')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Épico' }));
    expect(screen.getByText('epic on board')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('termhub:board-filter:p1')!).types).toContain('epic');
  });

  it('filters by epic', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), epic('e2', 'Checkout', 4), task({ id: 'a' }), task({ id: 'b', epic_id: 'e2' })]));
    mount();
    await screen.findByText('a');
    fireEvent.change(screen.getByLabelText('Filtrar por épico'), { target: { value: 'e2' } });
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });

  it('resets a remembered epic filter that no longer exists, instead of hiding every card', async () => {
    localStorage.setItem('termhub:board-filter:p1', JSON.stringify({ types: ['story', 'task', 'bug', 'spike'], epicId: 'gone' }));
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 'a' })]));
    mount();
    await screen.findByText('a');
    expect(screen.getByLabelText('Filtrar por épico')).toHaveValue('');
    expect(JSON.parse(localStorage.getItem('termhub:board-filter:p1')!).epicId).toBeNull();
  });

  it('quick add creates a card in that column', async () => {
    createMock.mockResolvedValue({ task: task({ id: 'nova', column_id: 'c2', status: 'doing' }) });
    mount();
    await screen.findByText('t1');
    const input = within(screen.getByRole('region', { name: 'Em revisão' })).getByPlaceholderText('+ novo card (Enter)');
    fireEvent.change(input, { target: { value: 'nova' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(createMock).toHaveBeenCalledWith('p1', { title: 'nova', column_id: 'c2' }));
    expect(await within(screen.getByRole('region', { name: 'Em revisão' })).findByText('nova')).toBeInTheDocument();
  });

  it('the → button moves a card to the next column', async () => {
    moveMock.mockResolvedValue({ task: task({ id: 't1', column_id: 'c2', status: 'doing' }) });
    mount();
    await screen.findByText('t1');
    fireEvent.click(screen.getByTitle('Mover para Em revisão'));
    await waitFor(() => expect(moveMock).toHaveBeenCalledWith('t1', { column_id: 'c2' }, 0));
    expect(within(screen.getByRole('region', { name: 'Em revisão' })).getByText('t1')).toBeInTheDocument();
  });

  it('shows a legacy GitHub link\'s key as a subtitle under the title, without repeating it in the title', async () => {
    listMock.mockResolvedValue(
      board([
        epic('e1', 'Geral', 1),
        task({ id: 'a', title: 'Login quebra', external_ref: { provider: 'github', id: '4', identifier: '#4', url: 'https://x', state: 'open', status: 'todo', scope: 'acme/api' } }),
      ]),
    );
    mount();
    expect(await screen.findByText('Login quebra')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'acme/api#4' });
    expect(link).toHaveAttribute('href', 'https://x');
  });

  it('a card imported before the change ("EI-123 Título") shows the title without the key prefix', async () => {
    listMock.mockResolvedValue(
      board([
        epic('e1', 'Geral', 1),
        task({ id: 'a', title: 'EI-123 Login quebra', external_ref: { provider: 'linear', id: 'u', identifier: 'EI-123', url: 'https://l', state: 'Todo', status: 'todo' } }),
        task({ id: 'b', title: '#12 Safari trava', external_ref: { provider: 'github', id: '12', identifier: '#12', url: 'https://g', state: 'open', status: 'todo', scope: 'acme/api' } }),
      ]),
    );
    mount();
    expect(await screen.findByText('Login quebra')).toBeInTheDocument();
    expect(screen.getByText('Safari trava')).toBeInTheDocument();
    expect(screen.queryByText(/EI-123 Login quebra/)).toBeNull();
    expect(screen.getByRole('link', { name: 'EI-123' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'acme/api#12' })).toBeInTheDocument();
  });
});

describe('TasksBoard — drag and drop', () => {
  it('ignores a foreign drop (no matching drag state) without calling the API', async () => {
    mount();
    await screen.findByText('t1');
    const region = screen.getByRole('region', { name: 'A fazer' });
    fireEvent.drop(region, { dataTransfer: { getData: () => 'not-a-task' } });
    expect(moveMock).not.toHaveBeenCalled();
  });
});

describe('TasksBoard — choosing a machine to open a task terminal', () => {
  it('opens directly on the only linked machine, without a picker', async () => {
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount('t1');
    await requestTerminal();
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm1'));
    expect(screen.queryByText('Abrir em qual máquina?')).not.toBeInTheDocument();
  });

  it('shows a picker with several machines when none was used before, and remembers the pick', async () => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/b', position: 1 }] } as Project;
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount('t1');
    await requestTerminal();
    expect(await screen.findByText('Abrir em qual máquina?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /jarvis/ }));
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm2'));
    expect(localStorage.getItem('termhub:last-machine:p1')).toBe('m2');
  });

  it('skips the picker and reuses the last machine when it is still linked', async () => {
    localStorage.setItem('termhub:last-machine:p1', 'm2');
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/b', position: 1 }] } as Project;
    openTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: 'tab1' }), tab: { id: 'tab1' }, created: true });
    mount('t1');
    await requestTerminal();
    await waitFor(() => expect(openTerminalMock).toHaveBeenCalledWith('t1', 'm2'));
    expect(screen.queryByText('Abrir em qual máquina?')).not.toBeInTheDocument();
  });

  it('shows the no-machine error and never calls the API when the project has no linked machine', async () => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [] } as unknown as Project;
    mount('t1');
    await requestTerminal();
    expect(await screen.findByText('Vincule uma máquina ao projeto em Setup → Máquinas para abrir terminais.')).toBeInTheDocument();
    expect(openTerminalMock).not.toHaveBeenCalled();
  });
});

describe('TasksBoard — card URLs', () => {
  it('clicking a card\'s title opens its editor through ?card= on the board, without reloading the board', async () => {
    mount();
    await screen.findByText('t1');
    fireEvent.click(screen.getByText('t1'));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks?card=P1-t1|pushed');
    expect(await screen.findByRole('heading', { name: 'P1-t1' })).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('the "Abrir card" button is reachable by keyboard and opens the card', async () => {
    mount();
    await screen.findByText('t1');
    const openButton = screen.getByRole('button', { name: /Abrir card P1-t1/ });
    openButton.focus();
    expect(openButton).toHaveFocus();
    fireEvent.click(openButton);
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks?card=P1-t1|pushed');
  });

  it('pressing Enter on the focused card opens it', async () => {
    mount();
    await screen.findByText('t1');
    const card = screen.getByRole('button', { name: 'P1-t1 t1' });
    card.focus();
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks?card=P1-t1|pushed');
  });

  it('Enter on a nested control (the move button) does not also open the card', async () => {
    mount();
    await screen.findByText('t1');
    const moveButton = screen.getByRole('button', { name: 'Mover para Em revisão' });
    moveButton.focus();
    fireEvent.keyDown(moveButton, { key: 'Enter' });
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks|');
  });

  it('a drag does not also open the card once it is dropped', async () => {
    mount();
    await screen.findByText('t1');
    const card = screen.getByRole('button', { name: 'P1-t1 t1' });
    fireEvent.dragStart(card, { dataTransfer: { effectAllowed: '', setData: () => {} } });
    fireEvent.dragEnd(card);
    fireEvent.click(card);
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks|');
  });

  it('closing the editor goes back to the board as it was: same mount, no reload', async () => {
    mount();
    fireEvent.click(await screen.findByText('t1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Fechar' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks|');
    expect(screen.queryByRole('heading', { name: 'P1-t1' })).not.toBeInTheDocument();
    expect(screen.getByText('t1')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('the browser\'s back button closes the editor', async () => {
    mount();
    fireEvent.click(await screen.findByText('t1'));
    expect(await screen.findByRole('heading', { name: 'P1-t1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'voltar' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks|');
    expect(screen.queryByRole('heading', { name: 'P1-t1' })).not.toBeInTheDocument();
  });

  it('saving updates the card in place: no board reload, no loading state', async () => {
    updateMock.mockResolvedValue({ task: task({ id: 't1', title: 'novo título' }) });
    mount();
    fireEvent.click(await screen.findByText('t1'));
    fireEvent.change(await screen.findByLabelText('Título'), { target: { value: 'novo título' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    // optimistic: the new title is on the board before the server answers, and the board never unmounts
    expect(screen.getByText('novo título')).toBeInTheDocument();
    expect(screen.queryByText('Carregando o board…')).not.toBeInTheDocument();
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('t1', { title: 'novo título' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks|');
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('a pasted ?card= link opens the editor; closing it drops the parameter', async () => {
    mount('t1');
    expect(await screen.findByRole('heading', { name: 'P1-t1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/tasks|');
    expect(screen.queryByRole('heading', { name: 'P1-t1' })).not.toBeInTheDocument();
  });

  it('a subtask\'s ref opens its parent card', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 't1', type: 'story', subtasks: [task({ id: 's1', type: 'subtask', parent_id: 't1', epic_id: null, column_id: null })] })]));
    mount('s1');
    expect(await screen.findByRole('heading', { name: 'P1-t1' })).toBeInTheDocument();
  });

  it('a card opened from the Backlog goes back there when closed', async () => {
    mount(undefined, ['/projects/p1/backlog', { pathname: '/projects/p1/tasks', search: '?card=P1-t1', state: { boardCard: true } }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Fechar' }));
    expect(screen.getByTestId('location').textContent).toBe('/projects/p1/backlog|');
  });

  it('an unknown ref opens nothing', async () => {
    mount('nope');
    await screen.findByText('t1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// TER-499: an agent started by hand in an open tab is linked to its card from the card editor.
describe('TasksBoard — linking an open tab to a card', () => {
  const openTab = (over: Partial<Tab> & { id: string }): Tab => ({ project_id: 'p1', machine_id: 'm1', name: over.id, kind: 'terminal', ...over }) as Tab;

  beforeEach(() => {
    project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }, { machine_id: 'm2', cwd: '/b', position: 1 }] } as Project;
    openTabs = [openTab({ id: 'ta', name: 'claude' }), openTab({ id: 'tz', name: 'de outro projeto', project_id: 'p2' }), openTab({ id: 'tb', name: 'codex', machine_id: 'm2' })];
  });

  it('offers only the open tabs of this project, each with its machine', async () => {
    mount('t1');
    const select = (await screen.findByLabelText('Ligar a uma aba aberta')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Ligar a uma aba aberta…', 'claude · mac', 'codex · jarvis']);
  });

  it('links the chosen tab, and the card then goes to that terminal', async () => {
    const linked = task({ id: 't1', tab_id: 'tb', status: 'doing', column_id: 'c2' });
    linkTabMock.mockResolvedValue({ task: linked });
    // the board is read again after the link: the server moved the card and reindexed both columns
    listMock.mockResolvedValueOnce(board([epic('e1', 'Geral', 1), task({ id: 't1' })])).mockResolvedValue(board([epic('e1', 'Geral', 1), linked]));
    mount('t1');
    fireEvent.change(await screen.findByLabelText('Ligar a uma aba aberta'), { target: { value: 'tb' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ligar' }));
    await waitFor(() => expect(linkTabMock).toHaveBeenCalledWith('t1', 'tb'));
    expect(await screen.findByRole('link', { name: /Ir para o terminal/ })).toHaveAttribute('href', '/projects/p1?tab=tb');
    // the card moved with the link, as start_agent moves it
    expect(within(screen.getByRole('region', { name: 'Em revisão' })).getByText('t1')).toBeInTheDocument();
  });

  it('unlinks the tab of a card, which can then open or link a terminal again', async () => {
    listMock.mockResolvedValue(board([epic('e1', 'Geral', 1), task({ id: 't1', tab_id: 'ta' })]));
    detachTerminalMock.mockResolvedValue({ task: task({ id: 't1', tab_id: null }) });
    mount('t1');
    fireEvent.click(await screen.findByRole('button', { name: 'Desligar a aba deste card' }));
    await waitFor(() => expect(detachTerminalMock).toHaveBeenCalledWith('t1'));
    expect(await screen.findByRole('button', { name: /Abrir terminal para esta task/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Ligar a uma aba aberta')).toBeInTheDocument();
  });

  it('says why a link was refused', async () => {
    const { ApiError } = await import('../lib/api');
    linkTabMock.mockRejectedValue(new ApiError('A tarefa "t1" é de outro projeto, não o da aba'));
    mount('t1');
    fireEvent.change(await screen.findByLabelText('Ligar a uma aba aberta'), { target: { value: 'ta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ligar' }));
    expect(await screen.findByText('A tarefa "t1" é de outro projeto, não o da aba')).toBeInTheDocument();
  });
});
