// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const statusMock = vi.fn();
const startMock = vi.fn();
const dismissMock = vi.fn(async () => ({ dismissed: true }));
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: { aiAccounts: { loginStatus: (...a: unknown[]) => statusMock(...a), startLogin: (...a: unknown[]) => startMock(...a), dismissLoginWarning: (...a: unknown[]) => dismissMock(...(a as [])), cancelLogin: async () => ({ cancelled: true }) } },
}));

import { resetAiLoginStatusForTests } from '../lib/ai-login-status';
import { AiLoginWarnings } from './AiLoginWarnings';

const row = (account_id: string, provider: 'claude' | 'chatgpt', machine_id: string, machine_name: string, state: 'ok' | 'login_required') => ({
  account_id,
  label: account_id,
  provider,
  machine_id,
  machine_name,
  state,
  checked_at: null,
  supported: true,
});

beforeEach(() => {
  statusMock.mockResolvedValue({
    accounts: [row('a', 'chatgpt', 'm1', 'hulk', 'login_required'), row('b', 'claude', 'm2', 'jarvis', 'login_required'), row('c', 'claude', 'm1', 'hulk', 'ok')],
  });
  startMock.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetAiLoginStatusForTests();
});

describe('AiLoginWarnings (TER-1047)', () => {
  it('lists every expired login, naming the CLI and the machine', async () => {
    render(<AiLoginWarnings />);
    expect(await screen.findByText('O login do Codex expirou em hulk')).toBeInTheDocument();
    expect(screen.getByText('O login do Claude expirou em jarvis')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it("shows only the machine's own accounts on its row, and opens the modal", async () => {
    render(<AiLoginWarnings machineId="m2" />);
    expect(await screen.findByText('O login do Claude expirou em jarvis')).toBeInTheDocument();
    expect(screen.queryByText(/Codex/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refazer login' }));
    expect(screen.getByRole('dialog', { name: 'Refazer login' })).toBeInTheDocument();
    expect(startMock).toHaveBeenCalledWith('b');
  });

  it('TER-1079: lists the logins about to expire, with the days left, apart from the expired ones', async () => {
    statusMock.mockResolvedValue({
      warn_days: 3,
      accounts: [
        { ...row('a', 'claude', 'm1', 'hulk', 'ok'), login_expires_at: '2026-10-16T12:00:00.000Z', expires_soon: true, expires_in_days: 3 },
        { ...row('b', 'claude', 'm2', 'jarvis', 'ok'), login_expires_at: '2026-10-14T12:00:00.000Z', expires_soon: true, expires_in_days: 1 },
        // known, but outside the person's window
        { ...row('c', 'claude', 'm1', 'hulk', 'ok'), login_expires_at: '2026-10-30T12:00:00.000Z', expires_soon: false, expires_in_days: 17 },
        row('d', 'chatgpt', 'm1', 'hulk', 'login_required'),
      ],
    });
    render(<AiLoginWarnings />);
    expect(await screen.findByText('O login do Claude em hulk expira em 3 dias')).toBeInTheDocument();
    expect(screen.getByText('O login do Claude em jarvis expira em 1 dia')).toBeInTheDocument();
    const soon = screen.getByRole('list', { name: 'Logins de IA prestes a expirar' });
    expect(soon.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'Logins de IA expirados' }).querySelectorAll('li')).toHaveLength(1);
    fireEvent.click(soon.querySelectorAll('button')[1]);
    expect(startMock).toHaveBeenCalledWith('b');
  });

  it('shows nothing when every login is fine', async () => {
    statusMock.mockResolvedValue({ accounts: [row('c', 'claude', 'm1', 'hulk', 'ok')] });
    const { container } = render(<AiLoginWarnings />);
    await vi.waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AiLoginWarnings: dismissed and unused accounts (TER-1212)', () => {
  it('no line for an account nothing uses, nor for one already dismissed', async () => {
    statusMock.mockResolvedValue({
      accounts: [
        { ...row('a', 'chatgpt', 'm1', 'hulk', 'login_required'), in_use: false },
        { ...row('b', 'claude', 'm2', 'jarvis', 'login_required'), dismissed: true },
        { ...row('c', 'claude', 'm1', 'gaviao', 'login_required'), in_use: true },
        { ...row('d', 'claude', 'm1', 'hulk', 'ok'), expires_soon: true, expires_in_days: 2, in_use: false },
      ],
    });
    render(<AiLoginWarnings />);
    expect(await screen.findByText('O login do Claude expirou em gaviao')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('"Dispensar" hides the line at once and saves it on the server', async () => {
    render(<AiLoginWarnings machineId="m2" />);
    expect(await screen.findByText('O login do Claude expirou em jarvis')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar o aviso de b' }));
    expect(screen.queryByText('O login do Claude expirou em jarvis')).not.toBeInTheDocument();
    expect(dismissMock).toHaveBeenCalledWith('b');
  });

  it('a failed dismissal brings the line back', async () => {
    dismissMock.mockRejectedValueOnce(new Error('offline'));
    render(<AiLoginWarnings machineId="m2" />);
    expect(await screen.findByText('O login do Claude expirou em jarvis')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar o aviso de b' }));
    expect(await screen.findByText('O login do Claude expirou em jarvis')).toBeInTheDocument();
  });
});
