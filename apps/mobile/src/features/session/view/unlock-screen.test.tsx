import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => {
  const { createSessionStore } = require('@/features/session/viewmodel/createSessionStore');
  const { createHttpMobileApi } = require('@/services/api/client');
  const { createMockTransport } = require('@/services/api/mock');
  const { SoftwareDeviceKey } = require('@/services/key/software');
  const { vault } = require('@/services/vault');
  const transport = createMockTransport({ latency: [0, 0] });
  const key = new SoftwareDeviceKey();
  const api = createHttpMobileApi({ transport, baseUrl: 'https://termhub.dev', app: 'ios/0.1.0+1', key, onTokenExpired: async () => null });
  return { useSessionStore: createSessionStore({ api, key, vault, mockControls: transport.controls }) };
});

import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { UnlockScreen } from './unlock-screen';

/** The whole PIN at once, as the system number pad delivers it into the hidden field. */
async function typePin(pin: string) {
  await fireEvent.changeText(screen.getByLabelText('PIN'), pin);
}

describe('Desbloquear', () => {
  beforeEach(() => {
    useSessionStore.setState({ phase: 'locked', error: null, attemptsLeft: null, lockedUntil: null, biometricsEnabled: false, busy: false });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls unlock once six digits are typed', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'unlock').mockResolvedValue(undefined);
    await render(<UnlockScreen />);
    await typePin('123456');
    expect(spy).toHaveBeenCalledWith('123456');
  });

  it('shows the wrong-PIN message with the attempts left', async () => {
    useSessionStore.setState({ error: 'PIN incorreto.', attemptsLeft: 2 });
    await render(<UnlockScreen />);
    expect(screen.getByText('PIN incorreto. 2 tentativas restantes.')).toBeTruthy();
  });

  it('shows the locked banner and countdown, and disables the PIN field', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'unlock').mockResolvedValue(undefined);
    useSessionStore.setState({ lockedUntil: new Date(Date.now() + 5 * 60_000).toISOString() });
    await render(<UnlockScreen />);
    expect(screen.getByText('Aparelho bloqueado')).toBeTruthy();
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toBeTruthy();
    expect(screen.getByLabelText('PIN').props.editable).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-enables the PIN field once the lock countdown reaches zero, and a PIN can be typed again', async () => {
    jest.useFakeTimers();
    try {
      const spy = jest.spyOn(useSessionStore.getState(), 'unlock').mockResolvedValue(undefined);
      useSessionStore.setState({ lockedUntil: new Date(Date.now() + 3_000).toISOString(), error: 'Aparelho bloqueado por tentativas de PIN.' });
      await render(<UnlockScreen />);
      expect(screen.getByLabelText('PIN').props.editable).toBe(false);

      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      expect(useSessionStore.getState()).toMatchObject({ lockedUntil: null, error: null, attemptsLeft: null });
      expect(screen.queryByText('Aparelho bloqueado')).toBeNull();
      expect(screen.getByLabelText('PIN').props.editable).toBe(true);

      await typePin('123456');
      expect(spy).toHaveBeenCalledWith('123456');
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('hides "Usar biometria" when biometrics are disabled', async () => {
    await render(<UnlockScreen />);
    expect(screen.queryByRole('button', { name: 'Usar biometria' })).toBeNull();
  });

  it('shows "Usar biometria" and calls unlockWithBiometrics when biometrics are enabled', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'unlockWithBiometrics').mockResolvedValue(undefined);
    useSessionStore.setState({ biometricsEnabled: true });
    await render(<UnlockScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Usar biometria' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shows that the PIN is being checked while unlock runs, instead of the PIN field', async () => {
    useSessionStore.setState({ busy: true });
    await render(<UnlockScreen />);
    expect(screen.getByText('Conferindo o PIN…')).toBeTruthy();
    expect(screen.queryByLabelText('PIN')).toBeNull();
  });
});
