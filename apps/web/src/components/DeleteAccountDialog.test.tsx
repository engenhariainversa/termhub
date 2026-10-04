// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../lib/types';

const { authState, accountApi } = vi.hoisted(() => ({
  authState: { current: { user: null as User | null, logout: vi.fn(async () => {}) } },
  accountApi: {
    sendDeletionCode: vi.fn(async () => ({ ok: true as const, ttl_minutes: 10 })),
    requestDeletion: vi.fn(async (_reauth: unknown) => ({ pending: true, requested_at: '2026-10-01T12:00:00.000Z', scheduled_at: '2026-10-31T12:00:00.000Z' })),
  },
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
vi.mock('../lib/api', () => ({
  api: { account: accountApi },
  ApiError: class ApiError extends Error {},
}));

import { ApiError } from '../lib/api';
import { takeDeletionNotice } from '../lib/account-deletion';
import { DeleteAccountDialog } from './DeleteAccountDialog';

const user = (hasPassword: boolean): User => ({
  id: 'u1',
  email: 'pedro@example.com',
  name: 'Pedro',
  avatar_url: null,
  role: 'member',
  role_info: null,
  permissions: [],
  has_password: hasPassword,
  has_google: !hasPassword,
  invited_at: null,
  last_login_at: null,
  nickname: null,
  review_enabled_until: null,
  deletion_requested_at: null,
  deletion_scheduled_at: null,
});

const onClose = vi.fn();
function mount() {
  return render(
    <MemoryRouter initialEntries={['/settings/profile']}>
      <Routes>
        <Route path="/settings/profile" element={<DeleteAccountDialog open onClose={onClose} />} />
        <Route path="/login" element={<p>login-page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const confirmButton = () => screen.getByRole('button', { name: 'Excluir minha conta' });

beforeEach(() => {
  authState.current = { ...authState.current, user: user(true) };
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DeleteAccountDialog', () => {
  it('explains what is deleted, what is kept and the 30-day window', () => {
    mount();
    expect(screen.getByText(/30 dias/)).toBeInTheDocument();
    expect(screen.getByText('O que é excluído')).toBeInTheDocument();
    expect(screen.getByText(/registros de acesso ficam guardados por 6 meses/)).toBeInTheDocument();
  });

  it('confirms with the password when the account has one', async () => {
    mount();
    expect(confirmButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Sua senha'), { target: { value: 's3nha' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(accountApi.requestDeletion).toHaveBeenCalledWith({ password: 's3nha' });
    expect(accountApi.sendDeletionCode).not.toHaveBeenCalled();
  });

  it('confirms with an e-mailed code when the account has no password', async () => {
    authState.current = { ...authState.current, user: user(false) };
    mount();
    expect(screen.queryByLabelText('Sua senha')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enviar código' }));
    });
    expect(accountApi.sendDeletionCode).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Código de 6 dígitos'), { target: { value: '12a3456' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(accountApi.requestDeletion).toHaveBeenCalledWith({ code: '123456' });
  });

  it('lets an account with a password choose the code instead', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Receber código por e-mail' }));
    expect(screen.queryByLabelText('Sua senha')).toBeNull();
    expect(screen.getByRole('button', { name: 'Enviar código' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Usar minha senha' })).toBeInTheDocument();
  });

  it('shows the server refusal and stays open', async () => {
    accountApi.requestDeletion.mockRejectedValueOnce(new (ApiError as unknown as new (m: string) => Error)('Senha incorreta'));
    mount();
    fireEvent.change(screen.getByLabelText('Sua senha'), { target: { value: 'errada' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(screen.getByText('Senha incorreta')).toBeInTheDocument();
    expect(authState.current.logout).not.toHaveBeenCalled();
  });

  it('on success says when the account goes, keeps the notice for the login page and leads there', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Sua senha'), { target: { value: 's3nha' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(screen.getByRole('dialog', { name: 'Conta desativada' })).toBeInTheDocument();
    expect(screen.getByText('31 de outubro de 2026')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ir para o login' }));
    });
    expect(authState.current.logout).toHaveBeenCalledTimes(1);
    expect(screen.getByText('login-page')).toBeInTheDocument();
    expect(takeDeletionNotice()).toBe('2026-10-31T12:00:00.000Z');
    expect(takeDeletionNotice()).toBeNull();
  });
});
