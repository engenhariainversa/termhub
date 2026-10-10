// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecurityEventsView, dayStart, metaText } from './SecurityEventsView';
import type { SecurityEvent } from '../lib/types';

const listMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      securityEvents: {
        list: (...a: unknown[]) => listMock(...a),
        exportUrl: (filter: Record<string, string | undefined>, format: string) => `/api/security-events/export?format=${format}&action=${filter.action ?? ''}`,
      },
    },
  };
});

const ev = (over: Partial<SecurityEvent> & { id: string }): SecurityEvent => ({
  actor_id: 'u1',
  actor_email: 'admin@x.dev',
  view_as_id: null,
  action: 'auth.login',
  target_type: null,
  target_id: null,
  target_label: null,
  ip: '10.0.0.1',
  meta: {},
  created_at: '2026-10-07T12:00:00.000Z',
  ...over,
});

const ACTIONS = ['auth.login', 'auth.login_failed', 'user.invite', 'terminal.view_as_open'];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SecurityEventsView', () => {
  it('lists the trail with who, what, target, IP and details, and the retention', async () => {
    listMock.mockResolvedValue({
      events: [
        ev({ id: 'a2', action: 'terminal.view_as_open', view_as_id: 'u2', target_label: 'claude', meta: { writable: true } }),
        ev({ id: 'a1', action: 'auth.login_failed', actor_email: null, target_label: 'pessoa@x.dev', meta: { method: 'password', reason: 'invalid' } }),
      ],
      next: null,
      actions: ACTIONS,
      retention_days: 365,
    });
    render(<SecurityEventsView />);
    const table = within(await screen.findByRole('table'));
    expect(table.getByText('Abriu o terminal de outra pessoa')).toBeTruthy();
    expect(table.getByText('vendo como u2')).toBeTruthy();
    expect(table.getByText('Falha ao entrar')).toBeTruthy();
    expect(table.getByText('desconhecido')).toBeTruthy();
    expect(table.getByText('method: password · reason: invalid')).toBeTruthy();
    expect(screen.getByText(/Cada registro fica guardado por 365 dias\./)).toBeTruthy();
    expect(listMock).toHaveBeenCalledWith({}, null);
  });

  it('filters by action group and text, and the export links follow the filter', async () => {
    listMock.mockResolvedValue({ events: [], next: null, actions: ACTIONS, retention_days: 365 });
    render(<SecurityEventsView />);
    await screen.findByText('Nenhum registro com esses filtros.');
    fireEvent.change(screen.getByLabelText('Ação'), { target: { value: 'auth' } });
    fireEvent.change(screen.getByLabelText('Pessoa, alvo ou IP'), { target: { value: ' pessoa ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ action: 'auth', q: 'pessoa', from: undefined, to: undefined }, null));
    expect(screen.getByRole('link', { name: 'Exportar CSV' }).getAttribute('href')).toBe('/api/security-events/export?format=csv&action=auth');
    expect(screen.getByRole('link', { name: 'Exportar JSON' }).getAttribute('href')).toBe('/api/security-events/export?format=json&action=auth');
  });

  it('loads the next page after the cursor', async () => {
    listMock.mockResolvedValueOnce({ events: [ev({ id: 'a2' })], next: 'cursor-1', actions: ACTIONS, retention_days: 365 });
    listMock.mockResolvedValueOnce({ events: [ev({ id: 'a1', action: 'user.invite' })], next: null, actions: ACTIONS, retention_days: 365 });
    render(<SecurityEventsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('Convidou usuário')).toBeTruthy());
    expect(listMock).toHaveBeenLastCalledWith({}, 'cursor-1');
    expect(within(screen.getByRole('table')).getByText('Entrou')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });
});

describe('helpers', () => {
  it('turns a calendar day into the local instant it starts', () => {
    expect(dayStart('2026-10-07')).toBe(new Date(2026, 9, 7).toISOString());
    expect(dayStart('2026-10-31', 1)).toBe(new Date(2026, 10, 1).toISOString());
    expect(dayStart('')).toBeUndefined();
  });

  it('writes meta as short pairs and skips empty values', () => {
    expect(metaText({ from: 'BETA', to: 'ADMIN', gone: null, scopes: ['read'] })).toBe('from: BETA · to: ADMIN · scopes: ["read"]');
  });
});
