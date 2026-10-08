// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startMock = vi.fn();
const submitMock = vi.fn();
const cancelMock = vi.fn();
const resumeMock = vi.fn();
const statusMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      aiAccounts: {
        startLogin: (...a: unknown[]) => startMock(...a),
        submitLogin: (...a: unknown[]) => submitMock(...a),
        cancelLogin: (...a: unknown[]) => cancelMock(...a),
        resumeAfterLogin: (...a: unknown[]) => resumeMock(...a),
        loginStatus: (...a: unknown[]) => statusMock(...a),
      },
    },
  };
});

import { ApiError } from '../lib/api';
import { AiLoginDialog, type AiLoginTarget } from './AiLoginDialog';

const claude: AiLoginTarget = { account_id: 'acc1', label: 'Claude pessoal', provider: 'claude', machine_name: 'hulk', supported: true };
const codex: AiLoginTarget = { account_id: 'acc2', label: 'Codex', provider: 'chatgpt', machine_name: 'hulk', supported: true };
const expires = '2026-10-08T15:30:00.000Z';

beforeEach(() => {
  cancelMock.mockResolvedValue({ cancelled: true });
  statusMock.mockResolvedValue({ accounts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AiLoginDialog (TER-1047)', () => {
  it('Claude: opens the page, sends the pasted code, then resumes the stuck tabs', async () => {
    startMock.mockResolvedValue({ login_id: 'L1', url: 'https://claude.com/cai/oauth/authorize?x=1', user_code: null, needs_code: true, expires_at: expires });
    submitMock.mockResolvedValue({ ok: true, message: null, stuck_tabs: [{ id: 't1', name: 'api', project_id: 'p' }, { id: 't2', name: 'web', project_id: 'p' }] });
    resumeMock.mockResolvedValue({ resumed: ['t1', 't2'] });
    const onLoggedIn = vi.fn();
    render(<AiLoginDialog account={claude} onClose={() => {}} onLoggedIn={onLoggedIn} />);

    expect(screen.getByText('Abrindo o login na máquina…')).toBeInTheDocument();
    expect(screen.getByText(/Claude pessoal em hulk/)).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'Abrir página de login' });
    expect(link).toHaveAttribute('href', 'https://claude.com/cai/oauth/authorize?x=1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/O link expira às/)).toBeInTheDocument();
    expect(startMock).toHaveBeenCalledWith('acc1');

    const input = screen.getByLabelText('Cole o código aqui');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(screen.getByRole('button', { name: 'Enviar código' })).toBeDisabled();
    fireEvent.change(input, { target: { value: ' abc#123 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar código' }));

    expect(await screen.findByText('Login refeito')).toBeInTheDocument();
    expect(submitMock).toHaveBeenCalledWith('acc1', 'L1', 'abc#123');
    expect(onLoggedIn).toHaveBeenCalled();
    expect(screen.getByText('Retomar 2 abas?')).toBeInTheDocument();
    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }));
    expect(await screen.findByText('2 abas retomadas')).toBeInTheDocument();
    expect(resumeMock).toHaveBeenCalledWith('acc1', ['t1', 't2']);

    // the flow ended: closing now cancels nothing
    fireEvent.click(screen.getAllByRole('button', { name: 'Fechar' })[0]!);
    cleanup();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('Claude: a code the CLI refuses ends the flow and offers to start again', async () => {
    startMock.mockResolvedValue({ login_id: 'L1', url: 'https://claude.com/x', user_code: null, needs_code: true, expires_at: expires });
    submitMock.mockResolvedValue({ ok: false, message: 'Código inválido', stuck_tabs: [] });
    render(<AiLoginDialog account={claude} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Cole o código aqui'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar código' }));
    // the CLI's output is a detail behind a toggle, not the error itself
    expect(await screen.findByRole('alert')).toHaveTextContent('O login não foi confirmado');
    expect(screen.getByText('Saída da CLI')).toBeInTheDocument();
    expect(screen.getByText('Código inválido')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(2));
    // the field starts empty again: the code is never kept
    expect(await screen.findByLabelText('Cole o código aqui')).toHaveValue('');
  });

  it('Codex: shows the device code, "Já autorizei", and lets it check again when not confirmed yet', async () => {
    startMock.mockResolvedValue({ login_id: 'L2', url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-EFGH1', needs_code: false, expires_at: expires });
    submitMock.mockResolvedValueOnce({ ok: false, message: 'Ainda não autorizado', stuck_tabs: [] }).mockResolvedValueOnce({ ok: true, message: null, stuck_tabs: [] });
    render(<AiLoginDialog account={codex} onClose={() => {}} />);

    expect(await screen.findByText('ABCD-EFGH1')).toBeInTheDocument();
    expect(screen.getByText('Digite este código na página')).toBeInTheDocument();
    expect(screen.queryByLabelText('Cole o código aqui')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Já autorizei' }));
    expect(await screen.findByText('Ainda não autorizado')).toBeInTheDocument();
    expect(submitMock).toHaveBeenLastCalledWith('acc2', 'L2', null);
    // the same flow goes on
    fireEvent.click(screen.getByRole('button', { name: 'Verificar de novo' }));
    expect(await screen.findByText('Login refeito')).toBeInTheDocument();
    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Retomar/)).not.toBeInTheDocument();
  });

  it('a login the CLI finished on its own in the machine\'s browser is a success, not an error (TER-1054)', async () => {
    startMock.mockResolvedValue({ login_id: 'L3', url: null, user_code: null, needs_code: false, expires_at: expires, logged_in: true, stuck_tabs: [{ id: 't1', name: 'api', project_id: 'p' }] });
    const onLoggedIn = vi.fn();
    render(<AiLoginDialog account={claude} onClose={() => {}} onLoggedIn={onLoggedIn} />);
    expect(await screen.findByText('Login refeito')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onLoggedIn).toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalled();
    expect(screen.getByText('Retomar 1 aba?')).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
    cleanup();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('Claude: "Já entrei pelo navegador da máquina" checks the login without a code (TER-1054)', async () => {
    startMock.mockResolvedValue({ login_id: 'L4', url: 'https://claude.com/x', user_code: null, needs_code: true, expires_at: expires, logged_in: false, stuck_tabs: [] });
    submitMock.mockResolvedValue({ ok: true, message: null, stuck_tabs: [] });
    render(<AiLoginDialog account={claude} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Já entrei pelo navegador da máquina' }));
    expect(await screen.findByText('Login refeito')).toBeInTheDocument();
    expect(submitMock).toHaveBeenCalledWith('acc1', 'L4', null);
  });

  it('a start that fails on the machine says so and keeps the CLI output as a detail', async () => {
    startMock.mockRejectedValue(new ApiError(502, 'error: network unreachable', 'MACHINE_FAILED'));
    render(<AiLoginDialog account={claude} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Não deu para abrir o login na máquina');
    expect(screen.getByRole('alert')).not.toHaveTextContent('network unreachable');
    expect(screen.getByText('error: network unreachable')).toBeInTheDocument();
  });

  it("shows the server's message when the login cannot start (outdated agent)", async () => {
    startMock.mockRejectedValue(new ApiError(409, 'Atualize o agente desta máquina para refazer o login', 'AGENT_OUTDATED'));
    render(<AiLoginDialog account={claude} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Atualize o agente desta máquina para refazer o login');
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
  });

  it('cancels the flow on the machine when closed before the end', async () => {
    startMock.mockResolvedValue({ login_id: 'L9', url: 'https://claude.com/x', user_code: null, needs_code: true, expires_at: expires });
    const onClose = vi.fn();
    render(<AiLoginDialog account={claude} onClose={onClose} />);
    await screen.findByRole('link', { name: 'Abrir página de login' });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
    expect(cancelMock).toHaveBeenCalledWith('acc1', 'L9');
    // the server re-checked the login on cancel: the warnings re-read it
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    cleanup();
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it('only explains the manual login where the modal cannot do it', () => {
    render(<AiLoginDialog account={{ account_id: 'g', label: 'Gemini', provider: 'gemini', machine_name: 'hulk', supported: false }} onClose={() => {}} />);
    expect(screen.getByText('Abra um terminal nessa máquina e rode o login da CLI:')).toBeInTheDocument();
    expect(startMock).not.toHaveBeenCalled();
  });
});
