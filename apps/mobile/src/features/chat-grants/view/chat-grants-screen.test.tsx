import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat-grants/viewmodel/useChatGrantsStore', () => ({ useChatGrantsStore: require('../../../../test/helpers/ui-stores').stores.chatGrants }));

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ChatGrantsScreen } from './chat-grants-screen';

const LOAD = { timeout: 15_000 };

const ACTIVE = {
  kind: 'tab' as const,
  id: 'g1',
  tab_id: 't-api',
  tool: 'send_input',
  source_action_id: null,
  created_at: '2026-09-25T10:00:00.000Z',
  expires_at: '2099-01-01T00:00:00.000Z',
  tab_name: 'api',
  project_id: 'p-termhub',
  project_name: 'termhub',
  conversation_id: 'c1',
  conversation_project_name: null,
  conversation_archived: false,
  state: 'active' as const,
  ended_at: null,
  scope: null,
  standing_kind: null,
};

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});

describe('Permissões do chat', () => {
  it('titles the screen and says so when nothing is active and the history is empty', async () => {
    await render(<ChatGrantsScreen />);
    expect(screen.getByText('Permissões do chat')).toBeTruthy();
    expect(await screen.findByText('Nenhuma permissão ativa agora.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Nada no histórico ainda.')).toBeTruthy();
  });

  it('renders a project grant row, named by its project, next to a tab row', async () => {
    const projectRow = {
      kind: 'project' as const,
      id: 'pg1',
      tab_id: null,
      tool: null,
      source_action_id: null,
      created_at: '2026-09-25T11:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
      tab_name: null,
      project_id: 'p-termhub',
      project_name: 'termhub',
      conversation_id: 'c1',
      conversation_project_name: null,
      conversation_archived: false,
      state: 'active' as const,
      ended_at: null,
      scope: 'board' as const,
      standing_kind: null,
    };
    jest.spyOn(stores.api, 'listGrants').mockImplementation(async (_a, q) => (q.state === 'active' ? { grants: [projectRow, ACTIVE], next_cursor: null } : { grants: [], next_cursor: null }));
    await render(<ChatGrantsScreen />);
    expect(await screen.findByText('Quadro do projeto termhub', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Aba api · termhub')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Revogar' })).toHaveLength(2);
  });

  it('says how long each kind of permission lasts (TER-386)', async () => {
    await render(<ChatGrantsScreen />);
    expect(screen.getByText('O que o chat pode fazer sem pedir confirmação. Permissões de conversa valem por até 24 horas; as sem prazo valem até você revogar.')).toBeTruthy();
    await waitFor(() => expect(stores.chatGrants.getState().loading).toBe(false), LOAD);
  });

  it('renders a standing row by its kind and project, "sem prazo", with Revogar (TER-386)', async () => {
    const standingRow = {
      ...ACTIVE,
      kind: 'standing' as const,
      id: 'sg1',
      tab_id: null,
      tool: null,
      tab_name: null,
      expires_at: null,
      conversation_id: null,
      standing_kind: 'close_tab' as const,
    };
    jest.spyOn(stores.api, 'listGrants').mockImplementation(async (_a, q) => (q.state === 'active' ? { grants: [standingRow], next_cursor: null } : { grants: [], next_cursor: null }));
    const revoke = jest.spyOn(stores.api, 'revokeGrant').mockResolvedValue(undefined);
    await render(<ChatGrantsScreen />);
    expect(await screen.findByText('Fechar abas paradas no projeto termhub · sem prazo', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Conversa apagada · sem prazo')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
    expect(revoke).toHaveBeenCalledWith(expect.anything(), 'sg1');
    await waitFor(() => expect(stores.chatGrants.getState()).toMatchObject({ revokingId: null, loading: false }), LOAD);
  });

  it('shows an active grant with its origin and revokes it without a PIN', async () => {
    jest
      .spyOn(stores.api, 'listGrants')
      .mockImplementation(async (_a, q) => (q.state === 'active' ? { grants: [ACTIVE], next_cursor: null } : { grants: [], next_cursor: null }));
    const revoke = jest.spyOn(stores.api, 'revokeGrant').mockResolvedValue(undefined);
    await render(<ChatGrantsScreen />);
    expect(await screen.findByText('Aba api · termhub', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText(/^Chat geral · até/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
    expect(revoke).toHaveBeenCalledWith(expect.anything(), 'g1');
    expect(stores.store.getState().pinPrompt).toBeNull();
    // The revoke reloads the list; let it settle before the next test.
    await waitFor(() => expect(stores.chatGrants.getState()).toMatchObject({ revokingId: null, loading: false }), LOAD);
  });

  describe('Resposta automática (TER-642)', () => {
    const memory = (over: Record<string, unknown> = {}) => ({
      enabled: true,
      autodecide: true,
      codex_replies: false,
      available: true,
      count: 0,
      notes: 0,
      auto_thresholds: { high: 0.95, low: 0.85, source: 'default', defaults: { high: 0.95, low: 0.85 }, samples: 4, min_samples: 30, calibrated_at: null, ...over },
      auto_delay_seconds: 60,
      focus_beat_seconds: 15,
    });
    const settled = () => waitFor(() => expect(stores.chatGrants.getState().loading).toBe(false), LOAD);

    it('shows the thresholds in force, what each does and that they are the defaults', async () => {
      jest.spyOn(stores.api, 'chatMemory').mockResolvedValue(memory());
      await render(<ChatGrantsScreen />);
      expect(await screen.findByText('Resposta automática', undefined, LOAD)).toBeTruthy();
      expect(screen.getByText('A partir de 0,95: envia a resposta sozinho.')).toBeTruthy();
      expect(screen.getByText('De 0,85 até 0,95: sugere a resposta e envia em 60 s, contando só com o termhub em foco.')).toBeTruthy();
      expect(screen.getByText('Abaixo de 0,85: não sugere nada.')).toBeTruthy();
      expect(screen.getByText('Limiares padrão — o ajuste automático começa com 30 respostas suas (4 até agora).')).toBeTruthy();
      expect(screen.getByText(/Só age com «Responder sozinho» ligado/)).toBeTruthy();
      expect(screen.getByTestId('auto-threshold-high').props.value).toBe('0,95');
      expect(screen.queryByRole('button', { name: 'Voltar ao ajuste automático' })).toBeNull();
      await settled();
    });

    it('says when they come from the person\'s own history', async () => {
      jest.spyOn(stores.api, 'chatMemory').mockResolvedValue(memory({ high: 0.93, low: 0.8, source: 'calibrated', samples: 120 }));
      await render(<ChatGrantsScreen />);
      expect(await screen.findByText('Limiares ajustados pelo seu histórico (120 respostas).', undefined, LOAD)).toBeTruthy();
      await settled();
    });

    it('pins what was typed, then offers the way back to the automatic adjustment', async () => {
      jest.spyOn(stores.api, 'chatMemory').mockResolvedValue(memory());
      const set = jest.spyOn(stores.api, 'setChatMemory').mockResolvedValueOnce(memory({ high: 0.9, low: 0.75, source: 'manual' })).mockResolvedValueOnce(memory());
      await render(<ChatGrantsScreen />);
      await screen.findByText('Resposta automática', undefined, LOAD);
      await fireEvent.changeText(screen.getByTestId('auto-threshold-high'), '0,9');
      await fireEvent.changeText(screen.getByTestId('auto-threshold-low'), '0.75');
      await fireEvent.press(screen.getByRole('button', { name: 'Fixar limiares' }));
      expect(set).toHaveBeenLastCalledWith(expect.anything(), { auto_thresholds: { high: 0.9, low: 0.75 } });
      expect(await screen.findByText('Limiares fixados por você: o ajuste automático está desligado.', undefined, LOAD)).toBeTruthy();
      expect(screen.getByText('A partir de 0,90: envia a resposta sozinho.')).toBeTruthy();
      // Pinned and untouched: nothing to pin again.
      expect(screen.getByRole('button', { name: 'Fixar limiares' }).props.accessibilityState.disabled).toBe(true);
      await fireEvent.press(screen.getByRole('button', { name: 'Voltar ao ajuste automático' }));
      expect(set).toHaveBeenLastCalledWith(expect.anything(), { auto_thresholds: null });
      expect(await screen.findByText(/^Limiares padrão/, undefined, LOAD)).toBeTruthy();
      expect(screen.getByTestId('auto-threshold-high').props.value).toBe('0,95');
      await settled();
    });

    it('refuses a value out of range, or a suggestion threshold above the sending one, with a line saying why', async () => {
      jest.spyOn(stores.api, 'chatMemory').mockResolvedValue(memory());
      const set = jest.spyOn(stores.api, 'setChatMemory');
      await render(<ChatGrantsScreen />);
      await screen.findByText('Resposta automática', undefined, LOAD);
      expect(screen.queryByText(/^Use números de 0,50 a 1,00/)).toBeNull();
      await fireEvent.changeText(screen.getByTestId('auto-threshold-low'), '0,99');
      expect(screen.getByText('Use números de 0,50 a 1,00, com o limiar de sugestão igual ou abaixo do de envio.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Fixar limiares' }).props.accessibilityState.disabled).toBe(true);
      await fireEvent.changeText(screen.getByTestId('auto-threshold-low'), '0,4');
      expect(screen.getByRole('button', { name: 'Fixar limiares' }).props.accessibilityState.disabled).toBe(true);
      expect(set).not.toHaveBeenCalled();
      await settled();
    });

    it('leaves the block out for an older server', async () => {
      const { auto_thresholds: _gone, ...old } = memory();
      jest.spyOn(stores.api, 'chatMemory').mockResolvedValue(old);
      await render(<ChatGrantsScreen />);
      // The store outlives a test: wait for this read to land, not for a state an earlier one left.
      await waitFor(() => expect(stores.chatGrants.getState().memory?.auto_thresholds).toBeUndefined(), LOAD);
      await waitFor(() => expect(screen.queryByText('Resposta automática')).toBeNull(), LOAD);
      await settled();
    });

    it('leaves the block out where the memory is not available', async () => {
      jest.spyOn(stores.api, 'chatMemory').mockResolvedValue({ ...memory(), available: false });
      await render(<ChatGrantsScreen />);
      await waitFor(() => expect(stores.chatGrants.getState().memory).toMatchObject({ available: false }), LOAD);
      await waitFor(() => expect(screen.queryByText('Resposta automática')).toBeNull(), LOAD);
      await settled();
    });
  });

  it('Voltar goes back', async () => {
    await render(<ChatGrantsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(mockRouter.back).toHaveBeenCalled();
    await waitFor(() => expect(stores.chatGrants.getState().loading).toBe(false), LOAD);
  });
});
