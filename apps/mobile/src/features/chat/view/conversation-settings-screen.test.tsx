import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
  Link: ({ children }: { children: unknown }) => children,
}));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import type { TChatGrant, TChatProjectGrant, TChatResponse, TChatStandingGrant, TSubagentView } from '@/services/api/contract';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { emptyFold } from '../model/live';
import { ConversationSettingsScreen } from './conversation-settings-screen';

/** The first load of a file signs its first P-256 proof, slow while other suites share the CPU. */
const LOAD = { timeout: 15_000 };

const GRANT: TChatGrant = { id: 'g1', tab_id: 't-api', tool: 'send_input', source_action_id: 'a-termhub-1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api' };
const PROJECT_GRANT: TChatProjectGrant = { id: 'pg1', project_id: 'p-termhub', project_name: 'termhub', source_action_id: 'a-termhub-2', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', scope: 'board' };
const STANDING_GRANT: TChatStandingGrant = { id: 'sg1', project_id: 'p-termhub', project_name: 'termhub', kind: 'terminal', source_action_id: 'a-termhub-1', created_at: '2026-09-25T10:00:00.000Z' };
const SUBAGENT: TSubagentView = { id: 'sub1', description: 'Buscar CI', subagent_type: null, status: 'running', started_at: '2026-09-27T00:00:00.000Z', ended_at: null };

/** Serves the project's `GET chat` with a patch, the way the conversation's own tests do. */
function serveChat(patch: (res: TChatResponse) => Partial<TChatResponse>) {
  const real = stores.api.chat.bind(stores.api);
  jest.spyOn(stores.api, 'chat').mockImplementation(async (auth, projectId) => {
    const res = await real(auth, projectId);
    return projectId === 'p-termhub' ? { ...res, ...patch(res) } : res;
  });
}

/** The settings read the conversation the store has open: open it the way the conversation screen does. */
async function openConversation(route = 'p-termhub') {
  await act(async () => {
    await useChatStore.getState().openByRoute(route);
  });
}

const realActions = { ...stores.chat.getState() };
function stubAction<K extends 'reset' | 'cancelSubagent'>(name: K) {
  const fn = jest.fn(async () => undefined);
  useChatStore.setState({ [name]: fn } as Partial<ReturnType<typeof useChatStore.getState>>);
  return fn;
}

beforeAll(async () => {
  await enrolStores();
  await stores.chat.getState().loadProjects();
});

let conversationsBefore: ReturnType<typeof useChatStore.getState>['conversations'];

beforeEach(() => {
  conversationsBefore = useChatStore.getState().conversations;
  for (const fn of Object.values(mockRouter)) fn.mockClear();
  mockRouter.canGoBack.mockReturnValue(true);
  jest.spyOn(stores.api, 'events').mockReturnValue(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  useChatStore.setState({ error: null, connected: false, live: emptyFold(), conversations: conversationsBefore, reset: realActions.reset, cancelSubagent: realActions.cancelSubagent });
});

describe('Configurações da conversa (TER-1039)', () => {
  it("shows a ready project chat's host line, with its accounts and model and its recent files", async () => {
    await openConversation();
    await render(<ConversationSettingsScreen />);
    expect(screen.getByText('Configurações da conversa')).toBeTruthy();
    expect(await screen.findByText('Esta conversa roda na máquina jarvis, na conta padrão do Claude dela.', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Trocar máquina ou conta' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Arquivos' }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/file-recent', params: { project_id: 'p-termhub' } });
    await fireEvent.press(screen.getByRole('button', { name: 'Conta e modelo' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Contas e modelo do projeto' }, LOAD));
    expect(mockRouter.push).toHaveBeenCalledWith('/project-ai/p-termhub');
  });

  it('shows a ready account-wide chat with its machine picker', async () => {
    await openConversation('general');
    await render(<ConversationSettingsScreen />);
    expect(await screen.findByText(/Esta conversa roda na máquina/, undefined, LOAD)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conta e modelo' })).toBeNull();
  });

  it('Subagentes (1) opens the sheet, whose Cancelar calls the store', async () => {
    serveChat(() => ({ subagents: [SUBAGENT] }));
    const cancelSubagent = stubAction('cancelSubagent');
    await openConversation();
    await render(<ConversationSettingsScreen />);
    const button = await screen.findByRole('button', { name: 'Subagentes (1)' }, LOAD);
    expect(screen.queryByText('Buscar CI')).toBeNull(); // the sheet is not open yet
    await fireEvent.press(button);
    expect(screen.getByText('Buscar CI')).toBeTruthy();
    expect(screen.getByText(/rodando/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar Buscar CI' }));
    expect(cancelSubagent).toHaveBeenCalledWith('sub1');
  });

  it('the subagents sheet shows the elapsed time as of when it opens, not as of when the screen mounted', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      serveChat(() => ({ subagents: [{ ...SUBAGENT, started_at: new Date(realNow()).toISOString() }] }));
      await openConversation();
      await render(<ConversationSettingsScreen />);
      const button = await screen.findByRole('button', { name: 'Subagentes (1)' }, LOAD);
      offset = 10 * 60_000; // ten minutes later, the sheet is opened for the first time
      await fireEvent.press(button);
      expect(screen.getByText(/há 10 min/)).toBeTruthy();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('with nothing running, the subagents button still reads Subagentes (0)', async () => {
    serveChat(() => ({ subagents: [] }));
    await openConversation();
    await render(<ConversationSettingsScreen />);
    expect(await screen.findByRole('button', { name: 'Subagentes (0)' }, LOAD)).toBeTruthy();
  });

  it('counts tab, project and standing grants together and opens Permissões do chat', async () => {
    serveChat(() => ({ grants: [GRANT], project_grants: [PROJECT_GRANT], standing_grants: [STANDING_GRANT] }));
    await openConversation();
    await render(<ConversationSettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: '3 permissões ativas' }, LOAD));
    expect(mockRouter.push).toHaveBeenCalledWith('/chat-grants');
  });

  it('shows no grants button without an active grant', async () => {
    serveChat(() => ({ grants: [], project_grants: [], standing_grants: [] }));
    await openConversation();
    await render(<ConversationSettingsScreen />);
    await screen.findByRole('button', { name: /^Subagentes/ }, LOAD);
    expect(screen.queryByRole('button', { name: /permiss(ão|ões) ativa/ })).toBeNull();
    expect(screen.queryByText('Abas liberadas')).toBeNull();
  });

  it('leads to the chat memory', async () => {
    await openConversation();
    await render(<ConversationSettingsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Memória do chat' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/chat-memory');
  });

  it('Nova conversa asks first, then resets and goes back to the conversation', async () => {
    const reset = stubAction('reset');
    await openConversation();
    await render(<ConversationSettingsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Nova conversa' }));
    expect(reset).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Começar nova conversa' }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('"Voltar" goes back, and to the chats when nothing is behind it', async () => {
    await openConversation();
    await render(<ConversationSettingsScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    mockRouter.canGoBack.mockReturnValue(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/chats');
  });
});
