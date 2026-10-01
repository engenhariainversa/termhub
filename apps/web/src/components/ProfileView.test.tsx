// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../lib/types';

// vi.mock factories are hoisted: everything they touch comes through vi.hoisted().
const { authState, analytics, openCookieBanner } = vi.hoisted(() => ({
  authState: {
    current: {
      user: null as User | null,
      logout: vi.fn(async () => {}),
      viewAs: null,
      setViewAs: vi.fn(async () => {}),
    },
  },
  analytics: { enabled: false },
  openCookieBanner: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
vi.mock('../lib/api', () => ({ api: { users: { list: () => new Promise(() => {}) } } }));
vi.mock('../lib/analytics', () => ({
  get ANALYTICS_ENABLED() {
    return analytics.enabled;
  },
}));
vi.mock('./AnalyticsGate', () => ({ openCookieBanner }));

import { ProfileView } from './ProfileView';

const user = (isAdmin: boolean): User => ({
  id: 'u1',
  email: 'pedro@example.com',
  name: 'Pedro',
  avatar_url: null,
  role: 'owner',
  role_info: { id: 'r1', name: isAdmin ? 'ADMIN' : 'AUTHENTICATED', label: isAdmin ? 'Admin' : 'Usuário', is_admin: isAdmin },
  permissions: [],
  has_password: false,
  has_google: true,
  invited_at: null,
  last_login_at: null,
  nickname: null,
});

function mount() {
  return render(
    <MemoryRouter initialEntries={['/settings/profile']}>
      <Routes>
        <Route path="/settings/profile" element={<ProfileView />} />
        <Route path="/login" element={<p>login-page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authState.current = { ...authState.current, user: user(false) };
  analytics.enabled = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProfileView', () => {
  it('shows who is signed in', () => {
    mount();
    expect(screen.getByText('Pedro')).toBeInTheDocument();
    expect(screen.getByText('pedro@example.com')).toBeInTheDocument();
  });

  it('offers Ver como… to admins only', () => {
    mount();
    expect(screen.queryByRole('button', { name: /Ver como/ })).toBeNull();
    cleanup();
    authState.current = { ...authState.current, user: user(true) };
    mount();
    expect(screen.getByRole('button', { name: /Ver como/ })).toBeInTheDocument();
  });

  it('Sair logs out and goes to the login page', async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    });
    expect(authState.current.logout).toHaveBeenCalledTimes(1);
    expect(screen.getByText('login-page')).toBeInTheDocument();
  });

  it('opens the account deletion dialog from the danger zone', () => {
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir minha conta' }));
    expect(screen.getByRole('dialog', { name: 'Excluir minha conta' })).toBeInTheDocument();
  });

  it('offers the cookie preferences only when analytics is on', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Preferências de cookies' })).toBeNull();
    cleanup();
    analytics.enabled = true;
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Preferências de cookies' }));
    expect(openCookieBanner).toHaveBeenCalledTimes(1);
  });
});
