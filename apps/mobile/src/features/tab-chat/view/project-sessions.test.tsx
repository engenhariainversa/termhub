import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/tab-chat/viewmodel/useSessionsStore', () => ({ useSessionsStore: require('../../../../test/helpers/ui-stores').stores.sessions }));

const mockPush = jest.fn();
const mockParams: { projectId?: string } = { projectId: 'p-termhub' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
  // Runs on mount like the real hook (a screen is focused when it mounts).
  useFocusEffect: (cb: () => void) => require('react').useEffect(() => cb(), [cb]),
}));

import { ApiError } from '@/services/api/errors';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ProjectSessionsScreen, ProjectSessionsView } from './project-sessions';

const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  mockParams.projectId = 'p-termhub';
  stores.sessions.setState({ tabs: [], groups: [], loaded: false, forbidden: false, error: null });
});

afterEach(() => {
  mockPush.mockClear();
  jest.restoreAllMocks();
});

describe('A project\'s sessions (TER-1106)', () => {
  it('shows the concierge first, then only this project\'s tabs, with machine and agent', async () => {
    await render(<ProjectSessionsScreen />);
    expect(await screen.findByText('api', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('termhub')).toBeTruthy();
    expect(screen.getByText('Concierge')).toBeTruthy();
    expect(screen.getByText('jarvis · Claude')).toBeTruthy();
    expect(screen.getByText('hulk · Terminal')).toBeTruthy();
    expect(screen.getByText('Trabalhando · Bash')).toBeTruthy();
    // opapingou's tab is another project's.
    expect(screen.queryByText('deploy')).toBeNull();
  });

  it('the concierge opens the project\'s chat; a tab opens its session', async () => {
    await render(<ProjectSessionsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Concierge/ }, LOAD));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/p-termhub');
    await fireEvent.press(await screen.findByRole('button', { name: /^api/ }, LOAD));
    expect(mockPush).toHaveBeenLastCalledWith('/session/t-api');
  });

  it('a tab that is not ready shows why, and still opens', async () => {
    await render(<ProjectSessionsScreen />);
    expect(await screen.findByText('Atualize o agente desta máquina', undefined, LOAD)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /^web/ }));
    expect(mockPush).toHaveBeenLastCalledWith('/session/t-web');
  });

  it('"Iniciar sessão" starts one in this project', async () => {
    await render(<ProjectSessionsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Iniciar sessão' }, LOAD));
    expect(mockPush).toHaveBeenLastCalledWith('/session/new?projectId=p-termhub');
  });

  it('a project with no tab says so under its concierge', async () => {
    mockParams.projectId = 'p-reactivando';
    await render(<ProjectSessionsScreen />);
    expect(await screen.findByText('Nenhuma aba aberta neste projeto.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Concierge/ })).toBeTruthy();
  });

  it('without terminal access the concierge stays, with no button', async () => {
    jest.spyOn(stores.api, 'tabs').mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Sem permissão'));
    await render(<ProjectSessionsScreen />);
    expect(await screen.findByText('Seu acesso não inclui terminais.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Concierge/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Iniciar sessão' })).toBeNull();
  });

  it('in the split, the concierge stays in the pane and there is no Voltar', async () => {
    await stores.sessions.getState().load();
    const onOpenChat = jest.fn();
    await render(<ProjectSessionsView projectId="p-termhub" embedded onOpenChat={onOpenChat} />);
    expect(screen.queryByRole('button', { name: 'Voltar' })).toBeNull();
    await fireEvent.press(await screen.findByRole('button', { name: /^Concierge/ }, LOAD));
    expect(onOpenChat).toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
