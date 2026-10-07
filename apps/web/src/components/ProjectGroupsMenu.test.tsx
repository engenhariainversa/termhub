// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGroup } from '../lib/types';

const state = vi.hoisted(() => ({
  groups: [
    { id: 'g1', name: 'Clientes', kind: 'custom', position: 1, project_ids: ['p1'] },
    { id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: [] },
  ] as import('../lib/types').ProjectGroup[],
  setMemberships: vi.fn(async (_next: import('../lib/types').ProjectGroup[], _changes: { id: string; project_ids: string[] }[]) => {}),
  createGroup: vi.fn(async (name: string): Promise<import('../lib/types').ProjectGroup | null> => ({ id: 'g9', name, kind: 'custom', position: 2, project_ids: [] })),
}));
vi.mock('../lib/project-groups', () => ({ useProjectGroups: () => state }));
import { ProjectGroupsMenu } from './ProjectGroupsMenu';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const mount = (onClose = vi.fn()) => {
  const a = document.createElement('button');
  document.body.appendChild(a);
  render(<ProjectGroupsMenu projectId="p1" anchor={a} onClose={onClose} />);
  return onClose;
};

describe('ProjectGroupsMenu', () => {
  it('lists Favoritos first with the checked state', () => {
    mount();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    const items = screen.getAllByRole('menuitemcheckbox');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('Favoritos'), expect.stringContaining('Clientes')]);
    expect(items[0]).toHaveAttribute('aria-checked', 'false');
    expect(items[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('says the chat reads the groups, Favoritos left out', () => {
    mount();
    expect(screen.getByRole('note')).toHaveTextContent(/chat do projeto.*grupos.*Favoritos não conta/);
  });

  it('checking adds at the end, unchecking removes', () => {
    mount();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Favoritos/ }));
    expect(state.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'fav', project_ids: ['p1'] }]);
    const next = state.setMemberships.mock.calls[0][0] as ProjectGroup[];
    expect(next.find((g) => g.id === 'fav')!.project_ids).toEqual(['p1']);
    expect(next.find((g) => g.id === 'g1')!.project_ids).toEqual(['p1']);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Clientes/ }));
    expect(state.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'g1', project_ids: [] }]);
  });

  it('"Novo grupo…" creates the group and adds the project to it', async () => {
    mount();
    fireEvent.click(screen.getByText('Novo grupo…'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Pessoal' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(state.createGroup).toHaveBeenCalledWith('Pessoal');
    await vi.waitFor(() => expect(state.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'g9', project_ids: ['p1'] }]));
    const next = state.setMemberships.mock.calls[0][0] as ProjectGroup[];
    expect(next.find((g) => g.id === 'g9')!.project_ids).toEqual(['p1']);
  });

  it('Esc closes', () => {
    const onClose = mount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on a mousedown outside, not inside', () => {
    const onClose = mount();
    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
