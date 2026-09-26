// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatGrantListItem } from '../lib/types';

const listMock = vi.fn();
const revokeMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return { ApiError, api: { listChatGrants: (...a: unknown[]) => listMock(...a), revokeChatGrant: (...a: unknown[]) => revokeMock(...a) } };
});

import { ApiError } from '../lib/api';
import { ChatGrantsView } from './ChatGrantsView';

const item = (over: Partial<ChatGrantListItem> & { id: string }): ChatGrantListItem => ({
  tab_id: 't1', tool: 'send_input', source_action_id: null, created_at: '2026-09-25T10:00:00.000Z', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  tab_name: 'api', project_id: 'p1', project_name: 'termhub', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false,
  state: 'active', ended_at: null, ...over,
});

beforeEach(() => {
  listMock.mockReset();
  revokeMock.mockReset();
});
afterEach(() => cleanup());

function serve(active: ChatGrantListItem[], pages: { grants: ChatGrantListItem[]; next_cursor: string | null }[]) {
  let page = 0;
  listMock.mockImplementation(async (q: { state: string }) => (q.state === 'active' ? { grants: active, next_cursor: null } : pages[Math.min(page++, pages.length - 1)]));
}

it('lists active grants with tab, project, origin and validity, and the history with its state', async () => {
  serve([item({ id: 'g1' })], [{ grants: [item({ id: 'g2', tab_name: null, state: 'ended', ended_at: '2026-09-24T10:00:00.000Z', conversation_project_name: 'termhub', conversation_archived: true })], next_cursor: null }]);
  render(<ChatGrantsView />);
  const active = await screen.findByRole('region', { name: 'Ativas' });
  expect(within(active).getByText('Aba api · termhub')).toBeInTheDocument();
  expect(within(active).getByText(/^Chat geral · até/)).toBeInTheDocument();
  const history = screen.getByRole('region', { name: 'Histórico' });
  expect(within(history).getByText('Aba que não existe mais · termhub')).toBeInTheDocument();
  expect(within(history).getByText(/^Chat do projeto termhub · conversa encerrada · Encerrada com a conversa em /)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
});

it('shows the empty states', async () => {
  serve([], [{ grants: [], next_cursor: null }]);
  render(<ChatGrantsView />);
  expect(await screen.findByText('Nenhuma aba confiável agora.')).toBeInTheDocument();
  expect(screen.getByText('Nada no histórico ainda.')).toBeInTheDocument();
});

it('Carregar mais appends the next page with the cursor', async () => {
  serve([], [{ grants: [item({ id: 'g2', state: 'expired', ended_at: '2026-09-24T10:00:00.000Z' })], next_cursor: 'CUR' }, { grants: [item({ id: 'g3', tab_name: 'web', state: 'expired', ended_at: '2026-09-23T10:00:00.000Z' })], next_cursor: null }]);
  render(<ChatGrantsView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
  expect(await screen.findByText('Aba web · termhub')).toBeInTheDocument();
  expect(listMock).toHaveBeenLastCalledWith({ state: 'ended', cursor: 'CUR' });
  expect(screen.getByText('Aba api · termhub')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
});

it('Revogar revokes and reloads; a 409 counts as done', async () => {
  serve([item({ id: 'g1' })], [{ grants: [], next_cursor: null }]);
  revokeMock.mockRejectedValueOnce(new ApiError(409, 'Esta permissão já foi revogada'));
  render(<ChatGrantsView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Revogar' }));
  await waitFor(() => expect(revokeMock).toHaveBeenCalledWith('g1'));
  await waitFor(() => expect(listMock).toHaveBeenCalledTimes(4));
  expect(screen.queryByText(/Não foi possível/)).toBeNull();
});

it('a failed load says so and retries', async () => {
  listMock.mockRejectedValueOnce(new Error('offline'));
  render(<ChatGrantsView />);
  expect(await screen.findByText('Não foi possível carregar as permissões.')).toBeInTheDocument();
  serve([], [{ grants: [], next_cursor: null }]);
  fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
  expect(await screen.findByText('Nenhuma aba confiável agora.')).toBeInTheDocument();
});
