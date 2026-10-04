import { fireEvent, render, screen } from '@testing-library/react-native';

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
