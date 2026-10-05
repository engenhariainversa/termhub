import { AppState } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/automation/viewmodel/usePauseStore', () => ({ usePauseStore: require('../../../../test/helpers/ui-stores').stores.pause }));
jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));
jest.mock('@/features/account/viewmodel/useAccountStore', () => ({ useAccountStore: require('../../../../test/helpers/ui-stores').stores.account }));
jest.mock('@/features/settings/viewmodel/useSettingsStore', () => ({ useSettingsStore: require('../../../../test/helpers/ui-stores').stores.settings }));

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: (cb: () => void | (() => void)) => {
    require('react').useEffect(cb, [cb]);
  },
}));

import { emptyFold } from '@/features/chat/model/live';
import { useChatStore } from '@/features/chat/viewmodel/useChatStore';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { useThemeStore } from '@/features/theme/viewmodel/useThemeStore';
import { setLocale, useLocaleStore } from '@/i18n';
import { ACCOUNT_DELETION_ACTION_ID } from '@/services/api/contract';
import { PIN } from '../../../../test/helpers/enrolled-session';
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
  setLocale(null);
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

    const toggle = screen.getByRole('switch', { name: 'Usar biometria para desbloquear' });
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

  it('Idioma: each language in its own words; picking one switches the screen at once', async () => {
    await render(<SettingsScreen />);
    expect(await screen.findByText('Idioma', undefined, LOAD)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Automático' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Português (Brasil)' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'English' }));
    expect(useLocaleStore.getState().choice).toBe('en');
    expect(await screen.findByText('Settings')).toBeTruthy();
    expect(screen.getByText('Language')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Automatic' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Português (Brasil)' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Automatic' }));
    expect(useLocaleStore.getState().choice).toBeNull();
    expect(await screen.findByText('Ajustes')).toBeTruthy();
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

  it('"Excluir minha conta" explains first, then asks for the PIN and posts a proof for the deletion', async () => {
    const challenge = jest.spyOn(stores.api, 'challenge');
    const post = jest.spyOn(stores.api, 'requestAccountDeletion');
    await render(<SettingsScreen />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Excluir minha conta' }, LOAD));
    expect(screen.getByText(/excluída de vez em 30 dias/)).toBeTruthy();
    expect(screen.getByText(/^O que é apagado/)).toBeTruthy();
    expect(screen.getByText(/^O que fica/)).toBeTruthy();
    expect(screen.getByText(/cancelar a exclusão/)).toBeTruthy();
    expect(useSessionStore.getState().pinPrompt).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Confirmar exclusão' }));
    expect(useSessionStore.getState().pinPrompt).toMatchObject({ actionId: ACCOUNT_DELETION_ACTION_ID, decision: 'delete_account' });
    expect(challenge).not.toHaveBeenCalled();

    await act(async () => useSessionStore.getState().resolvePinPrompt(PIN));
    await waitFor(() => expect(stores.account.getState().pending).toBe(true), LOAD);
    expect(challenge).toHaveBeenCalledWith({ device_id: useSessionStore.getState().deviceId, purpose: 'decision', action_id: ACCOUNT_DELETION_ACTION_ID });
    expect(post).toHaveBeenCalledWith(expect.anything(), { challenge: expect.any(String), pin_proof: expect.any(String) });
    expect(stores.account.getState().scheduledAt).not.toBeNull();

    // The mock refuses every other route while pending: cancel, for the tests that follow.
    await act(async () => stores.account.getState().cancelDeletion());
    expect(stores.account.getState().pending).toBe(false);
  });

  it('"Voltar" closes the explanation without asking for the PIN', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Excluir minha conta' }, LOAD));
    await fireEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.queryByRole('button', { name: 'Confirmar exclusão' })).toBeNull();
    expect(useSessionStore.getState().pinPrompt).toBeNull();
    await screen.findByText('iPhone de teste', undefined, LOAD);
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

  it('opens Permissões do chat', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Permissões do chat' }, LOAD));
    expect(mockRouter.push).toHaveBeenCalledWith('/chat-grants');
    // Waits for this render's own device load, so nothing is left in flight for the next test.
    await screen.findByText('iPhone de teste', undefined, LOAD);
  });

  it('"Memória do chat" pushes /chat-memory', async () => {
    await render(<SettingsScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Memória do chat' }, LOAD));
    expect(mockRouter.push).toHaveBeenCalledWith('/chat-memory');
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

describe('Notificações e Privacidade (permission prompts spec §2)', () => {
  it('a refused permission offers the system settings', async () => {
    stores.permissionDeps.notificationStatus.mockResolvedValueOnce('denied');
    await render(<SettingsScreen />);
    expect(await screen.findByText('Desativadas. Para receber avisos, ative nos Ajustes do sistema.')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Abrir Ajustes do sistema')));
    expect(stores.permissionDeps.openSystemSettings).toHaveBeenCalled();
  });

  it('an undecided permission can be turned on from here', async () => {
    stores.permissionDeps.notificationStatus.mockResolvedValueOnce('undetermined');
    await render(<SettingsScreen />);
    await act(async () => fireEvent.press(await screen.findByText('Ativar notificações')));
    expect(stores.permissionDeps.requestNotifications).toHaveBeenCalled();
  });

  it('the ad measurement switch follows and changes the consent', async () => {
    stores.permissions.setState({ adConsent: 'granted' });
    await render(<SettingsScreen />);
    const toggle = screen.getByRole('switch', { name: 'Medição de anúncios' });
    expect(toggle.props.value).toBe(true);
    await act(async () => fireEvent(toggle, 'valueChange', false));
    expect(stores.permissions.getState().adConsent).toBe('denied');
  });

  it('coming back to the app drops a grant revoked in the system settings', async () => {
    stores.permissions.setState({ adConsent: 'granted' });
    let onChange: (state: string) => void = () => undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      onChange = handler as (state: string) => void;
      return { remove: jest.fn() };
    });
    await render(<SettingsScreen />);
    expect(screen.getByRole('switch', { name: 'Medição de anúncios' }).props.value).toBe(true);
    stores.permissionDeps.trackingStatus.mockResolvedValue('denied');
    await act(async () => onChange('active'));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Medição de anúncios' }).props.value).toBe(false));
    stores.permissionDeps.trackingStatus.mockResolvedValue('undetermined');
  });

  it('has the pause switch for the automatic work', async () => {
    await render(<SettingsScreen />);
    expect(screen.getByText('Trabalho automático')).toBeTruthy();
    expect(await screen.findByText('Pausar automático', {}, LOAD)).toBeTruthy();
    stores.pause.getState().stopPolling();
  });
});
