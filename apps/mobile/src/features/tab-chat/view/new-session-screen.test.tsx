import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/tab-chat/viewmodel/useSessionsStore', () => ({ useSessionsStore: require('../../../../test/helpers/ui-stores').stores.sessions }));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: mockReplace, canGoBack: () => true }),
  useLocalSearchParams: () => ({}),
}));

import { ApiError } from '@/services/api/errors';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { NewSessionScreen } from './new-session-screen';

const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  stores.sessions.setState({ startError: null, starting: false });
});

afterEach(() => {
  mockReplace.mockClear();
  jest.restoreAllMocks();
});

const iniciar = () => screen.getByRole('button', { name: 'Iniciar' });

it('Iniciar waits for a project and a message, then replaces the route with the new session', async () => {
  const start = jest.spyOn(stores.api, 'startSession');
  await render(<NewSessionScreen />);
  const project = await screen.findByRole('button', { name: 'termhub' }, LOAD);
  expect(iniciar()).toBeDisabled();
  await fireEvent.press(project);
  expect(iniciar()).toBeDisabled();
  await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'revisa o PR');
  expect(iniciar()).toBeEnabled();
  await fireEvent.press(iniciar());
  await screen.findByRole('button', { name: 'Iniciar' });
  expect(start).toHaveBeenCalledWith(expect.anything(), { project_id: 'p-termhub', prompt: 'revisa o PR' });
  expect(mockReplace).toHaveBeenCalledWith(expect.stringMatching(/^\/session\/t-/));
});

it('a project on one machine shows no machine picker', async () => {
  await render(<NewSessionScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: 'termhub' }, LOAD));
  await screen.findByLabelText('Primeira mensagem');
  expect(screen.queryByText('Máquina')).toBeNull();
});

it('a project on more than one machine asks which, and sends it', async () => {
  jest.spyOn(stores.api, 'getProjectAi').mockResolvedValue({
    ai: { accounts: [], models: { claude: null, chatgpt: null } },
    available: [
      { id: 'acc-1', label: 'Claude', provider: 'claude', machine_id: 'm-jarvis', machine_name: 'jarvis', default: true },
      { id: 'acc-2', label: 'Claude', provider: 'claude', machine_id: 'm-hulk', machine_name: 'hulk', default: false },
    ],
  });
  const start = jest.spyOn(stores.api, 'startSession');
  await render(<NewSessionScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: 'termhub' }, LOAD));
  expect(await screen.findByText('Máquina')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'hulk' }));
  await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'oi');
  await fireEvent.press(iniciar());
  await screen.findByRole('button', { name: 'Iniciar' });
  expect(start).toHaveBeenCalledWith(expect.anything(), { project_id: 'p-termhub', machine_id: 'm-hulk', prompt: 'oi' });
});

it("a 409 shows the server's message under the button", async () => {
  jest.spyOn(stores.api, 'startSession').mockRejectedValueOnce(new ApiError(409, 'NO_ACCOUNT', 'O projeto não tem conta de IA'));
  await render(<NewSessionScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: 'termhub' }, LOAD));
  await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'oi');
  await fireEvent.press(iniciar());
  expect(await screen.findByText('O projeto não tem conta de IA')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('a message over 4000 characters is refused before the call', async () => {
  const start = jest.spyOn(stores.api, 'startSession');
  await render(<NewSessionScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: 'termhub' }, LOAD));
  await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'x'.repeat(4001));
  await fireEvent.press(iniciar());
  expect(await screen.findByText('Mensagem longa demais (máximo de 4000 caracteres)')).toBeTruthy();
  expect(start).not.toHaveBeenCalled();
});

describe('the keyboard (TER-1107)', () => {
  // Host views' native methods are shared jest mocks: the body ends 40 pt above the screen's bottom.
  const nativeMethods = require('@react-native/jest-preset/jest/MockNativeMethods').default as { measureInWindow: jest.Mock };
  const { DeviceEventEmitter, Dimensions, StyleSheet } = require('react-native') as typeof import('react-native');
  const SCREEN = Dimensions.get('screen').height;
  const KEYBOARD = 336;

  beforeEach(() => nativeMethods.measureInWindow.mockImplementation((cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 91, 390, SCREEN - 40 - 91)));
  afterEach(() => nativeMethods.measureInWindow.mockReset());

  const emit = (name: string, height: number, screenY = SCREEN - height) =>
    DeviceEventEmitter.emit(name, { duration: 0, easing: 'keyboard', startCoordinates: { screenX: 0, screenY: SCREEN, width: 390, height: 0 }, endCoordinates: { screenX: 0, screenY, width: 390, height }, isEventFromThisApp: true });
  const padding = () => StyleSheet.flatten(screen.getByTestId('new-session-body').props.style).paddingBottom;

  it('keeps the first message and Iniciar above the keyboard, outside the list that scrolls', async () => {
    await render(<NewSessionScreen />);
    await screen.findByRole('button', { name: 'termhub' }, LOAD);
    const footer = screen.getByTestId('new-session-footer');
    expect(within(footer).getByLabelText('Primeira mensagem')).toBeTruthy();
    expect(within(footer).getByRole('button', { name: 'Iniciar' })).toBeTruthy();
    expect(padding()).toBe(0);
    await act(() => emit('keyboardWillShow', KEYBOARD));
    await waitFor(() => expect(padding()).toBe(KEYBOARD - 40));
    await act(() => emit('keyboardWillHide', KEYBOARD, SCREEN));
    await waitFor(() => expect(padding()).toBe(0));
  });
});

it('a started session keeps its first message for the session screen (TER-1107)', async () => {
  await render(<NewSessionScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: 'termhub' }, LOAD));
  await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), '  revisa o PR  ');
  await fireEvent.press(iniciar());
  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  const tabId = String(mockReplace.mock.calls[0]![0]).replace('/session/', '');
  expect(stores.sessions.getState().firstPrompts[tabId]).toBe('revisa o PR');
});
