import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/ai-login/viewmodel/useAiLoginStore', () => ({ useAiLoginStore: require('../../../../test/helpers/ui-stores').stores.aiLogin }));
jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/tab-chat/viewmodel/useSessionsStore', () => ({ useSessionsStore: require('../../../../test/helpers/ui-stores').stores.sessions }));
// The screen now renders the wide split's embedded `ConversationView` too (unused at this narrow
// width, but its module graph is still loaded): the composer's microphone never records here.
jest.mock('@/features/chat/viewmodel/use-voice', () => ({
  useVoice: () => ({ state: 'idle', seconds: 0, error: null, notice: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }),
  useRecorder: () => ({ state: 'idle', seconds: 0, error: null, start: jest.fn(async () => undefined), stop: jest.fn(async () => null), cancel: jest.fn() }),
}));
// This file is about the compact (phone) behaviour; jest-expo's default window (750 pt wide) is
// past the split's threshold, so it is pinned narrow here. `chats-screen.wide.test.tsx` covers the
// split.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }) }));

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

  it('opens the account-wide chat by route, and a project\'s sessions on a tap (TER-1106)', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Chat geral/ }, LOAD));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/general');
    await fireEvent.press(screen.getByRole('button', { name: /^termhub/ }));
    expect(mockPush).toHaveBeenLastCalledWith('/project-sessions/p-termhub');
  });

  it('the list icon opens the project\'s sessions, the chat icon its concierge; Chat geral has neither', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Sessões de opapingou' }, LOAD));
    expect(mockPush).toHaveBeenLastCalledWith('/project-sessions/p-opapingou');
    await fireEvent.press(screen.getByRole('button', { name: 'Chat de opapingou' }));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/p-opapingou');
    expect(screen.queryByRole('button', { name: 'Chat de Chat geral' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sessões de Chat geral' })).toBeNull();
  });

  it('has no Conversas / Sessões switch any more', async () => {
    await render(<ChatsScreen />);
    await screen.findByText('termhub', undefined, LOAD);
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('counts the tabs waiting on the person in the project\'s badge', async () => {
    await render(<ChatsScreen />);
    // opapingou's `deploy` tab waits on a permission; its chat has no confirmation.
    expect(await screen.findByLabelText('1 pendência', undefined, LOAD)).toBeTruthy();
    expect(screen.getByLabelText('2 confirmações pendentes')).toBeTruthy();
  });
});

describe('Chats: pinning a project (TER-541)', () => {
  afterEach(async () => {
    // The mock server and the store live for the whole file: leave nothing pinned for the next test.
    for (const p of useChatStore.getState().projects) if (p.favorite_position !== null) await useChatStore.getState().setFavorite(p.id, false);
  });

  it('has a pin on each project row, none on Chat geral', async () => {
    await render(<ChatsScreen />);
    expect(await screen.findByRole('button', { name: 'Fixar termhub em Favoritos' }, LOAD)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fixar opapingou em Favoritos' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Chat geral em Favoritos/ })).toBeNull();
  });

  it('the pin pins the project, and then offers to unpin it', async () => {
    const write = jest.spyOn(stores.api, 'setProjectFavorite');
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Fixar termhub em Favoritos' }, LOAD));
    expect(write).toHaveBeenCalledWith(expect.anything(), 'p-termhub', true);
    expect(await screen.findByRole('button', { name: 'Tirar termhub de Favoritos' })).toBeTruthy();
    // The row itself still opens the project.
    await fireEvent.press(screen.getByRole('button', { name: /^termhub/ }));
    expect(mockPush).toHaveBeenLastCalledWith('/project-sessions/p-termhub');
  });

  it('a pinned project moves to the top, after Chat geral, and back to its place when unpinned', async () => {
    await render(<ChatsScreen />);
    const order = () => screen.getAllByRole('button', { name: /^Fixar .* em Favoritos$|^Tirar .* de Favoritos$/ }).map((b) => String(b.props.accessibilityLabel).replace(/^(Fixar|Tirar) | (em|de) Favoritos$/g, ''));
    await screen.findByRole('button', { name: 'Fixar reactivando em Favoritos' }, LOAD);
    const before = order();
    expect(before[before.length - 1]).toBe('reactivando');

    await fireEvent.press(screen.getByRole('button', { name: 'Fixar reactivando em Favoritos' }));
    await screen.findByRole('button', { name: 'Tirar reactivando de Favoritos' });
    expect(order()[0]).toBe('reactivando');
    await fireEvent.press(screen.getByRole('button', { name: 'Fixar opapingou em Favoritos' }));
    await screen.findByRole('button', { name: 'Tirar opapingou de Favoritos' });
    // Favoritos keep the order they were pinned in, as on Home and the web sidebar.
    expect(order().slice(0, 2)).toEqual(['reactivando', 'opapingou']);

    await fireEvent.press(screen.getByRole('button', { name: 'Tirar reactivando de Favoritos' }));
    await screen.findByRole('button', { name: 'Fixar reactivando em Favoritos' });
    expect(order()).toEqual(['opapingou', ...before.filter((n) => n !== 'opapingou')]);
  });

  it('a long press on the row opens a sheet that pins it', async () => {
    await render(<ChatsScreen />);
    await fireEvent(await screen.findByRole('button', { name: /^opapingou/ }, LOAD), 'longPress');
    // The sheet is titled with the project: its name is on screen twice, the row and the title.
    await fireEvent.press(await screen.findByRole('button', { name: 'Fixar em Favoritos' }));
    expect(screen.getAllByText('opapingou')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Tirar opapingou de Favoritos' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fixar em Favoritos' })).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

