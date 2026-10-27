import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/tab-chat/viewmodel/useSessionsStore', () => ({ useSessionsStore: require('../../../../test/helpers/ui-stores').stores.sessions }));

const mockReplace = jest.fn();
let mockParams: { projectId?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: mockReplace, canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));

import type { TSessionStartMachine } from '@/services/api/contract';
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
  mockParams = {};
  mockReplace.mockClear();
  jest.restoreAllMocks();
});

/** From Chats: the project, then what comes chosen with it (jarvis and its suggested account). */
const pickTermhub = async () => {
  await fireEvent.press(await screen.findByRole('button', { name: 'termhub' }, LOAD));
  await screen.findByText('Conta de IA');
};
const iniciar = () => screen.getByRole('button', { name: 'Iniciar' });

const machine = (o: Partial<TSessionStartMachine> & Pick<TSessionStartMachine, 'id' | 'name'>): TSessionStartMachine => ({ online: true, choices: [], suggested: null, provider: 'claude', ...o });
const CLAUDE = { account_id: 'acc-claude', label: 'Claude', provider: 'claude', model: 'opus' };
const PEDRO = { account_id: 'acc-pedro', label: 'claude pedro goiania', provider: 'claude', model: null };
const CODEX = { account_id: 'acc-codex', label: 'ChatGPT', provider: 'chatgpt', model: null };
const options = (...machines: TSessionStartMachine[]) => jest.spyOn(stores.api, 'sessionStartOptions').mockResolvedValue({ machines });
const selected = (testID: string) => screen.getByTestId(testID).props.accessibilityState?.selected;

it('from Chats, Iniciar waits for a project and a message, then replaces the route with the new session', async () => {
  const start = jest.spyOn(stores.api, 'startSession');
  await render(<NewSessionScreen />);
  const project = await screen.findByRole('button', { name: 'termhub' }, LOAD);
  expect(iniciar()).toBeDisabled();
  await fireEvent.press(project);
  expect(iniciar()).toBeDisabled();
  // the mock's only online machine (jarvis) and the account the server suggests there come chosen
  await screen.findByText('Conta de IA');
  expect(selected('new-session-machine-m-jarvis')).toBe(true);
  expect(selected('new-session-account-acc-claude')).toBe(true);
  await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'revisa o PR');
  expect(iniciar()).toBeEnabled();
  await fireEvent.press(iniciar());
  await screen.findByRole('button', { name: 'Iniciar' });
  expect(start).toHaveBeenCalledWith(expect.anything(), { project_id: 'p-termhub', machine_id: 'm-jarvis', account_id: 'acc-claude', prompt: 'revisa o PR' });
  expect(mockReplace).toHaveBeenCalledWith(expect.stringMatching(/^\/session\/t-/));
});

describe('from a project (TER-1119)', () => {
  beforeEach(() => {
    mockParams = { projectId: 'p-termhub' };
  });

  it('shows the project in the header, never the list of projects', async () => {
    await render(<NewSessionScreen />);
    expect(await screen.findByText('Máquina', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByText('Projeto')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('new-session-project')).toHaveTextContent('termhub'));
  });

  it('one machine with one account: both come chosen, and Iniciar sends them', async () => {
    options(machine({ id: 'm-jarvis', name: 'jarvis', choices: [PEDRO] }));
    const start = jest.spyOn(stores.api, 'startSession');
    await render(<NewSessionScreen />);
    await screen.findByText('Conta de IA', undefined, LOAD);
    expect(selected('new-session-machine-m-jarvis')).toBe(true);
    expect(selected('new-session-account-acc-pedro')).toBe(true);
    expect(screen.getByText('Claude Code · modelo padrão do CLI')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'oi');
    await fireEvent.press(iniciar());
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.anything(), { project_id: 'p-termhub', machine_id: 'm-jarvis', account_id: 'acc-pedro', prompt: 'oi' }));
  });

  it('several accounts and none suggested: the person picks, and the placeholder follows the CLI', async () => {
    options(machine({ id: 'm-jarvis', name: 'jarvis', choices: [CLAUDE, PEDRO, CODEX], provider: null }));
    const start = jest.spyOn(stores.api, 'startSession');
    await render(<NewSessionScreen />);
    await screen.findByText('Conta de IA', undefined, LOAD);
    expect(screen.getByText('Claude Code · modelo opus')).toBeTruthy();
    expect(selected('new-session-account-acc-claude')).toBe(false);
    await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'oi');
    expect(iniciar()).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'ChatGPT' }));
    expect(screen.getByLabelText('Primeira mensagem').props.placeholder).toBe('O que o Codex deve fazer?');
    await fireEvent.press(iniciar());
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.anything(), { project_id: 'p-termhub', machine_id: 'm-jarvis', account_id: 'acc-codex', prompt: 'oi' }));
  });

  it("only the accounts the server lists show: one exclusive to another project never does", async () => {
    // the server leaves an account exclusive to another project out of `choices` (TER-990)
    options(machine({ id: 'm-jarvis', name: 'jarvis', choices: [CLAUDE], suggested: 'acc-claude' }));
    await render(<NewSessionScreen />);
    await screen.findByText('Conta de IA', undefined, LOAD);
    expect(screen.queryByRole('button', { name: 'claude pedro goiania' })).toBeNull();
    expect(selected('new-session-account-acc-claude')).toBe(true);
  });

  it('an offline machine shows but cannot be picked; with two online, none comes chosen', async () => {
    options(
      machine({ id: 'm-jarvis', name: 'jarvis', choices: [CLAUDE] }),
      machine({ id: 'm-hulk', name: 'hulk', choices: [PEDRO] }),
      machine({ id: 'm-ironman', name: 'homem de ferro', online: false, choices: [CODEX] }),
    );
    await render(<NewSessionScreen />);
    await screen.findByText('Máquina', undefined, LOAD);
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.getByTestId('new-session-machine-m-ironman')).toBeDisabled();
    expect(selected('new-session-machine-m-jarvis')).toBe(false);
    expect(screen.queryByText('Conta de IA')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'hulk' }));
    // the machine's only account comes chosen with it
    expect(selected('new-session-account-acc-pedro')).toBe(true);
  });

  it('a machine with no account says so and keeps Iniciar off', async () => {
    options(machine({ id: 'm-jarvis', name: 'jarvis' }));
    await render(<NewSessionScreen />);
    expect(await screen.findByText('Nenhuma conta de IA nesta máquina pode iniciar um agente. Cadastre uma em Contas de IA.', undefined, LOAD)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'oi');
    expect(iniciar()).toBeDisabled();
  });

  it('a project with no machine says so', async () => {
    options();
    await render(<NewSessionScreen />);
    expect(await screen.findByText('Nenhuma máquina ligada a este projeto.', undefined, LOAD)).toBeTruthy();
  });
});

