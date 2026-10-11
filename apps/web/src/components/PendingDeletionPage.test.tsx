// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { authState, accountApi, dataMounted } = vi.hoisted(() => ({
  authState: {
    current: {
      user: null as { deletion_scheduled_at: string | null } | null,
      loading: false,
      legal: { pending: [], upcoming: [] },
      refresh: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
    },
  },
  accountApi: { cancelDeletion: vi.fn(async () => ({ pending: false, requested_at: null, scheduled_at: null })) },
  dataMounted: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
vi.mock('../lib/api', () => ({ api: { account: accountApi }, ApiError: class ApiError extends Error {} }));
// AppShell's providers: the gate must not mount them (nothing loads or polls for a deactivated account).
vi.mock('../lib/data', () => ({
  DataProvider: ({ children }: { children: ReactNode }) => {
    dataMounted();
    return <>{children}</>;
  },
}));
vi.mock('../lib/monitor', () => ({ MonitorProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../lib/project-groups', () => ({ ProjectGroupsProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../lib/toast', () => ({ ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>, Toaster: () => null }));
vi.mock('./NeedsYouToasts', () => ({ NeedsYouToasts: () => null }));
vi.mock('./NicknamePrompt', () => ({ NicknamePrompt: () => null }));

import { AppShell } from './Layout';
import { PendingDeletionPage } from './PendingDeletionPage';

const SCHEDULED = '2026-10-31T12:00:00.000Z';

function mountShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<p>app-home</p>} />
        </Route>
        <Route path="/login" element={<p>login-page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('pending account deletion', () => {
  it('AppShell shows the gate instead of the app, without mounting its data providers', () => {
    authState.current = { ...authState.current, user: { deletion_scheduled_at: SCHEDULED } };
    mountShell();
    expect(screen.getByRole('heading', { name: 'Sua conta será excluída em 31 de outubro de 2026' })).toBeInTheDocument();
    expect(screen.queryByText('app-home')).toBeNull();
    expect(dataMounted).not.toHaveBeenCalled();
  });

  it('AppShell shows the app when no deletion is pending', () => {
    authState.current = { ...authState.current, user: { deletion_scheduled_at: null } };
    mountShell();
    expect(screen.getByText('app-home')).toBeInTheDocument();
  });

  it('Cancelar exclusão calls DELETE and refetches the user', async () => {
    render(
      <MemoryRouter>
        <PendingDeletionPage scheduledAt={SCHEDULED} />
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar exclusão' }));
    });
    expect(accountApi.cancelDeletion).toHaveBeenCalledTimes(1);
    expect(authState.current.refresh).toHaveBeenCalledTimes(1);
  });

  it('Sair logs out and goes to the login page', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<PendingDeletionPage scheduledAt={SCHEDULED} />} />
          <Route path="/login" element={<p>login-page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    });
    expect(authState.current.logout).toHaveBeenCalledTimes(1);
    expect(accountApi.cancelDeletion).not.toHaveBeenCalled();
    expect(screen.getByText('login-page')).toBeInTheDocument();
  });
});
