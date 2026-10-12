// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorItem, Project, ProjectGroup, Tab } from '../lib/types';

const state = vi.hoisted(() => ({
  can: (() => true) as (resource: string, action?: string) => boolean,
  projects: [] as Project[],
  groups: [] as ProjectGroup[],
  items: [] as MonitorItem[],
}));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: state.can, user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'pedro@example.com' } }) }));
vi.mock('../lib/data', () => ({ useData: () => ({ projects: state.projects }) }));
vi.mock('../lib/project-groups', () => ({ useProjectGroups: () => ({ groups: state.groups }) }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ items: state.items, needsYou: state.items }) }));

import { SidebarRail } from './SidebarRail';

const project = (id: string, name: string, over: Partial<Project> = {}) => ({ id, key: name.toUpperCase(), name, status: 'active', machines: [], ...over }) as unknown as Project;
const waitingOn = (p: Project): MonitorItem =>
  ({ tab: { id: `t-${p.id}`, project_id: p.id, state: 'waiting_input', state_at: '2026-09-23T10:00:00.000Z', state_seen_at: null } as Tab, project: p, machine: {} }) as unknown as MonitorItem;

function mount(path: string, mode: 'main' | 'settings' = 'main') {
  const onBack = vi.fn();
  const onExpand = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarRail mode={mode} onExpand={onExpand} onBack={onBack} />
    </MemoryRouter>,
  );
  return { onBack, onExpand };
}

beforeEach(() => {
  const alpha = project('p1', 'alpha');
  const beta = project('p2', 'beta');
  state.projects = [alpha, beta, project('p3', 'x'), project('p4', 'velho', { status: 'archived' })];
  state.groups = [{ id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['p2', 'p3', 'p4', 'p1'] }];
  state.items = [waitingOn(beta)];
  state.can = () => true;
});
afterEach(cleanup);

describe('SidebarRail', () => {
  it('shows the favourites in Favoritos order, two letters each, archived ones left out', () => {
    mount('/');
    const favs = within(screen.getByRole('navigation', { name: 'Favoritos' })).getAllByRole('link');
    expect(favs.map((l) => l.textContent)).toEqual(['BE', 'X', 'AL']);
    expect(favs.map((l) => l.getAttribute('href'))).toEqual(['/projects/p2', '/projects/p3', '/projects/p1']);
  });

  it('names each square after its project, and says when it needs you', () => {
    mount('/');
    const beta = screen.getByRole('link', { name: 'beta, precisa de você' });
    expect(beta).toHaveAttribute('title', 'beta, precisa de você');
    expect(beta.querySelector('[data-attention]')).not.toBeNull();
    const alpha = screen.getByRole('link', { name: 'alpha' });
    expect(alpha).toHaveAttribute('title', 'alpha');
    expect(alpha.querySelector('[data-attention]')).toBeNull();
  });

  it('highlights the project being viewed, on any of its sections', () => {
    mount('/projects/p1/tasks');
    expect(screen.getByRole('link', { name: 'alpha' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'x' })).not.toHaveAttribute('aria-current');
  });

  it('has the daily menus as icons under their permissions, and the avatar opening Perfil', () => {
    state.can = (r) => r === 'machines';
    mount('/');
    const daily = within(screen.getByRole('navigation', { name: 'Menu principal' })).getAllByRole('link');
    expect(daily.map((l) => l.getAttribute('aria-label'))).toEqual(['Máquinas']);
    expect(screen.getByRole('button', { name: /configurações e perfil/ })).toBeInTheDocument();
  });

  it('expands', () => {
    const { onExpand } = mount('/');
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar sidebar' }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('under /settings shows the settings sections and a back button instead of the projects', () => {
    state.can = () => false;
    const { onBack } = mount('/settings/city', 'settings');
    expect(screen.queryByRole('navigation', { name: 'Favoritos' })).toBeNull();
    const sections = within(screen.getByRole('navigation', { name: 'Seções de Configurações' })).getAllByRole('link');
    expect(sections.map((l) => [l.getAttribute('aria-label'), l.getAttribute('title')])).toEqual([
      ['Perfil', 'Perfil'],
      ['Minha cidade', 'Minha cidade'],
      ['Segurança', 'Segurança'],
    ]);
    expect(screen.getByRole('link', { name: 'Minha cidade' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Voltar de Configurações' })).toHaveAttribute('data-chrome-focus', 'settings-back');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar de Configurações' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
