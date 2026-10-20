// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiTokensView, eventPlace, mcpAddCommand, tokenStatus } from './ApiTokensView';
import { ApiError } from '../lib/api';
import type { ApiToken, ApiTokenEvent } from '../lib/types';

const listMock = vi.fn();
const createMock = vi.fn();
const revokeMock = vi.fn();
const eventsMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: { apiTokens: { list: (...a: unknown[]) => listMock(...a), create: (...a: unknown[]) => createMock(...a), revoke: (...a: unknown[]) => revokeMock(...a), events: (...a: unknown[]) => eventsMock(...a) } },
  };
});

const authMock = { can: () => true };
vi.mock('../lib/auth', () => ({ useAuth: () => authMock }));

const tok = (over: Partial<ApiToken> & { id: string }): ApiToken => ({
  user_id: 'u1',
  name: over.id,
  scopes: ['read'],
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_at: '2026-09-19T00:00:00.000Z',
  ...over,
});

const SECRET = 'thb_pat_' + 'A'.repeat(43);

beforeEach(() => {
  listMock.mockResolvedValue({ tokens: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authMock.can = () => true;
});

describe('tokenStatus', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  it('is revoked, expired or active', () => {
    expect(tokenStatus(tok({ id: 'a', revoked_at: '2026-09-19T01:00:00.000Z' }), now)).toBe('revoked');
    expect(tokenStatus(tok({ id: 'b', expires_at: '2026-09-19T11:59:59.000Z' }), now)).toBe('expired');
    expect(tokenStatus(tok({ id: 'c', expires_at: '2026-09-20T00:00:00.000Z' }), now)).toBe('active');
    expect(tokenStatus(tok({ id: 'd' }), now)).toBe('active');
  });
});

describe('mcpAddCommand', () => {
  it('builds the claude mcp add command', () => {
    expect(mcpAddCommand('https://termhub.dev/mcp', SECRET)).toBe(`claude mcp add --transport http termhub https://termhub.dev/mcp --header "Authorization: Bearer ${SECRET}"`);
  });
});

describe('ApiTokensView', () => {
  it('lists tokens with their status', async () => {
    listMock.mockResolvedValue({
      tokens: [
        tok({ id: 'laptop', scopes: ['read', 'terminals'] }),
        tok({ id: 'old', expires_at: '2000-01-01T00:00:00.000Z' }),
        tok({ id: 'gone', revoked_at: '2026-09-19T01:00:00.000Z' }),
      ],
    });
    render(<ApiTokensView />);
    const laptop = (await screen.findByText('laptop')).closest('tr')!;
    expect(within(laptop).getByText('ler, terminais')).toBeTruthy();
    expect(within(laptop).getByText('nunca')).toBeTruthy();
    expect(within(screen.getByText('old').closest('tr')!).getByText('expirado')).toBeTruthy();
    expect(within(screen.getByText('gone').closest('tr')!).getByText('revogado')).toBeTruthy();
    expect(within(screen.getByText('gone').closest('tr')!).queryByRole('button', { name: /Revogar/ })).toBeNull();
  });

  it('creates a token, shows it once with the mcp command, and forgets it on close', async () => {
    createMock.mockResolvedValue({ api_token: tok({ id: 'new', name: 'laptop', scopes: ['read', 'tasks'] }), token: SECRET, mcp_url: 'https://termhub.dev/mcp' });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));

    const create = screen.getByRole('button', { name: 'Criar token' });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: '  laptop ' } });
    fireEvent.click(screen.getByLabelText(/^Ler/));
    fireEvent.click(screen.getByLabelText(/^Tarefas/));
    fireEvent.change(screen.getByLabelText('Validade'), { target: { value: '30' } });
    fireEvent.click(create);

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ name: 'laptop', scopes: ['read', 'tasks'], expires_in_days: 30 }));
    expect(await screen.findByDisplayValue(SECRET)).toBeTruthy();
    expect(screen.getByText(/não aparece de novo/)).toBeTruthy();
    expect(screen.getByDisplayValue(mcpAddCommand('https://termhub.dev/mcp', SECRET))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Concluído' }));
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    expect(await screen.findByText('laptop')).toBeTruthy();
  });

  it('hides the mcp command when the server has no MCP_URL', async () => {
    createMock.mockResolvedValue({ api_token: tok({ id: 'new' }), token: SECRET, mcp_url: null });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText(/^Ler/));
    fireEvent.click(screen.getByRole('button', { name: 'Criar token' }));
    expect(await screen.findByDisplayValue(SECRET)).toBeTruthy();
    expect(screen.queryByDisplayValue(/claude mcp add/)).toBeNull();
  });

  it('keeps Criar token disabled without a name or a scope', async () => {
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    const create = screen.getByRole('button', { name: 'Criar token' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'x' } });
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/^Terminais/));
    expect(create.disabled).toBe(false);
  });

  it('offers the memory scope with its checkbox and sends it on creation', async () => {
    createMock.mockResolvedValue({ api_token: tok({ id: 'new', name: 'concierge', scopes: ['memory'] }), token: SECRET, mcp_url: 'https://termhub.dev/mcp' });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'concierge' } });
    fireEvent.click(screen.getByLabelText(/^Memória \(gravar anotações\)/));
    fireEvent.click(screen.getByRole('button', { name: 'Criar token' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ name: 'concierge', scopes: ['memory'], expires_in_days: 90 }));
  });

  it('shows the memory scope short label in the token list', async () => {
    listMock.mockResolvedValue({ tokens: [tok({ id: 'concierge', scopes: ['read', 'memory'] })] });
    render(<ApiTokensView />);
    const row = (await screen.findByText('concierge')).closest('tr')!;
    expect(within(row).getByText('ler, memória')).toBeTruthy();
  });

  it('revokes after confirmation', async () => {
    listMock.mockResolvedValue({ tokens: [tok({ id: 'laptop' })] });
    revokeMock.mockResolvedValue({ api_token: tok({ id: 'laptop', revoked_at: '2026-09-19T02:00:00.000Z' }) });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar laptop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledWith('laptop'));
    expect(await screen.findByText('revogado')).toBeTruthy();
  });

  it('clears a stale error once a later action succeeds', async () => {
    listMock.mockResolvedValue({ tokens: [tok({ id: 'laptop' })] });
    revokeMock.mockRejectedValueOnce(new ApiError('Erro ao revogar token'));
    revokeMock.mockResolvedValueOnce({ api_token: tok({ id: 'laptop', revoked_at: '2026-09-19T02:00:00.000Z' }) });
    render(<ApiTokensView />);

    fireEvent.click(await screen.findByRole('button', { name: 'Revogar laptop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    expect(await screen.findByText('Erro ao revogar token')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Revogar laptop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('revogado')).toBeTruthy();
    expect(screen.queryByText('Erro ao revogar token')).toBeNull();
  });

  it('keeps the secret in the "Token criado" panel through Escape and a backdrop click; only Concluído closes it', async () => {
    createMock.mockResolvedValue({ api_token: tok({ id: 'new', name: 'laptop' }), token: SECRET, mcp_url: null });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'laptop' } });
    fireEvent.click(screen.getByLabelText(/^Ler/));
    fireEvent.click(screen.getByRole('button', { name: 'Criar token' }));
    expect(await screen.findByDisplayValue(SECRET)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByDisplayValue(SECRET)).toBeTruthy();

    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(screen.getByDisplayValue(SECRET)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Concluído' }));
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
  });

  it('hides the create/revoke actions when the user lacks permission', async () => {
    authMock.can = () => false;
    listMock.mockResolvedValue({ tokens: [tok({ id: 'laptop' })] });
    render(<ApiTokensView />);
    expect(await screen.findByText('laptop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Novo token' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revogar/ })).toBeNull();
  });
});

