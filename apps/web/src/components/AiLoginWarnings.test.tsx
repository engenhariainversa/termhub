// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const statusMock = vi.fn();
const startMock = vi.fn();
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: { aiAccounts: { loginStatus: (...a: unknown[]) => statusMock(...a), startLogin: (...a: unknown[]) => startMock(...a), cancelLogin: async () => ({ cancelled: true }) } },
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

  it('shows nothing when every login is fine', async () => {
    statusMock.mockResolvedValue({ accounts: [row('c', 'claude', 'm1', 'hulk', 'ok')] });
    const { container } = render(<AiLoginWarnings />);
    await vi.waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
