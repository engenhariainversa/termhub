// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import type { User } from '../lib/types';

const { accountApi } = vi.hoisted(() => ({
  accountApi: {
    sendDeletionCode: vi.fn(async () => ({ ok: true as const, ttl_minutes: 10 })),
    requestDeletion: vi.fn(async (_reauth: unknown) => ({ pending: true, requested_at: '2026-10-01T12:00:00.000Z', scheduled_at: '2026-10-31T12:00:00.000Z' })),
  },
}));

const user: User = {
  id: 'u1',
  email: 'pedro@example.com',
  name: 'Pedro',
  avatar_url: null,
  role: 'member',
  role_info: null,
  permissions: [],
  has_password: true,
  has_google: false,
  invited_at: null,
  last_login_at: null,
  nickname: null,
  review_enabled_until: null,
  deletion_requested_at: null,
  deletion_scheduled_at: null,
};

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user, logout: vi.fn(async () => {}) }) }));
vi.mock('../lib/api', () => ({ api: { account: accountApi }, ApiError: class ApiError extends Error {} }));

import { DeleteAccountDialog } from './DeleteAccountDialog';

beforeEach(() => {
  void i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  void i18n.changeLanguage('pt-BR');
});

describe('DeleteAccountDialog in English', () => {
  it('explains the deletion and confirms it with an English date', async () => {
    render(
      <MemoryRouter>
        <DeleteAccountDialog open onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('dialog', { name: 'Delete my account' })).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('What is deleted')).toBeInTheDocument();
    expect(screen.getByText('What is kept')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 's3nha' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    });
    expect(screen.getByRole('dialog', { name: 'Account deactivated' })).toBeInTheDocument();
    expect(screen.getByText('October 31, 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to sign-in' })).toBeInTheDocument();
  });

  it('switches to the e-mailed code', () => {
    render(
      <MemoryRouter>
        <DeleteAccountDialog open onClose={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Get a code by email' }));
    expect(screen.getByRole('button', { name: 'Send code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use my password' })).toBeInTheDocument();
    expect(screen.getByText('pedro@example.com').closest('p')).toHaveTextContent('To confirm it is you, we send a 6-digit code to pedro@example.com.');
  });
});
