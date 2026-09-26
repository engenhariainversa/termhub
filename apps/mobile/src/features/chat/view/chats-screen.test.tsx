import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));

const mockPush = jest.fn();
/** The last `useFocusEffect` callback: a test calls it to simulate the tab coming back into focus. */
let mockFocus: (() => void) | null = null;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  // Runs on mount like the real hook (a screen is focused when it mounts), and keeps the callback.
  useFocusEffect: (cb: () => void) => {
    require('react').useEffect(() => {
      mockFocus = cb;
      cb();
    }, [cb]);
  },
  useLocalSearchParams: () => ({}),
  Link: ({ children }: { children: unknown }) => children,
}));

import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ChatsScreen } from './chats-screen';

/** The first load of a file signs its first P-256 proof, slow while other suites share the CPU. */
const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  mockPush.mockClear();
  jest.restoreAllMocks();
});

describe('Chats', () => {
  it('lists Chat geral and the three projects, with "respondendo…" when busy and the pending badge', async () => {
    await render(<ChatsScreen />);
    expect(await screen.findByText('termhub', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Chat geral')).toBeTruthy();
    expect(screen.getByText('opapingou')).toBeTruthy();
    expect(screen.getByText('reactivando')).toBeTruthy();
    expect(screen.getByLabelText('2 confirmações pendentes')).toBeTruthy();
    expect(screen.queryByText('respondendo…')).toBeNull();

    // The mock's own busy window closes within a tick; set it directly.
    const projects = useChatStore.getState().projects.map((p) => (p.id === 'p-opapingou' ? { ...p, busy: true } : p));
    await act(() => useChatStore.setState({ projects }));
    expect(await screen.findByText('respondendo…', undefined, LOAD)).toBeTruthy();
  });

  it('reloads the projects each time the tab comes back into focus', async () => {
    const load = jest.spyOn(stores.api, 'chatProjects');
    await render(<ChatsScreen />);
    await screen.findByText('termhub', undefined, LOAD);
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => mockFocus?.());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('opens the account-wide chat and a project by route', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Chat geral/ }, LOAD));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/general');
    await fireEvent.press(screen.getByRole('button', { name: /^termhub/ }));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/p-termhub');
  });
});
