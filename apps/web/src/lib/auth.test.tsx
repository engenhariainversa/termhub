// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const trackMock = vi.fn();
vi.mock('./analytics', () => ({ track: (...args: unknown[]) => trackMock(...args) }));

const user = { id: 'u1', email: 'a@b.c', name: 'A' };
vi.mock('./api', () => ({
  api: {
    auth: {
      me: vi.fn(async () => ({ user: null, config: {} }) as { user: unknown }),
      login: vi.fn(async () => ({ user })),
      verifyCode: vi.fn(async () => ({ user })),
    },
  },
  ApiError: class ApiError extends Error {},
}));

import { api } from './api';
import { AuthProvider, useAuth } from './auth';

type Auth = ReturnType<typeof useAuth>;
function Probe({ onReady }: { onReady: (auth: Auth) => void }) {
  onReady(useAuth());
  return null;
}

function mount() {
  let auth!: Auth;
  render(
    <AuthProvider>
      <Probe onReady={(a) => (auth = a)} />
    </AuthProvider>,
  );
  return () => auth;
}

afterEach(() => {
  cleanup();
  trackMock.mockReset();
});

describe('AuthProvider analytics', () => {
  it('reports a password login', async () => {
    const auth = mount();
    await act(() => auth().login('a@b.c', 'pw'));
    expect(trackMock).toHaveBeenCalledWith('login', { method: 'password' });
  });

  it('reports an e-mail code login', async () => {
    const auth = mount();
    await act(() => auth().verifyCode('a@b.c', '123456'));
    expect(trackMock).toHaveBeenCalledWith('login', { method: 'code' });
  });
});

describe('AuthProvider pending deletion', () => {
  it('refetches the user when a request answers ACCOUNT_PENDING_DELETION', async () => {
    const auth = mount();
    await act(async () => {});
    const pending = { ...user, deletion_scheduled_at: '2026-10-31T12:00:00.000Z' };
    vi.mocked(api.auth.me).mockResolvedValueOnce({ user: pending });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('termhub:pending-deletion'));
    });
    expect(auth().user).toEqual(pending);
  });
});
