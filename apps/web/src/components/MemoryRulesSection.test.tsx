// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRulesSection } from './MemoryRulesSection';
import type { MemoryRule } from '../lib/types';

const listMock = vi.fn();
const approveMock = vi.fn();
const rejectMock = vi.fn();
const removeMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      chat: {
        rules: {
          list: (...a: unknown[]) => listMock(...a),
          approve: (...a: unknown[]) => approveMock(...a),
          reject: (...a: unknown[]) => rejectMock(...a),
          remove: (...a: unknown[]) => removeMock(...a),
        },
      },
    },
  };
});

const rule = (over: Partial<MemoryRule> & { id: string }): MemoryRule => ({
  kind: 'rule',
  status: 'proposed',
  project: null,
  text: 'Pode rodar os testes de banco sem perguntar',
  policy: null,
  sources: ['a', 'b', 'c', 'd'].map((x, i) => ({ ref: `note:${x}`, title: 'Pergunta', statement: 'Pode rodar os testes de banco sem perguntar', project_name: `p${i}` })),
  created_at: '2026-10-07T10:00:00.000Z',
  decided_at: null,
  ...over,
});

beforeEach(() => {
  listMock.mockReset();
  approveMock.mockReset().mockResolvedValue({});
  rejectMock.mockReset().mockResolvedValue({});
  removeMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows a user-level proposal with its sources, and approves it', async () => {
  listMock.mockResolvedValueOnce({ rules: [], proposals: [rule({ id: 'r1' })] }).mockResolvedValueOnce({ rules: [rule({ id: 'r1', status: 'approved' })], proposals: [] });
  render(<MemoryRulesSection />);
  expect(await screen.findByText('Pode rodar os testes de banco sem perguntar')).toBeInTheDocument();
  expect(screen.getByText('Todos os projetos')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '4 origens' }));
  expect(screen.getAllByText('Pode rodar os testes de banco sem perguntar')).toHaveLength(5);
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
  await waitFor(() => expect(approveMock).toHaveBeenCalledWith('r1'));
  expect(await screen.findByRole('button', { name: 'Remover' })).toBeInTheDocument();
});

it('words a policy proposal, says each project confirms in the chat, and rejects for 180 days', async () => {
  const policy = rule({ id: 'r2', kind: 'policy', text: 'Pode mesclar com o CI verde', policy: { autonomy: 'merge', max_parallel: 2, projects: [{ id: 'p1', name: 'termhub', applied: false }] } });
  listMock.mockResolvedValue({ rules: [], proposals: [policy] });
  render(<MemoryRulesSection />);
  expect(await screen.findByText('Mudar o nível para «Merge com CI verde»')).toBeInTheDocument();
  expect(screen.getByText('Máximo em paralelo: 2')).toBeInTheDocument();
  expect(screen.getByText('Projetos: termhub')).toBeInTheDocument();
  expect(screen.getByText('Cada projeto pede a sua confirmação no chat.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));
  await waitFor(() => expect(rejectMock).toHaveBeenCalledWith('r2'));
  expect(await screen.findByText('Recusada, ela não volta por 180 dias.')).toBeInTheDocument();
});

it('shows a policy waiting for its cards without buttons', async () => {
  listMock.mockResolvedValue({ rules: [], proposals: [rule({ id: 'r3', kind: 'policy', status: 'awaiting_confirmation', policy: { autonomy: 'deploy', max_parallel: null, projects: [] } })] });
  render(<MemoryRulesSection />);
  expect(await screen.findByText('Aguardando a confirmação no chat')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Aprovar' })).not.toBeInTheDocument();
});

it('says when there is nothing yet', async () => {
  listMock.mockResolvedValue({ rules: [], proposals: [] });
  render(<MemoryRulesSection />);
  expect(await screen.findByText('Nenhuma regra vigente nem proposta por enquanto.')).toBeInTheDocument();
});
