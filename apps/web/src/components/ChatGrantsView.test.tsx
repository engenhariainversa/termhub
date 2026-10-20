// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ChatGrantListItem } from '../lib/types';

const listMock = vi.fn();
const revokeMock = vi.fn();
const setDefaultMock = vi.fn();
const defaultsMock = vi.fn();
const memoryMock = vi.fn();
const setMemoryMock = vi.fn();
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return { ApiError, api: {
      listChatGrants: (...a: unknown[]) => listMock(...a),
      revokeChatGrant: (...a: unknown[]) => revokeMock(...a),
      listChatDefaults: (...a: unknown[]) => defaultsMock(...a),
      setChatDefault: (...a: unknown[]) => setDefaultMock(...a),
      chatMemory: (...a: unknown[]) => memoryMock(...a),
      setChatMemory: (...a: unknown[]) => setMemoryMock(...a),
    },
  };
});

import { ApiError } from '../lib/api';
import { ChatGrantsView } from './ChatGrantsView';

const item = (over: Partial<ChatGrantListItem> & { id: string }): ChatGrantListItem => ({
  kind: 'tab', tab_id: 't1', tool: 'send_input', source_action_id: null, created_at: '2026-09-25T10:00:00.000Z', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  tab_name: 'api', project_id: 'p1', project_name: 'termhub', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false,
  state: 'active', ended_at: null, standing_kind: null, ...over,
});