describe('CopyField (via CreatedTokenModal)', () => {
  beforeEach(() => {
    listMock.mockResolvedValue({ tokens: [] });
  });

  const openCreatedTokenModal = async () => {
    createMock.mockResolvedValue({ api_token: tok({ id: 'new', name: 'laptop' }), token: SECRET, mcp_url: null });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'laptop' } });
    fireEvent.click(screen.getByLabelText(/^Ler/));
    fireEvent.click(screen.getByRole('button', { name: 'Criar token' }));
    await screen.findByDisplayValue(SECRET);
  };

  it('shows "Copiado" then reverts to "Copiar" after a successful copy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      await openCreatedTokenModal();
      fireEvent.click(screen.getAllByRole('button', { name: 'Copiar' })[0]);
      expect(writeText).toHaveBeenCalledWith(SECRET);
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Copiado' })[0]).toBeTruthy());

      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Copiar' })[0]).toBeTruthy());
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('shows "Selecione e copie" when the clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      await openCreatedTokenModal();
      fireEvent.click(screen.getAllByRole('button', { name: 'Copiar' })[0]);
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Selecione e copie' })[0]).toBeTruthy());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows "Selecione e copie" when there is no clipboard API (non-secure context)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    try {
      await openCreatedTokenModal();
      fireEvent.click(screen.getAllByRole('button', { name: 'Copiar' })[0]);
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Selecione e copie' })[0]).toBeTruthy());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('token activity (TER-577)', () => {
  const ev = (over: Partial<ApiTokenEvent> & { id: string }): ApiTokenEvent => ({
    tool: 'read_screen',
    ok: true,
    error_code: null,
    duration_ms: 42,
    machine_id: 'm1',
    machine_name: 'jarvis',
    project_id: 'p1',
    project_name: 'termhub',
    tab_id: null,
    tab_name: null,
    attachment_id: null,
    created_at: '2026-10-07T12:00:00.000Z',
    ...over,
  });

  it('names where a call acted, falling back to the id of a row that is gone', () => {
    expect(eventPlace(ev({ id: 'e1' }))).toBe('jarvis · termhub');
    expect(eventPlace(ev({ id: 'e2', machine_name: null, project_id: null, project_name: null }))).toBe('m1');
  });

  it('opens the MCP calls of a token, with failures and their code', async () => {
    listMock.mockResolvedValue({ tokens: [tok({ id: 't1', name: 'laptop' })] });
    eventsMock.mockResolvedValue({ events: [ev({ id: 'e1' }), ev({ id: 'e2', tool: 'send_input', ok: false, error_code: 'TOOL_NOT_ALLOWED' })], retention_days: 30 });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Atividade de laptop' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('send_input');
    expect(eventsMock).toHaveBeenCalledWith('t1');
    expect(within(dialog).getByText('TOOL_NOT_ALLOWED')).toBeTruthy();
    expect(within(dialog).getAllByText('jarvis · termhub')).toHaveLength(2);
    expect(within(dialog).getByText('Chamadas ao MCP dos últimos 30 dias, as mais recentes primeiro.')).toBeTruthy();
  });
});