it("a 409 shows the server's message under the button", async () => {
  jest.spyOn(stores.api, 'startSession').mockRejectedValueOnce(new ApiError(409, 'NO_ACCOUNT', 'O projeto não tem conta de IA'));
  await render(<NewSessionScreen />);
  await pickTermhub();
  await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'oi');
  await fireEvent.press(iniciar());
  expect(await screen.findByText('O projeto não tem conta de IA')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('a message over 4000 characters is refused before the call', async () => {
  const start = jest.spyOn(stores.api, 'startSession');
  await render(<NewSessionScreen />);
  await pickTermhub();
  await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), 'x'.repeat(4001));
  await fireEvent.press(iniciar());
  expect(await screen.findByText('Mensagem longa demais (máximo de 4000 caracteres)')).toBeTruthy();
  expect(start).not.toHaveBeenCalled();
});

describe('the keyboard (TER-1107)', () => {
  // Host views' native methods are shared jest mocks: the body ends 40 pt above the screen's bottom.
  const nativeMethods = require('@react-native/jest-preset/jest/MockNativeMethods').default as { measureInWindow: jest.Mock };
  const { DeviceEventEmitter, Dimensions } = require('react-native') as typeof import('react-native');
  const { getAnimatedStyle } = require('react-native-reanimated') as typeof import('react-native-reanimated');
  // The keyboard as Reanimated sees it, frame by frame (TER-1103): the inset's padding is an animated style.
  const frames = jest.requireMock('@/ui/keyboard-frames') as { KeyboardState: { OPEN: number; CLOSED: number }; __setKeyboardFrame(state: number, height: number): void; __resetKeyboardFrame(): void };
  const SCREEN = Dimensions.get('screen').height;
  const KEYBOARD = 336;

  beforeEach(() => nativeMethods.measureInWindow.mockImplementation((cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 91, 390, SCREEN - 40 - 91)));
  afterEach(() => {
    nativeMethods.measureInWindow.mockReset();
    frames.__resetKeyboardFrame();
  });

  const emit = (name: string, height: number, screenY = SCREEN - height) =>
    DeviceEventEmitter.emit(name, { duration: 0, easing: 'keyboard', startCoordinates: { screenX: 0, screenY: SCREEN, width: 390, height: 0 }, endCoordinates: { screenX: 0, screenY, width: 390, height }, isEventFromThisApp: true });
  const padding = () => (getAnimatedStyle(screen.getByTestId('new-session-body')) as { paddingBottom: number }).paddingBottom;

  it('keeps the first message and Iniciar above the keyboard, outside the list that scrolls', async () => {
    await render(<NewSessionScreen />);
    await screen.findByRole('button', { name: 'termhub' }, LOAD);
    const footer = screen.getByTestId('new-session-footer');
    expect(within(footer).getByLabelText('Primeira mensagem')).toBeTruthy();
    expect(within(footer).getByRole('button', { name: 'Iniciar' })).toBeTruthy();
    expect(padding()).toBe(0);
    await act(() => emit('keyboardWillShow', KEYBOARD));
    await act(() => frames.__setKeyboardFrame(frames.KeyboardState.OPEN, KEYBOARD));
    await waitFor(() => expect(padding()).toBe(KEYBOARD - 40));
    await act(() => emit('keyboardWillHide', KEYBOARD, SCREEN));
    await act(() => frames.__setKeyboardFrame(frames.KeyboardState.CLOSED, 0));
    await waitFor(() => expect(padding()).toBe(0));
  });
});

it('a started session keeps its first message for the session screen (TER-1107)', async () => {
  await render(<NewSessionScreen />);
  await pickTermhub();
  await fireEvent.changeText(screen.getByLabelText('Primeira mensagem'), '  revisa o PR  ');
  await fireEvent.press(iniciar());
  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  const tabId = String(mockReplace.mock.calls[0]![0]).replace('/session/', '');
  expect(stores.sessions.getState().firstPrompts[tabId]).toBe('revisa o PR');
});
