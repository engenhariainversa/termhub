import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/ai-login/viewmodel/useAiLoginStore', () => ({ useAiLoginStore: require('../../../../test/helpers/ui-stores').stores.aiLogin }));
jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/tab-chat/viewmodel/useSessionsStore', () => ({ useSessionsStore: require('../../../../test/helpers/ui-stores').stores.sessions }));
// The conversation pane's microphone: never records here.
jest.mock('@/features/chat/viewmodel/use-voice', () => ({
  useVoice: () => ({ state: 'idle', seconds: 0, error: null, notice: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }),
  useRecorder: () => ({ state: 'idle', seconds: 0, error: null, start: jest.fn(async () => undefined), stop: jest.fn(async () => null), cancel: jest.fn() }),
}));

/** The window the screen sees: an iPad in landscape unless a test resizes it. */
const mockWindow = { width: 1024, height: 768, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));

const mockPush = jest.fn();
let mockFocus: (() => void) | null = null;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
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

const LOAD = { timeout: 15_000 };
/** The seeded `p-termhub` thread's first message (mock fixtures). */
const SEEDED_USER = 'Como estão as abas do projeto?';

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  mockWindow.width = 1024;
  mockWindow.height = 768;
  mockPush.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Chats on a wide window (iPad, spec 2026-09-28 §2.3)', () => {
  it('shows the list and, until one is chosen, an empty pane', async () => {
    await render(<ChatsScreen />);
    expect(await screen.findByText('termhub', undefined, LOAD)).toBeTruthy();
    expect(screen.getByTestId('chats-list-pane')).toBeTruthy();
    expect(screen.getByText('Escolha uma conversa')).toBeTruthy();
  });

  it('opens a chat in the pane next to the list, not as a pushed screen', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Voltar' })).toBeNull();
    expect(screen.getByRole('button', { name: /^termhub/ }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.queryByText('Escolha uma conversa')).toBeNull();
  });

  it('collapses to the list when the window narrows, and brings the chat back when it widens', async () => {
    const view = await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    mockWindow.width = 390; // Slide Over / a narrow Split View
    await view.rerender(<ChatsScreen />);
    expect(screen.queryByTestId('chats-detail-pane')).toBeNull();
    expect(screen.queryByText(SEEDED_USER)).toBeNull();
    // Compact again: a tap pushes, as on a phone.
    await fireEvent.press(screen.getByRole('button', { name: /^Chat geral/ }));
    expect(mockPush).toHaveBeenLastCalledWith('/chat/general');

    mockWindow.width = 1024;
    await view.rerender(<ChatsScreen />);
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
  });

  it('opens a chat with a single request, not a second one from the focus effect re-running', async () => {
    await render(<ChatsScreen />);
    await screen.findByText('termhub', undefined, LOAD);
    const chatSpy = jest.spyOn(stores.api, 'chat');
    const projectsSpy = jest.spyOn(stores.api, 'chatProjects');

    await fireEvent.press(screen.getByRole('button', { name: /^termhub/ }));
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    // Selecting a row mounts `ConversationView`, whose own effect opens it — the focus effect must
    // not also fire again just because `selected` changed (it would double both requests, and toggle
    // the RefreshControl spinner on every tap).
    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(projectsSpy).toHaveBeenCalledTimes(0);
  });

  it('re-opens its own chat when the tab regains focus after a pushed one took over the store', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    await screen.findByText(SEEDED_USER, undefined, LOAD);

    // A notification tap pushed the account-wide chat, which became the store's active one.
    await act(() => useChatStore.getState().openByRoute('general'));
    expect(useChatStore.getState().activeProject).toBeNull();

    await act(async () => mockFocus?.());
    expect(useChatStore.getState().activeProject).toBe('p-termhub');
    expect(await screen.findByText(SEEDED_USER, undefined, LOAD)).toBeTruthy();
  });

  it('shows a failure once: in the pane when a chat is open there, in the list otherwise', async () => {
    await render(<ChatsScreen />);
    await screen.findByText('termhub', undefined, LOAD);
    await act(() => useChatStore.setState({ error: 'Sem conexão' }));
    expect(screen.getAllByText('Sem conexão')).toHaveLength(1); // no pane yet: the list says it

    await fireEvent.press(screen.getByRole('button', { name: /^termhub/ }));
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    await act(() => useChatStore.setState({ error: 'Sem conexão' }));
    // The store has one `error`: the list and the pane both read it, so only the pane shows it.
    expect(screen.getAllByText('Sem conexão')).toHaveLength(1);
    expect(screen.getByTestId('chats-detail-pane')).toBeTruthy();
    await act(() => useChatStore.setState({ error: null }));
  });

  // Last in the file: it denies the seeded confirmations on the shared mock server.
  it('keeps the list live next to the pane: a decision taken there clears its row\'s badge, with no spinner', async () => {
    await render(<ChatsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: /^termhub/ }, LOAD));
    await screen.findByText(SEEDED_USER, undefined, LOAD);
    expect(screen.getByLabelText('2 confirmações pendentes')).toBeTruthy();
    await waitFor(() => expect(useChatStore.getState().loadingProjects).toBe(false));

    const spun: boolean[] = [];
    const unsubscribe = useChatStore.subscribe((s) => spun.push(s.loadingProjects));
    // A real decision through the pane: "Recusar todas" on the grouped card (no PIN for denials)
    // makes the mock server broadcast a `decision` event per card, as the real server does; the
    // list hears it through `subscribeEvents` and re-reads the projects, debounced by a second.
    await fireEvent.press(await screen.findByRole('button', { name: 'Recusar todas' }, LOAD));
    await waitFor(() => expect(screen.queryByLabelText('2 confirmações pendentes')).toBeNull(), { timeout: 5_000 });
    expect(useChatStore.getState().projects.find((p) => p.id === 'p-termhub')!.pending_confirmations).toBe(0);
    unsubscribe();
    expect(spun).not.toContain(true);
  });
});
