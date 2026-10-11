// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { authState, usersList } = vi.hoisted(() => ({
  authState: { current: { can: (() => true) as (resource: string, action?: string) => boolean } as { can: (resource: string, action?: string) => boolean; user?: unknown } },
  usersList: { current: (() => new Promise(() => {})) as () => Promise<unknown>, roles: (() => new Promise(() => {})) as () => Promise<unknown> },
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
// Each section loads its own data; only which section is picked, and its header, matter here.
vi.mock('../components/MyCityView', () => ({ MyCityView: () => <p>minha-cidade-view</p> }));
vi.mock('../components/ProfileView', () => ({ ProfileView: () => <p>profile-view</p> }));
vi.mock('../components/IntegrationsView', () => ({ IntegrationsView: () => <p>integrations-view</p> }));
vi.mock('../components/ChatGrantsView', () => ({ ChatGrantsView: () => <p>chat-grants-view</p> }));
vi.mock('../components/UploadsView', () => ({ UploadsView: () => null }));
vi.mock('../components/ApiTokensView', () => ({ ApiTokensView: () => null }));
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    users: { list: () => usersList.current(), access: () => new Promise(() => {}) },
    roles: { list: () => usersList.roles() },
  },
}));

import { SettingsPage } from './SettingsPage';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;
const titles = () => screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent);

afterEach(() => {
  cleanup();
  usersList.current = () => new Promise(() => {});
  usersList.roles = () => new Promise(() => {});
});

describe('SettingsPage', () => {
  it('opens /settings on Perfil, for an admin too', () => {
    authState.current = { can: () => true };
    renderAt('/settings');
    expect(where()).toBe('/settings/profile');
    expect(screen.getByText('profile-view')).toBeTruthy();
    expect(titles()).toEqual(['Perfil']);
  });

  it('a section this role cannot see lands on Perfil', () => {
    authState.current = { can: () => false };
    renderAt('/settings/users');
    expect(where()).toBe('/settings/profile');
    expect(screen.getByText('profile-view')).toBeTruthy();
  });

  it('an unknown section lands on Perfil', () => {
    authState.current = { can: () => true };
    renderAt('/settings/nada');
    expect(where()).toBe('/settings/profile');
  });

  it('opens Minha cidade under a header with its name, and no tab row', () => {
    authState.current = { can: () => true };
    renderAt('/settings/city');
    expect(screen.getByText('minha-cidade-view')).toBeTruthy();
    expect(titles()).toEqual(['Minha cidade']);
    expect(screen.queryByRole('link', { name: 'Usuários' })).toBeNull();
  });

  it('puts Usuários under one header, with Convidar among its actions', () => {
    authState.current = { can: () => true };
    renderAt('/settings/users');
    expect(titles()).toEqual(['Usuários']);
    expect(screen.getByRole('button', { name: 'Convidar' }).closest('header')).not.toBeNull();
  });

  it('marks a user whose account deletion is pending', async () => {
    authState.current = { can: () => true };
    const base = { avatar_url: null, role: 'member', role_info: null, permissions: [], has_password: false, has_google: true, invited_at: null, last_login_at: '2026-09-01T00:00:00.000Z', nickname: null, review_enabled_until: null, deletion_requested_at: null };
    usersList.current = async () => ({
      users: [
        { ...base, id: 'u1', email: 'a@x.com', name: 'Ana', deletion_scheduled_at: null },
        { ...base, id: 'u2', email: 'b@x.com', name: 'Bia', deletion_requested_at: '2026-10-01T12:00:00.000Z', deletion_scheduled_at: '2026-10-31T12:00:00.000Z' },
      ],
    });
    usersList.roles = async () => ({ roles: [] });
    renderAt('/settings/users');
    expect(await screen.findByText('Exclusão em 31/10/2026')).toBeTruthy();
    expect(screen.getAllByText(/^Exclusão em/)).toHaveLength(1);
  });

  it('puts Roles under one header, with + role among its actions', () => {
    authState.current = { can: () => true };
    renderAt('/settings/roles');
    expect(titles()).toEqual(['Roles']);
    expect(screen.getByRole('button', { name: '+ role' }).closest('header')).not.toBeNull();
  });

  it('gives Permissões a single header', () => {
    authState.current = { can: () => true };
    renderAt('/settings/permissions');
    expect(titles()).toEqual(['Permissões']);
  });

  it('opens Integrações as a section', () => {
    authState.current = { can: (r) => r === 'integrations' };
    renderAt('/settings/integrations');
    expect(screen.getByText('integrations-view')).toBeTruthy();
  });

  it('opens Permissões do chat as a section', () => {
    authState.current = { can: (r) => r === 'chat' };
    renderAt('/settings/chat-grants');
    expect(screen.getByText('chat-grants-view')).toBeTruthy();
    expect(titles()).toEqual(['Permissões do chat']);
  });
});
