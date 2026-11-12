// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskColumn } from '../lib/types';

vi.mock('./SubtaskList', () => ({ SubtaskList: () => <div>lista de subtarefas</div> }));
const flags = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('../lib/feature-flags', () => ({
  useFeatureFlag: (flag: string) => flags.on.has(flag),
  FeatureGate: ({ flag, children }: { flag: string; children: ReactNode }) => (flags.on.has(flag) ? <>{children}</> : null),
}));
vi.mock('./CardPullRequests', () => ({ CardPullRequests: ({ taskId }: { taskId: string }) => <div>prs-{taskId}</div> }));

import { TaskEditor, type TaskEditorProps } from './TaskEditor';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 7, ref: 'P1-7', title: over.id, description: null, status: 'todo', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c1', created_at: '2026-09-24T00:00:00.000Z', updated_at: '', ...over,
});
const columns: TaskColumn[] = [
  { id: 'c1', project_id: 'p1', name: 'A fazer', category: 'todo', position: 0, created_at: '' },
  { id: 'c2', project_id: 'p1', name: 'Em revisão', category: 'doing', position: 1, created_at: '' },
];
const epics = [
  task({ id: 'e1', type: 'epic', number: 1, ref: 'P1-1', title: 'Geral', epic_id: null, column_id: null, status: 'backlog' }),
  task({ id: 'e2', type: 'epic', number: 5, ref: 'P1-5', title: 'Checkout', epic_id: null, column_id: null, status: 'backlog' }),
];

function mount(t: Task, over: Partial<TaskEditorProps> = {}) {
  const props: TaskEditorProps = {
    task: t, columns, epics, terminalHref: null, linkableTabs: [], onClose: vi.fn(), onSave: vi.fn(), onPlace: vi.fn(), onDelete: vi.fn(), onOpenTerminal: vi.fn(),
    onLinkTab: vi.fn(), onDetachTerminal: vi.fn(),
    onPushStatus: vi.fn(async () => null), onSubtasks: vi.fn(), onError: vi.fn(), ...over,
  };
  render(
    <MemoryRouter>
      <TaskEditor {...props} />
    </MemoryRouter>,
  );
  return props;
}

afterEach(() => {
  flags.on.clear();
  cleanup();
  vi.clearAllMocks();
});

describe('TaskEditor', () => {
  // TER-1170
  it('an epic offers "Executar em ordem" only with the sequential_epics flag, and saves it', () => {
    const epic = task({ id: 'Plano', type: 'epic', epic_id: null, column_id: null, status: 'backlog' });
    mount(epic, { epicUntagged: 0, onSetAuto: vi.fn() });
    expect(screen.queryByLabelText('Executar em ordem')).not.toBeInTheDocument();
    cleanup();
    flags.on.add('sequential_epics');
    const props = mount(epic, { epicUntagged: 0, onSetAuto: vi.fn() });
    fireEvent.click(screen.getByLabelText('Executar em ordem'));
    expect(props.onSave).toHaveBeenCalledWith({ sequential: true });
    cleanup();
    mount(task({ id: 'Card' }), { epicUntagged: 0, onSetAuto: vi.fn() });
    expect(screen.queryByLabelText('Executar em ordem')).not.toBeInTheDocument();
  });

  it('is titled with the ref and saves type and epic changes', () => {
    const props = mount(task({ id: 'Pagar' }));
    expect(screen.getByRole('heading', { name: 'P1-7' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'bug' } });
    fireEvent.change(screen.getByLabelText('Épico'), { target: { value: 'e2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(props.onSave).toHaveBeenCalledWith({ type: 'bug', epic_id: 'e2' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('shows the card pull requests of an existing card', () => {
    mount(task({ id: 'Pagar' }));
    expect(screen.getByText('prs-Pagar')).toBeInTheDocument();
  });

  it('keeps a card with subtasks a story or a task, and shows its checklist', () => {
    mount(task({ id: 's', type: 'story', subtasks: [task({ id: 'x', parent_id: 's', type: 'subtask' })] }));
    const options = Array.from((screen.getByLabelText('Tipo') as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['História', 'Tarefa']);
    expect(screen.getByText('lista de subtarefas')).toBeInTheDocument();
  });

  it('never changes an epic\'s type and has no epic select on it', () => {
    mount(epics[1]);
    expect(screen.getByLabelText('Tipo')).toBeDisabled();
    expect(screen.queryByLabelText('Épico')).not.toBeInTheDocument();
    expect(screen.queryByText('lista de subtarefas')).not.toBeInTheDocument();
  });

  it('has no checklist on a bug', () => {
    mount(task({ id: 'b', type: 'bug' }));
    expect(screen.queryByText('lista de subtarefas')).not.toBeInTheDocument();
  });

  it('moves between columns and to the backlog from the column select', () => {
    const props = mount(task({ id: 'a' }));
    const select = screen.getByLabelText('Coluna') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Backlog', 'A fazer', 'Em revisão']);
    fireEvent.change(select, { target: { value: 'c2' } });
    expect(props.onPlace).toHaveBeenCalledWith({ column_id: 'c2' });
    fireEvent.change(select, { target: { value: '' } });
    expect(props.onPlace).toHaveBeenLastCalledWith({ status: 'backlog' });
  });

  it('copies the card link', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(task({ id: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copiar link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/project/P1-7`));
    expect(await screen.findByRole('button', { name: 'Link copiado' })).toBeInTheDocument();
  });

  it('asks before deleting', () => {
    const props = mount(task({ id: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, excluir' }));
    expect(props.onDelete).toHaveBeenCalled();
  });
});

// TER-499: a tab that is already open (an agent started by hand) can be linked to the card from here.
describe('TaskEditor: linking an open tab', () => {
  const linkableTabs = [
    { id: 'ta', name: 'claude', machine_name: 'mac' },
    { id: 'tb', name: 'codex', machine_name: 'jarvis' },
  ];

  it('lists the open tabs by name and machine and links the chosen one', () => {
    const props = mount(task({ id: 'Pagar' }), { linkableTabs });
    const select = screen.getByLabelText('Ligar a uma aba aberta') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Ligar a uma aba aberta…', 'claude · mac', 'codex · jarvis']);
    const link = screen.getByRole('button', { name: 'Ligar' });
    expect(link).toBeDisabled();
    fireEvent.change(select, { target: { value: 'tb' } });
    fireEvent.click(link);
    expect(props.onLinkTab).toHaveBeenCalledWith('tb');
    expect(props.onOpenTerminal).not.toHaveBeenCalled();
  });

  it('offers nothing to link when the project has no open tab', () => {
    mount(task({ id: 'Pagar' }));
    expect(screen.queryByLabelText('Ligar a uma aba aberta')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Abrir terminal para esta task/ })).toBeInTheDocument();
  });

  it('a linked card goes to its terminal or is unlinked, and offers no other tab', () => {
    const props = mount(task({ id: 'Pagar', tab_id: 'ta' }), { terminalHref: '/projects/p1?tab=ta', linkableTabs });
    expect(screen.getByRole('link', { name: /Ir para o terminal/ })).toHaveAttribute('href', '/projects/p1?tab=ta');
    expect(screen.queryByLabelText('Ligar a uma aba aberta')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Desligar a aba deste card' }));
    expect(props.onDetachTerminal).toHaveBeenCalled();
  });
});
