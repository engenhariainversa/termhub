// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyMove,
  backlogSections,
  boardCardPath,
  canHaveSubtasks,
  cardForRef,
  cardPath,
  cardsIn,
  DEFAULT_FILTER,
  dropPosition,
  epicsOf,
  nextColumn,
  openCount,
  readBoardFilter,
  typeOptions,
  visible,
  WORK_TYPES,
  writeBoardFilter,
} from './board';
import type { Task, TaskColumn } from './types';

const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'task', number: 1, ref: `P1-${over.id}`, title: over.id, description: null, status: 'todo', position: 0,
  external_ref: null, external_key: null, tab_id: null, parent_id: null, epic_id: 'e1', column_id: 'c1', created_at: '', updated_at: '', ...over,
});
const col = (id: string, category: TaskColumn['category'], position: number): TaskColumn => ({ id, project_id: 'p1', name: id, category, position, created_at: '' });

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('board filter', () => {
  it('defaults to stories, tasks, bugs and spikes of every epic', () => {
    expect(readBoardFilter('p1')).toEqual({ types: ['story', 'task', 'bug', 'spike'], epicId: null });
    expect(DEFAULT_FILTER.types).toEqual(WORK_TYPES);
  });

  it('is remembered per project and drops unknown types or broken JSON', () => {
    writeBoardFilter('p1', { types: ['epic', 'bug'], epicId: 'e2' });
    expect(readBoardFilter('p1')).toEqual({ types: ['bug', 'epic'], epicId: 'e2' });
    expect(readBoardFilter('p2')).toEqual(DEFAULT_FILTER);
    localStorage.setItem('termhub:board-filter:p3', JSON.stringify({ types: ['nope', 'spike'] }));
    expect(readBoardFilter('p3')).toEqual({ types: ['spike'], epicId: null });
    localStorage.setItem('termhub:board-filter:p4', 'not json');
    expect(readBoardFilter('p4')).toEqual(DEFAULT_FILTER);
  });

  it('survives a storage that throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readBoardFilter('p1')).toEqual(DEFAULT_FILTER);
    expect(() => writeBoardFilter('p1', DEFAULT_FILTER)).not.toThrow();
  });

  it('lets through the chosen types and, with an epic chosen, its cards and the epic itself', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', type: 'bug', epic_id: 'e2' });
    const e1 = task({ id: 'e1', type: 'epic', epic_id: null });
    expect(visible([a, b, e1], DEFAULT_FILTER).map((t) => t.id)).toEqual(['a', 'b']);
    expect(visible([a, b, e1], { types: [...WORK_TYPES, 'epic'], epicId: 'e1' }).map((t) => t.id)).toEqual(['a', 'e1']);
  });
});

