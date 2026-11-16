// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiTokensView, DEFAULT_DRAFT, eventPlace, filterOfDraft, mcpAddCommand, tokenPlace, tokenStatus } from './ApiTokensView';
import { ApiError } from '../lib/api';
import type { ApiToken, ApiTokenEvent, ApiTokensPage } from '../lib/types';

const listMock = vi.fn();
const createMock = vi.fn();
const revokeMock = vi.fn();
const eventsMock = vi.fn();
const facetsMock = vi.fn();
const revokeIdleMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      apiTokens: {
        list: (...a: unknown[]) => listMock(...a),
        create: (...a: unknown[]) => createMock(...a),
        revoke: (...a: unknown[]) => revokeMock(...a),
        events: (...a: unknown[]) => eventsMock(...a),
        facets: (...a: unknown[]) => facetsMock(...a),
        revokeIdle: (...a: unknown[]) => revokeIdleMock(...a),
      },
    },
  };
});

const authMock: { can: () => boolean; user?: { features: Record<string, boolean> } } = { can: () => true };
vi.mock('../lib/auth', () => ({ useAuth: () => authMock }));

const tok = (over: Partial<ApiToken> & { id: string }): ApiToken => ({
  user_id: 'u1',
  name: over.id,
  scopes: ['read'],
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_at: '2026-09-19T00:00:00.000Z',
  origin: 'person',
  project_id: null,
  project_name: null,
  machine_id: null,
  machine_name: null,
  ...over,
});

/** One page as the server answers it (TER-1191). */
const page = (tokens: ApiToken[], over: Partial<ApiTokensPage> = {}): ApiTokensPage => ({
  tokens,
  next: null,
  system: { active: 0, idle: 0 },
  retention: { system_days: 30, person_revoked_days: 90, idle_days: 7 },
  ...over,
});

const SECRET = 'thb_pat_' + 'A'.repeat(43);

beforeEach(() => {
  listMock.mockResolvedValue(page([]));
  facetsMock.mockResolvedValue({ projects: [], machines: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authMock.can = () => true;
  delete authMock.user;
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
    listMock.mockResolvedValue(
      page([
        tok({ id: 'laptop', scopes: ['read', 'terminals'] }),
        tok({ id: 'old', expires_at: '2000-01-01T00:00:00.000Z' }),
        tok({ id: 'gone', revoked_at: '2026-09-19T01:00:00.000Z' }),
      ]),
    );
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
    listMock.mockResolvedValue(page([tok({ id: 'concierge', scopes: ['read', 'memory'] })]));
    render(<ApiTokensView />);
    const row = (await screen.findByText('concierge')).closest('tr')!;
    expect(within(row).getByText('ler, memória')).toBeTruthy();
  });

  // TER-1176: the runs scope is offered only behind the runs_api flag
  it('does not offer the runs scope while runs_api is off', async () => {
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    expect(screen.getByLabelText(/^Memória \(gravar anotações\)/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Runs/)).toBeNull();
    expect(screen.queryByText(/Executar prompts nas suas contas e máquinas/)).toBeNull();
  });

  it('offers the runs scope with its explanation while runs_api is on and sends it on creation', async () => {
    authMock.user = { features: { runs_api: true } };
    createMock.mockResolvedValue({ api_token: tok({ id: 'new', name: 'ci', scopes: ['read', 'runs'] }), token: SECRET, mcp_url: null });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo token' }));
    expect(screen.getByText(/Executar prompts nas suas contas e máquinas/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'ci' } });
    fireEvent.click(screen.getByLabelText(/^Runs/));
    fireEvent.click(screen.getByLabelText(/^Ler/));
    fireEvent.click(screen.getByRole('button', { name: 'Criar token' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ name: 'ci', scopes: ['read', 'runs'], expires_in_days: 90 }));
  });

  it('revokes after confirmation', async () => {
    listMock.mockResolvedValue(page([tok({ id: 'laptop' })]));
    revokeMock.mockResolvedValue({ api_token: tok({ id: 'laptop', revoked_at: '2026-09-19T02:00:00.000Z' }) });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar laptop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledWith('laptop'));
    expect(await screen.findByText('revogado')).toBeTruthy();
  });

  it('clears a stale error once a later action succeeds', async () => {
    listMock.mockResolvedValue(page([tok({ id: 'laptop' })]));
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
    listMock.mockResolvedValue(page([tok({ id: 'laptop' })]));
    render(<ApiTokensView />);
    expect(await screen.findByText('laptop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Novo token' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revogar/ })).toBeNull();
  });
});

