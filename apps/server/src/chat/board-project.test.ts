import { describe, expect, it, vi } from 'vitest';
import { boardProjectOf } from './board-project.js';

const repos = {
  projects: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('p1') ? [{ id: 'p1' }] : [])) },
  taskColumns: { findById: vi.fn(async (id: string) => ({ c1: { id: 'c1', project_id: 'p1' }, c9: { id: 'c9', project_id: 'p9' } } as Record<string, object>)[id]) },
  tasks: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('k1') ? [{ id: 'k1', project_id: 'p1' }] : [])) },
} as never;

describe('boardProjectOf', () => {
  it('create_task → its own project', async () => expect(await boardProjectOf(repos, 'u1', 'create_task', { project_id: 'p1' })).toBe('p1'));
  it('create_task on a foreign project → null', async () => expect(await boardProjectOf(repos, 'u1', 'create_task', { project_id: 'p9' })).toBeNull());
  it.each(['add_subtasks', 'update_task', 'move_task'])('%s → the card project', async (t) => expect(await boardProjectOf(repos, 'u1', t, { task_id: 'k1' })).toBe('p1'));
  it('create_column → its own project; update_column → the column project (TER-1134)', async () => {
    expect(await boardProjectOf(repos, 'u1', 'create_column', { project_id: 'p1' })).toBe('p1');
    expect(await boardProjectOf(repos, 'u1', 'update_column', { column_id: 'c1' })).toBe('p1');
    expect(await boardProjectOf(repos, 'u1', 'update_column', { column_id: 'c9' })).toBeNull();
    expect(await boardProjectOf(repos, 'u2', 'update_column', { column_id: 'c1' })).toBeNull();
    expect(await boardProjectOf(repos, 'u1', 'update_column', { column_id: 'nope' })).toBeNull();
  });
  it('a foreign or missing card → null', async () => {
    expect(await boardProjectOf(repos, 'u1', 'move_task', { task_id: 'k9' })).toBeNull();
    expect(await boardProjectOf(repos, 'u2', 'move_task', { task_id: 'k1' })).toBeNull();
  });
  it('malformed ids and other tools → null, without reading', async () => {
    vi.clearAllMocks();
    expect(await boardProjectOf(repos, 'u1', 'move_task', { task_id: 42 })).toBeNull();
    expect(await boardProjectOf(repos, 'u1', 'delete_task', { task_id: 'k1' })).toBeNull();
    const { tasks, projects } = repos as { tasks: { findByIdsForOwner: ReturnType<typeof vi.fn> }; projects: { findByIdsForOwner: ReturnType<typeof vi.fn> } };
    expect(tasks.findByIdsForOwner).not.toHaveBeenCalled();
    expect(projects.findByIdsForOwner).not.toHaveBeenCalled();
  });
});
