import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/settings/viewmodel/useSettingsStore', () => ({ useSettingsStore: require('../../../../test/helpers/ui-stores').stores.settings }));

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

import { emptyFold } from '@/features/chat/model/live';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { useThemeStore } from '@/features/theme/viewmodel/useThemeStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { SettingsScreen } from './settings-screen';

const LOAD = { timeout: 15_000 };

/** Not `jest.spyOn(getState(), …)`: zustand replaces the state object on every `setState`, so a
 * restored spy would linger on the new one (same reason `conversation-screen.test.tsx` uses it). */
const realSessionActions = { ...stores.store.getState() };

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const fn of Object.values(mockRouter)) fn.mockClear();
  useSessionStore.setState({
    error: null,
    enableBiometrics: realSessionActions.enableBiometrics,
    disableBiometrics: realSessionActions.disableBiometrics,
    leave: realSessionActions.leave,
    biometricsEnabled: false,
  });
  useThemeStore.setState({ theme: 'system' });
  useChatStore.setState({ activeProject: undefined, live: emptyFold() });
});

describe('Ajustes', () => {
  it('shows this device, once loaded', async () => {
    await render(<SettingsScreen />);
    expect(await screen.findByText('iPhone de teste', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText(/iPhone15,2/)).toBeTruthy();
  });

  it('the biometrics switch calls enableBiometrics / disableBiometrics', async () => {
    const enable = jest.fn(async () => true);
    const disable = jest.fn(async () => undefined);
    useSessionStore.setState({ enableBiometrics: enable, disableBiometrics: disable, biometricsEnabled: false });
    await render(<SettingsScreen />);
    // Waits for this render's own device load, so no request of it is still in flight (or left
    // for the next test) whichever test ran before.
    await screen.findByText('iPhone de teste', undefined, LOAD);

    const toggle = screen.getByRole('switch');
    await act(async () => fireEvent(toggle, 'valueChange', true));
    expect(enable).toHaveBeenCalledTimes(1);

    await act(async () => useSessionStore.setState({ biometricsEnabled: true }));
    await act(async () => fireEvent(toggle, 'valueChange', false));
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it('the theme buttons call setTheme', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Escuro' }, LOAD));
    expect(useThemeStore.getState().theme).toBe('dark');
    await fireEvent.press(screen.getByRole('button', { name: 'Claro' }));
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('"Sair e remover este aparelho" asks first, then calls leave()', async () => {
    const leave = jest.fn(async () => undefined);
    useSessionStore.setState({ leave });
    await render(<SettingsScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Sair e remover este aparelho' }, LOAD));
    expect(leave).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Remover' }));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('shows the general chat host line and the mock server mode, without switching what is actually open', async () => {
    // A project's conversation is the one really open (e.g. behind a pushed chat screen) — Ajustes
    // must refresh the general chat's slot for its host line without stealing `activeProject`.
    useChatStore.setState({ activeProject: 'p-termhub' });

    await render(<SettingsScreen />);
    await waitFor(() => expect(useChatStore.getState().conversations['']?.host).not.toBeNull(), LOAD);
    const host = useChatStore.getState().conversations['']?.host;
    if (!host) throw new Error('expected the general chat host to be loaded');
    expect(screen.getByText(new RegExp(host.kind === 'ready' ? host.machine.name : ''))).toBeTruthy();
    expect(screen.getByText('Servidor: mock')).toBeTruthy();
    expect(useChatStore.getState().activeProject).toBe('p-termhub');
  });

  it('opens Abas confiáveis', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Abas confiáveis' }, LOAD));
    expect(mockRouter.push).toHaveBeenCalledWith('/chat-grants');
    // Waits for this render's own device load, so nothing is left in flight for the next test.
    await screen.findByText('iPhone de teste', undefined, LOAD);
  });

  it('runs the key diagnostic and shows every step ok', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Testar a chave do aparelho' }, LOAD));
    expect(await screen.findByText('create: ok', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('destroy: ok')).toBeTruthy();
  });
});