describe('token filters and pages (TER-1191)', () => {
  it('maps the draft to the server query: empty means any, a day\'s end is the next day\'s start', () => {
    expect(filterOfDraft(DEFAULT_DRAFT)).toEqual({ origin: 'person', status: 'active' });
    const f = filterOfDraft({ ...DEFAULT_DRAFT, origin: '', status: '', scope: 'read', project_id: 'p1', created_from: '2026-11-01', created_to: '2026-11-01', q: '  aba ' });
    expect(f).toMatchObject({ origin: undefined, status: undefined, scope: 'read', project_id: 'p1', q: 'aba' });
    expect(new Date(f.created_to!).getTime() - new Date(f.created_from!).getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('names where a token acts, by name or by id, and nothing for a person\'s own', () => {
    expect(tokenPlace(tok({ id: 'a', project_id: 'p1', project_name: 'termhub', machine_id: 'm1', machine_name: null }))).toBe('termhub · m1');
    expect(tokenPlace(tok({ id: 'b' }))).toBe('');
  });

  it('opens on "criados por mim · ativos", without the origin column', async () => {
    listMock.mockResolvedValue(page([tok({ id: 'laptop' })]));
    render(<ApiTokensView />);
    expect(await screen.findByText('laptop')).toBeTruthy();
    expect(listMock.mock.calls[0]).toEqual([expect.objectContaining({ origin: 'person', status: 'active' }), null]);
    expect((screen.getByLabelText('Origem') as HTMLSelectElement).value).toBe('person');
    expect((screen.getByLabelText('Estado') as HTMLSelectElement).value).toBe('active');
    expect(screen.queryByRole('columnheader', { name: 'Origem' })).toBeNull();
  });

  it('applies the filters on Filtrar, shows the origin and place, and Limpar goes back to the default', async () => {
    facetsMock.mockResolvedValue({ projects: [{ id: 'p1', name: 'termhub' }], machines: [{ id: 'm1', name: 'jarvis' }] });
    render(<ApiTokensView />);
    await screen.findByText('Nenhum token seu ativo.');
    await screen.findByRole('option', { name: 'termhub' });
    listMock.mockResolvedValue(page([tok({ id: 'aba «shell» (automático)', origin: 'tab', project_id: 'p1', project_name: 'termhub', machine_id: 'm1', machine_name: 'jarvis', revoked_at: '2026-11-01T00:00:00.000Z' })]));
    fireEvent.change(screen.getByLabelText('Origem'), { target: { value: 'system' } });
    fireEvent.change(screen.getByLabelText('Estado'), { target: { value: 'revoked' } });
    fireEvent.change(screen.getByLabelText('Projeto'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Escopo'), { target: { value: 'memory' } });
    fireEvent.change(screen.getByLabelText('Buscar pelo nome'), { target: { value: 'shell' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filtrar' }));
    const row = (await screen.findByText('aba «shell» (automático)')).closest('tr')!;
    expect(listMock.mock.calls[1]![0]).toMatchObject({ origin: 'system', status: 'revoked', project_id: 'p1', scope: 'memory', q: 'shell' });
    expect(within(row).getByText('Aba de agente')).toBeTruthy();
    expect(within(row).getByText('termhub · jarvis')).toBeTruthy();
    // the system group belongs to the default view only
    expect(screen.queryByRole('button', { name: /Gerados pelo sistema/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(3));
    expect(listMock.mock.calls[2]![0]).toEqual(filterOfDraft(DEFAULT_DRAFT));
  });

  it('loads the next page with the server\'s cursor and appends it', async () => {
    listMock.mockResolvedValueOnce(page([tok({ id: 'a' })], { next: 'c1' }));
    listMock.mockResolvedValueOnce(page([tok({ id: 'b' })]));
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('b')).toBeTruthy();
    expect(screen.getByText('a')).toBeTruthy();
    expect(listMock.mock.calls[1]![1]).toBe('c1');
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });

  it('keeps the system tokens in a collapsed group, loaded only when opened', async () => {
    listMock.mockResolvedValueOnce(page([tok({ id: 'laptop' })], { system: { active: 12, idle: 0 } }));
    listMock.mockResolvedValueOnce(page([tok({ id: 'concierge (automático)', origin: 'concierge' })]));
    render(<ApiTokensView />);
    const toggle = await screen.findByRole('button', { name: /Gerados pelo sistema · 12 ativos/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Revogar inativos/ })).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText('concierge (automático)')).toBeTruthy();
    expect(listMock.mock.calls[1]).toEqual([{ origin: 'system', status: 'active' }, null]);
    expect(screen.getByText(/somem depois de 30 dias/)).toBeTruthy();
  });

  it('"Revogar inativos" asks first, revokes on the server and reloads', async () => {
    listMock.mockResolvedValue(page([], { system: { active: 5, idle: 3 } }));
    revokeIdleMock.mockResolvedValue({ revoked: 3 });
    render(<ApiTokensView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar inativos (3)' }));
    expect(screen.getByText(/Revoga os 3 tokens do sistema sem uso há 7 dias/)).toBeTruthy();
    expect(revokeIdleMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(revokeIdleMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('3 tokens do sistema revogados.')).toBeTruthy();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('hides "Revogar inativos" without the delete permission', async () => {
    authMock.can = () => false;
    listMock.mockResolvedValue(page([], { system: { active: 5, idle: 3 } }));
    render(<ApiTokensView />);
    expect(await screen.findByRole('button', { name: /Gerados pelo sistema/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Revogar inativos/ })).toBeNull();
  });
});

describe('CopyField (via CreatedTokenModal)', () => {
  beforeEach(() => {
    listMock.mockResolvedValue(page([]));
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
    listMock.mockResolvedValue(page([tok({ id: 't1', name: 'laptop' })]));
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
