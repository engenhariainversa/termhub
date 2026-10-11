import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/tab-chat/viewmodel/useSessionsStore', () => ({ useSessionsStore: require('../../../../test/helpers/ui-stores').stores.sessions }));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
}));

import { ApiError } from '@/services/api/errors';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { SessionsList } from './sessions-list';

const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  stores.sessions.setState({ tabs: [], groups: [], loaded: false, forbidden: false, error: null });
});

afterEach(() => {
  mockPush.mockClear();
  jest.restoreAllMocks();
});

it('lists the tabs under their project, each with its machine and state line, loading once', async () => {
  const load = jest.spyOn(stores.api, 'tabs');
  await render(<SessionsList />);
  expect(await screen.findByText('api', undefined, LOAD)).toBeTruthy();
  expect(screen.getByText('termhub')).toBeTruthy();
  expect(screen.getByText('opapingou')).toBeTruthy();
  expect(screen.getByText('Trabalhando · Bash')).toBeTruthy();
  expect(screen.getByText('Esperando você')).toBeTruthy();
  expect(screen.getAllByText('jarvis').length).toBeGreaterThan(0);
  expect(screen.getByText('hulk')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
});

it('a tab that is not ready shows why in place of its state, and still opens', async () => {
  await render(<SessionsList />);
  expect(await screen.findByText('Atualize o agente desta máquina', undefined, LOAD)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: /^web/ }));
  expect(mockPush).toHaveBeenLastCalledWith('/session/t-web');
});

it('tapping a row opens its session', async () => {
  await render(<SessionsList />);
  await fireEvent.press(await screen.findByRole('button', { name: /^api/ }, LOAD));
  expect(mockPush).toHaveBeenLastCalledWith('/session/t-api');
});

it('idle and failed tabs read Parado and Erro', async () => {
  const { tabs } = await stores.api.tabs(stores.store.getState().auth());
  jest.spyOn(stores.api, 'tabs').mockResolvedValueOnce({ tabs: [{ ...tabs[0]!, state: 'idle', activity: null }, { ...tabs[2]!, state: 'error', needs_you: false }] });
  await render(<SessionsList />);
  expect(await screen.findByText('Parado', undefined, LOAD)).toBeTruthy();
  expect(screen.getByText('Erro')).toBeTruthy();
});

it('an empty list says so and offers Nova sessão', async () => {
  jest.spyOn(stores.api, 'tabs').mockResolvedValueOnce({ tabs: [] });
  await render(<SessionsList />);
  expect(await screen.findByText('Nenhuma aba aberta nos seus projetos.', undefined, LOAD)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Nova sessão' }));
  expect(mockPush).toHaveBeenLastCalledWith('/session/new');
});

it('Nova sessão is there above a list too', async () => {
  await render(<SessionsList />);
  await screen.findByText('api', undefined, LOAD);
  await fireEvent.press(screen.getByRole('button', { name: 'Nova sessão' }));
  expect(mockPush).toHaveBeenLastCalledWith('/session/new');
});

it('a person without terminal access is told so, with no button', async () => {
  jest.spyOn(stores.api, 'tabs').mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Sem permissão'));
  await render(<SessionsList />);
  expect(await screen.findByText('Seu acesso não inclui terminais.', undefined, LOAD)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Nova sessão' })).toBeNull();
});
