// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSession } from '../lib/types';

// vi.mock factories are hoisted: everything they touch comes through vi.hoisted().
const { authState, auth } = vi.hoisted(() => ({
  authState: { current: { user: { has_password: true } as Record<string, unknown> | null, logout: vi.fn(async () => {}), refresh: vi.fn(async () => {}) } },
  auth: {
    sessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
    changePassword: vi.fn(),
  },
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
vi.mock('../lib/api', () => ({
  api: { auth },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  },
}));

import { describeUserAgent, SecurityView } from './SecurityView';

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';

const session = (over: Partial<WebSession>): WebSession => ({
  id: 's1', created_at: '2026-10-01T10:00:00.000Z', last_used_at: '2026-10-07T10:00:00.000Z', expires_at: '2026-10-31T10:00:00.000Z',
  ip: '10.0.0.1', user_agent: CHROME_MAC, current: true, ...over,
});

const mount = () =>
  render(
    <MemoryRouter>
      <SecurityView />
    </MemoryRouter>,
  );

beforeEach(() => {
  authState.current.user = { has_password: true };
  for (const fn of Object.values(auth)) fn.mockReset();
  auth.sessions.mockResolvedValue({ sessions: [session({}), session({ id: 's2', ip: '10.0.0.2', user_agent: FIREFOX_LINUX, current: false })] });
});
afterEach(cleanup);

describe('describeUserAgent', () => {
  it('names the browser and the system', () => {
    expect(describeUserAgent(CHROME_MAC)).toBe('Chrome · macOS');
    expect(describeUserAgent(FIREFOX_LINUX)).toBe('Firefox · Linux');
    expect(describeUserAgent('curl/8.0')).toBeNull();
    expect(describeUserAgent(null)).toBeNull();
  });
});

describe('SecurityView', () => {
  it('lists the sessions and marks this one', async () => {
    mount();
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('esta sessão')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Firefox · Linux')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('10.0.0.2')).toBeInTheDocument();
  });

  it('signs every other device out after confirming', async () => {
    auth.revokeOtherSessions.mockResolvedValue({ revoked: 1 });
    mount();
    await screen.findAllByRole('row');
    fireEvent.click(screen.getByRole('button', { name: 'Sair de todos os outros aparelhos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sair dos outros' }));
    await waitFor(() => expect(auth.revokeOtherSessions).toHaveBeenCalled());
    expect(await screen.findByText('1 sessão encerrada.')).toBeInTheDocument();
  });

  it('ends one other session', async () => {
    auth.revokeSession.mockResolvedValue({ ok: true, current: false });
    mount();
    const rows = await screen.findAllByRole('row');
    fireEvent.click(within(rows[2]!).getByRole('button', { name: 'Encerrar' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Encerrar' }));
    await waitFor(() => expect(auth.revokeSession).toHaveBeenCalledWith('s2'));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
  });

  it('asks for the current password and checks the repeat before saving', async () => {
    auth.changePassword.mockResolvedValue({ ok: true, revoked: 0 });
    mount();
    fireEvent.change(screen.getByLabelText('Senha atual'), { target: { value: 'old-secret' } });
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'brand-new-pass' } });
    fireEvent.change(screen.getByLabelText('Repita a nova senha'), { target: { value: 'something-else' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar senha' }));
    expect(await screen.findByText('As senhas não conferem.')).toBeInTheDocument();
    expect(auth.changePassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Repita a nova senha'), { target: { value: 'brand-new-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar senha' }));
    await waitFor(() => expect(auth.changePassword).toHaveBeenCalledWith('old-secret', 'brand-new-pass'));
    expect(await screen.findByText('Senha salva.')).toBeInTheDocument();
  });

  it('sets a first password without a current one', async () => {
    authState.current.user = { has_password: false };
    auth.changePassword.mockResolvedValue({ ok: true, revoked: 2 });
    mount();
    expect(screen.getByRole('heading', { name: 'Definir senha' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Senha atual')).toBeNull();
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'brand-new-pass' } });
    fireEvent.change(screen.getByLabelText('Repita a nova senha'), { target: { value: 'brand-new-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar senha' }));
    await waitFor(() => expect(auth.changePassword).toHaveBeenCalledWith(null, 'brand-new-pass'));
    expect(await screen.findByText('Senha salva. 2 outras sessões foram encerradas.')).toBeInTheDocument();
    expect(authState.current.refresh).toHaveBeenCalled();
  });
});