describe('columns', () => {
  it('lists a column\'s top-level cards by position, subtasks and other columns left out', () => {
    const tasks = [task({ id: 'b', position: 1 }), task({ id: 'a', position: 0 }), task({ id: 's', parent_id: 'a', column_id: null }), task({ id: 'z', column_id: 'c2' })];
    expect(cardsIn(tasks, 'c1').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('finds the next column by position, none after the last', () => {
    const columns = [col('c3', 'done', 2), col('c1', 'todo', 0), col('c2', 'doing', 1)];
    expect(nextColumn(columns, 'c1')?.id).toBe('c2');
    expect(nextColumn(columns, 'c3')).toBeUndefined();
  });
});

describe('dropPosition', () => {
  const all = ['a', 'b', 'c', 'd', 'e'].map((id, position) => task({ id, position }));
  const shown = [all[0], all[2], all[4]]; // b and d hidden by the filter

  it('drops right after the visible card above the drop point; hidden cards keep their places', () => {
    expect(dropPosition(all, shown, 0, 'x')).toBe(0);
    expect(dropPosition(all, shown, 1, 'x')).toBe(1); // after a, before the hidden b
    expect(dropPosition(all, shown, 2, 'x')).toBe(3); // after c, before the hidden d
    expect(dropPosition(all, shown, 3, 'x')).toBe(5); // after e: the end
  });

  it('counts the dragged card out when it moves down inside its own column', () => {
    expect(dropPosition(all, shown, 2, 'a')).toBe(2); // below c: b, c, a, d, e
    expect(dropPosition(all, shown, 1, 'a')).toBe(0); // its own place
    expect(dropPosition(all, shown, 0, 'e')).toBe(0);
  });
});

describe('applyMove', () => {
  it('reindexes the target column and the one the card left, and takes the column category', () => {
    const tasks = [task({ id: 'a', position: 0 }), task({ id: 'b', position: 1 }), task({ id: 'x', column_id: 'c2', status: 'doing', position: 0 })];
    const next = applyMove(tasks, 'a', col('c2', 'doing', 1), 1);
    const get = (id: string) => next.find((t) => t.id === id)!;
    expect(get('a')).toMatchObject({ column_id: 'c2', status: 'doing', position: 1 });
    expect(get('x').position).toBe(0);
    expect(get('b').position).toBe(0);
  });
});

describe('epics, counts and the backlog', () => {
  const tasks = [
    task({ id: 'e2', type: 'epic', number: 5, epic_id: null, column_id: null, status: 'backlog' }),
    task({ id: 'e1', type: 'epic', number: 1, epic_id: null, column_id: null, status: 'backlog' }),
    task({ id: 'b1', status: 'backlog', column_id: null, position: 1 }),
    task({ id: 'b0', status: 'backlog', column_id: null, position: 0, type: 'bug' }),
    task({ id: 'd', status: 'done', column_id: 'c3' }),
    task({ id: 't', status: 'todo' }),
    task({ id: 'x', status: 'doing', epic_id: 'e2', column_id: 'c2' }),
    task({ id: 's', status: 'doing', parent_id: 't', type: 'subtask', epic_id: null, column_id: null }),
  ];

  it('orders epics by number (the default epic first)', () => {
    expect(epicsOf(tasks).map((t) => t.id)).toEqual(['e1', 'e2']);
  });

  it('counts open work only: work types in todo or doing, no epics, no subtasks', () => {
    expect(openCount([...tasks, task({ id: 'eb', type: 'epic', status: 'doing', epic_id: null })])).toBe(2);
  });

  it('builds one section per epic with its backlog items in order and its progress on the board', () => {
    const [s1, s2] = backlogSections(tasks);
    expect(s1.epic.id).toBe('e1');
    expect(s1.items.map((t) => t.id)).toEqual(['b0', 'b1']);
    expect([s1.done, s1.total]).toEqual([1, 2]);
    expect(s2.items).toEqual([]);
    expect([s2.done, s2.total]).toEqual([0, 1]);
  });
});

describe('card rules on the web', () => {
  it('offers the type changes the server allows', () => {
    expect(typeOptions(task({ id: 'a' }))).toEqual(['story', 'task', 'bug', 'spike']);
    expect(typeOptions(task({ id: 'a', type: 'story', subtasks: [task({ id: 's', parent_id: 'a' })] }))).toEqual(['story', 'task']);
    expect(typeOptions(task({ id: 'e', type: 'epic' }))).toEqual(['epic']);
    expect(canHaveSubtasks(task({ id: 'b', type: 'bug' }))).toBe(false);
    expect(canHaveSubtasks(task({ id: 's', type: 'story' }))).toBe(true);
    expect(cardPath('TER-12')).toBe('/project/TER-12');
  });
});

describe('a card on the board URL (TER-976)', () => {
  it('builds the board path with the card open', () => {
    expect(boardCardPath('p1', 'TER-12')).toBe('/projects/p1/tasks?card=TER-12');
  });

  it('resolves a ref to its top-level card: the card, or a subtask\'s parent', () => {
    const sub = task({ id: 's', ref: 'P1-9', type: 'subtask', parent_id: 'a' });
    const tasks = [task({ id: 'a', ref: 'P1-2', type: 'story', subtasks: [sub] }), task({ id: 'b', ref: 'P1-3' })];
    expect(cardForRef(tasks, 'P1-3')?.id).toBe('b');
    expect(cardForRef(tasks, 'P1-9')?.id).toBe('a');
    expect(cardForRef(tasks, 'P1-99')).toBeNull();
  });
});