beforeEach(() => {
  listMock.mockReset();
  revokeMock.mockReset();
  defaultsMock.mockReset();
  setDefaultMock.mockReset();
  defaultsMock.mockRejectedValue(new Error('not in this test'));
  memoryMock.mockReset();
  setMemoryMock.mockReset();
  memoryMock.mockRejectedValue(new Error('not in this test'));
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
  expect(await screen.findByText('Nenhuma permissão ativa agora.')).toBeInTheDocument();
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

it('titles a project row with its project, or "Projeto que não existe mais" when it is gone', async () => {
  serve([item({ id: 'g1', kind: 'project', tab_id: null, tab_name: null, tool: null, project_id: 'p1', project_name: 'App' })], [{ grants: [item({ id: 'g2', kind: 'project', tab_id: null, tab_name: null, tool: null, project_id: 'p2', project_name: null, state: 'ended', ended_at: '2026-09-24T10:00:00.000Z' })], next_cursor: null }]);
  render(<ChatGrantsView />);
  const active = await screen.findByRole('region', { name: 'Ativas' });
  expect(within(active).getByText('Quadro do projeto App')).toBeInTheDocument();
  const history = screen.getByRole('region', { name: 'Histórico' });
  expect(within(history).getByText('Projeto que não existe mais')).toBeInTheDocument();
});

it('revoking a project row that was already revoked (409) re-reads the list', async () => {
  serve([item({ id: 'g1', kind: 'project', tab_id: null, tab_name: null, tool: null, project_id: 'p1', project_name: 'App' })], [{ grants: [], next_cursor: null }]);
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
  expect(await screen.findByText('Nenhuma permissão ativa agora.')).toBeInTheDocument();
});

it('lists a standing grant as "sem prazo", asks for all_standing and explains both validities', async () => {
  serve([item({ id: 's1', kind: 'standing', standing_kind: 'close_tab', tab_id: null, tab_name: null, tool: null, project_name: 'App', expires_at: null, conversation_id: null })], [{ grants: [], next_cursor: null }]);
  render(<ChatGrantsView />);
  const active = await screen.findByRole('region', { name: 'Ativas' });
  expect(within(active).getByText('Fechar abas paradas no projeto App · sem prazo')).toBeInTheDocument();
  expect(within(active).getByText('Conversa apagada · sem prazo')).toBeInTheDocument();
  expect(screen.getByText('O que o chat pode fazer sem pedir confirmação. Permissões de conversa valem por até 24 horas; as sem prazo valem até você revogar.')).toBeInTheDocument();
});

const defaultsList = (off: string[] = []) =>
  ([['open_tab', 'abrir abas'], ['board', 'mexer no quadro (criar, mover e editar cards)'], ['close_tab', 'fechar abas paradas']] as const).map(([kind, label]) => ({ kind, label, allowed: !off.includes(kind) }));

it('lists the default allowances (TER-627), each checked unless restricted', async () => {
  serve([], [{ grants: [], next_cursor: null }]);
  defaultsMock.mockResolvedValue({ defaults: defaultsList(['close_tab']) });
  render(<ChatGrantsView />);
  const section = await screen.findByRole('region', { name: 'Liberadas por padrão' });
  expect(within(section).getByRole('checkbox', { name: 'Abrir abas' })).toBeChecked();
  expect(within(section).getByRole('checkbox', { name: 'Fechar abas paradas' })).not.toBeChecked();
  expect(within(section).getByText(/Sempre pedem confirmação: apagar card, rodar comando, responder permissões/)).toBeInTheDocument();
});

it('unchecking a default restricts it and shows what the server answered', async () => {
  serve([], [{ grants: [], next_cursor: null }]);
  defaultsMock.mockResolvedValue({ defaults: defaultsList() });
  setDefaultMock.mockResolvedValue({ defaults: defaultsList(['board']) });
  render(<ChatGrantsView />);
  const section = await screen.findByRole('region', { name: 'Liberadas por padrão' });
  fireEvent.click(within(section).getByRole('checkbox', { name: 'Mexer no quadro (criar, mover e editar cards)' }));
  expect(setDefaultMock).toHaveBeenCalledWith('board', false);
  await waitFor(() => expect(within(section).getByRole('checkbox', { name: 'Mexer no quadro (criar, mover e editar cards)' })).not.toBeChecked());
});

it('a failed defaults read hides that section and keeps the grants', async () => {
  serve([], [{ grants: [], next_cursor: null }]);
  render(<ChatGrantsView />);
  expect(await screen.findByText('Nenhuma permissão ativa agora.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Liberadas por padrão' })).toBeNull();
});

// TER-642: the similarity thresholds of an automatic answer, read from (and pinned through) the chat memory settings.
describe('"Resposta automática" (TER-642)', () => {
  const thresholds = (over: Record<string, unknown> = {}) => ({ high: 0.95, low: 0.85, source: 'default', defaults: { high: 0.95, low: 0.85 }, samples: 3, min_samples: 20, calibrated_at: null, ...over });
  const memory = (over: Record<string, unknown> = {}) => ({ enabled: true, autodecide: true, codex_replies: false, available: true, count: 4, notes: 0, auto_thresholds: thresholds(), auto_delay_seconds: 60, focus_beat_seconds: 15, ...over });
  const open = async () => {
    serve([], [{ grants: [], next_cursor: null }]);
    render(
      <MemoryRouter>
        <ChatGrantsView />
      </MemoryRouter>,
    );
    return screen.findByRole('region', { name: 'Resposta automática' });
  };

  it('shows the thresholds in force, what each band does, the default source and where the switch lives', async () => {
    memoryMock.mockResolvedValue(memory());
    const section = await open();
    expect(within(section).getByText('A partir de 0,95: envia a resposta sozinho.')).toBeInTheDocument();
    expect(within(section).getByText('De 0,85 até 0,95: sugere a resposta e envia em 60 s, contando só com o termhub em foco.')).toBeInTheDocument();
    expect(within(section).getByText('Abaixo de 0,85: não sugere nada.')).toBeInTheDocument();
    expect(within(section).getByText('Limiares padrão — o ajuste automático começa com 20 respostas suas (3 até agora).')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'Memória do chat' })).toHaveAttribute('href', '/chat/memoria');
    expect(within(section).getByText(/Só age com «Responder sozinho» ligado/)).toBeInTheDocument();
    expect(within(section).getByLabelText('Limiar de envio')).toHaveValue(0.95);
    expect(within(section).getByLabelText('Limiar de sugestão')).toHaveValue(0.85);
    // only a pinned pair can be handed back to calibration
    expect(within(section).queryByRole('button', { name: 'Voltar ao ajuste automático' })).toBeNull();
  });

  it('names a calibrated source with how many answers it saw, and says when the switch is off', async () => {
    memoryMock.mockResolvedValue(memory({ autodecide: false, auto_thresholds: thresholds({ high: 0.93, low: 0.8, source: 'calibrated', samples: 42, calibrated_at: '2026-10-10T10:00:00.000Z' }) }));
    const section = await open();
    expect(within(section).getByText('Limiares ajustados pelo seu histórico (42 respostas).')).toBeInTheDocument();
    expect(within(section).getByText('A partir de 0,93: envia a resposta sozinho.')).toBeInTheDocument();
    expect(within(section).getByText(/«Responder sozinho» está desligado/)).toBeInTheDocument();
  });

  it('"Fixar limiares" pins the pair and shows what the server answered', async () => {
    memoryMock.mockResolvedValue(memory());
    setMemoryMock.mockResolvedValue(memory({ auto_thresholds: thresholds({ high: 0.9, low: 0.7, source: 'manual' }) }));
    const section = await open();
    fireEvent.change(within(section).getByLabelText('Limiar de envio'), { target: { value: '0.9' } });
    fireEvent.change(within(section).getByLabelText('Limiar de sugestão'), { target: { value: '0.7' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Fixar limiares' }));
    expect(setMemoryMock).toHaveBeenCalledWith({ auto_thresholds: { high: 0.9, low: 0.7 } });
    expect(await within(section).findByText('Limiares fixados por você: o ajuste automático está desligado.')).toBeInTheDocument();
    expect(within(section).getByText('De 0,70 até 0,90: sugere a resposta e envia em 60 s, contando só com o termhub em foco.')).toBeInTheDocument();
    expect(within(section).getByLabelText('Limiar de envio')).toHaveValue(0.9);
  });

  it('"Voltar ao ajuste automático" hands a pinned pair back to calibration', async () => {
    memoryMock.mockResolvedValue(memory({ auto_thresholds: thresholds({ high: 0.9, low: 0.7, source: 'manual' }) }));
    setMemoryMock.mockResolvedValue(memory());
    const section = await open();
    fireEvent.click(within(section).getByRole('button', { name: 'Voltar ao ajuste automático' }));
    expect(setMemoryMock).toHaveBeenCalledWith({ auto_thresholds: null });
    expect(await within(section).findByText(/^Limiares padrão/)).toBeInTheDocument();
    expect(within(section).getByLabelText('Limiar de envio')).toHaveValue(0.95);
    expect(within(section).queryByRole('button', { name: 'Voltar ao ajuste automático' })).toBeNull();
  });

  it('refuses a pair out of range or out of order, with the reason beside the form', async () => {
    memoryMock.mockResolvedValue(memory());
    const section = await open();
    const pin = within(section).getByRole('button', { name: 'Fixar limiares' });
    expect(pin).toBeEnabled();
    fireEvent.change(within(section).getByLabelText('Limiar de sugestão'), { target: { value: '0.97' } });
    expect(within(section).getByText('O limiar de sugestão não pode passar do limiar de envio.')).toBeInTheDocument();
    expect(pin).toBeDisabled();
    fireEvent.change(within(section).getByLabelText('Limiar de sugestão'), { target: { value: '0.4' } });
    expect(within(section).getByText('Use valores entre 0,50 e 1,00.')).toBeInTheDocument();
    expect(pin).toBeDisabled();
    fireEvent.change(within(section).getByLabelText('Limiar de sugestão'), { target: { value: '' } });
    expect(pin).toBeDisabled();
    fireEvent.submit(pin.closest('form')!);
    expect(setMemoryMock).not.toHaveBeenCalled();
    fireEvent.change(within(section).getByLabelText('Limiar de sugestão'), { target: { value: '0.95' } }); // equal is allowed
    expect(pin).toBeEnabled();
  });

  it('a refused save shows the server message with the view\'s other errors and keeps the thresholds', async () => {
    memoryMock.mockResolvedValue(memory());
    setMemoryMock.mockRejectedValue(new ApiError(400, 'O limiar de sugestão não pode passar do limiar de envio'));
    const section = await open();
    fireEvent.click(within(section).getByRole('button', { name: 'Fixar limiares' }));
    expect(await screen.findByText('O limiar de sugestão não pode passar do limiar de envio')).toBeInTheDocument();
    expect(within(section).getByText('A partir de 0,95: envia a resposta sozinho.')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Fixar limiares' })).toBeEnabled();
  });

  it('is hidden without memory on the server, and on a server that predates the thresholds', async () => {
    memoryMock.mockResolvedValue(memory({ available: false }));
    serve([], [{ grants: [], next_cursor: null }]);
    const first = render(<ChatGrantsView />);
    expect(await screen.findByText('Nenhuma permissão ativa agora.')).toBeInTheDocument();
    await waitFor(() => expect(memoryMock).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Resposta automática' })).toBeNull();
    first.unmount();
    memoryMock.mockResolvedValue(memory({ auto_thresholds: undefined }));
    render(<ChatGrantsView />);
    expect(await screen.findByText('Nenhuma permissão ativa agora.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Resposta automática' })).toBeNull();
  });
});
