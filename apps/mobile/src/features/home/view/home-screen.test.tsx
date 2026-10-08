import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));

const mockPush = jest.fn();
const mockNavigate = jest.fn();
/** The last `useFocusEffect` callback: a test calls it to simulate the tab coming back into focus. */
let mockFocus: (() => void) | null = null;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockNavigate, back: jest.fn() }),
  useFocusEffect: (cb: () => void) => {
    require('react').useEffect(() => {
      mockFocus = cb;
      cb();
    }, [cb]);
  },
}));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { setLocale } from '@/i18n';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { HomeScreen } from './home-screen';

const LOAD = { timeout: 15_000 };
const auth = () => stores.store.getState().auth();

beforeAll(async () => {
  await enrolStores();
});

afterEach(async () => {
  mockPush.mockClear();
  mockNavigate.mockClear();
  // The mock server lives for the whole file: leave nothing pinned for the next test.
  for (const id of ['p-termhub', 'p-opapingou', 'p-reactivando']) await stores.api.setProjectFavorite(auth(), id, false);
  jest.restoreAllMocks();
});

describe('Home (TER-541)', () => {
  it('in English, with nothing pinned', async () => {
    setLocale('en');
    try {
      await render(<HomeScreen />);
      expect(await screen.findByText('No pinned projects', undefined, LOAD)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'View projects' })).toBeTruthy();
    } finally {
      await act(async () => setLocale(null));
    }
  });

  it('with nothing pinned, explains how to pin and leads to Chats', async () => {
    await render(<HomeScreen />);
    expect(await screen.findByText('Nenhum projeto fixado', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Na aba Chats, toque no alfinete de um projeto, ou segure a linha, para fixá-lo aqui.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Ver projetos' }));
    expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/chats');
  });

  it('lists only the pinned projects, in Favoritos order, with their key and pending badge', async () => {
    await stores.api.setProjectFavorite(auth(), 'p-reactivando', true);
    await stores.api.setProjectFavorite(auth(), 'p-termhub', true);
    await render(<HomeScreen />);
    await screen.findByText('termhub', undefined, LOAD);
    const rows = screen.getAllByRole('button', { name: /^(termhub|reactivando|opapingou)$/ });
    expect(rows.map((r) => r.props.accessibilityLabel)).toEqual(['reactivando', 'termhub']);
    expect(screen.getByText('REA')).toBeTruthy();
    expect(screen.getByText('TER')).toBeTruthy();
    expect(screen.getByLabelText('2 confirmações pendentes')).toBeTruthy();
    expect(screen.queryByText('Nenhum projeto fixado')).toBeNull();
  });

  it("opens a project's chat", async () => {
    await stores.api.setProjectFavorite(auth(), 'p-termhub', true);
    await render(<HomeScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'termhub' }, LOAD));
    expect(mockPush).toHaveBeenCalledWith('/chat/p-termhub');
  });

  it('unpins from its own row', async () => {
    await stores.api.setProjectFavorite(auth(), 'p-termhub', true);
    await render(<HomeScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Tirar termhub de Favoritos' }, LOAD));
    expect(await screen.findByText('Nenhum projeto fixado')).toBeTruthy();
  });

  it('drops a project unpinned elsewhere when the tab comes back into focus', async () => {
    await stores.api.setProjectFavorite(auth(), 'p-termhub', true);
    await render(<HomeScreen />);
    await screen.findByRole('button', { name: 'termhub' }, LOAD);
    await stores.api.setProjectFavorite(auth(), 'p-termhub', false); // the web, say
    await act(async () => mockFocus?.());
    expect(await screen.findByText('Nenhum projeto fixado')).toBeTruthy();
  });

  it('re-reads the OS statuses on focus, and asks for ad consent while undecided', async () => {
    stores.permissions.setState({ adConsent: 'unknown', trackingStatus: null });
    stores.permissionDeps.trackingStatus.mockClear();
    await render(<HomeScreen />);
    expect(stores.permissionDeps.trackingStatus).toHaveBeenCalled();
    expect(await screen.findByText('Ajude a melhorar o termhub', undefined, LOAD)).toBeTruthy();
  });

  it('does not claim nothing is pinned while the first load is running', async () => {
    await act(() => useChatStore.setState({ projects: [] }));
    jest.spyOn(stores.api, 'chatProjects').mockImplementationOnce(() => new Promise(() => undefined));
    await render(<HomeScreen />);
    expect(screen.queryByText('Nenhum projeto fixado')).toBeNull();
  });

  it('after a failed first load, shows the error without claiming nothing is pinned', async () => {
    await act(() => useChatStore.setState({ projects: [] }));
    jest.spyOn(stores.api, 'chatProjects').mockRejectedValueOnce(new Error('offline'));
    await render(<HomeScreen />);
    expect(await screen.findByText('Não foi possível falar com o servidor. Tente de novo.', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByText('Nenhum projeto fixado')).toBeNull();
  });
});
