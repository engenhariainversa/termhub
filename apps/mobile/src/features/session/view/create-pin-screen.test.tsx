import { fireEvent, render, screen } from '@testing-library/react-native';

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
import { CreatePinScreen } from './create-pin-screen';

/** The whole PIN at once, as the system number pad delivers it into the hidden field. */
async function typePin(pin: string) {
  await fireEvent.changeText(screen.getByLabelText('PIN'), pin);
}

describe('Criar PIN', () => {
  beforeEach(() => {
    useSessionStore.setState({ phase: 'pin_setup', error: null, busy: false });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls createPin once the same six digits are typed twice', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'createPin').mockResolvedValue(undefined);
    await render(<CreatePinScreen />);
    await typePin('123456');
    await typePin('123456');
    expect(spy).toHaveBeenCalledWith('123456', '123456');
  });

  it('shows a mismatch message and restarts at step 1 without calling createPin', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'createPin').mockResolvedValue(undefined);
    await render(<CreatePinScreen />);
    await typePin('123456');
    await typePin('654321');
    expect(screen.getByText('Os PINs não são iguais')).toBeTruthy();
    expect(screen.getByText('Crie um PIN de 6 dígitos')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns to step 1 with an empty pad after a server failure, and a fresh attempt is possible', async () => {
    // Simulates the store's own reaction to a rejected `activate` (a generic failure sets `error`
    // and leaves `phase` at `pin_setup` — see createSessionStore.ts's `fail`), without redoing the
    // store's own activation-failure tests here (createSessionStore.test.ts already covers those).
    const spy = jest.spyOn(useSessionStore.getState(), 'createPin').mockImplementation(async () => {
      useSessionStore.setState({ error: 'Não foi possível falar com o servidor. Tente de novo.' });
    });
    await render(<CreatePinScreen />);
    await typePin('123456');
    await typePin('123456');
    expect(spy).toHaveBeenCalledWith('123456', '123456');
    expect(screen.getByText('Crie um PIN de 6 dígitos')).toBeTruthy();
    expect(screen.getByText('Não foi possível falar com o servidor. Tente de novo.')).toBeTruthy();

    // The pad is empty, not stuck at step 2: a fresh, independent attempt is possible.
    await typePin('654321');
    await typePin('654321');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith('654321', '654321');
  });

  it('shows that the device is being activated while createPin runs, instead of the PIN field', async () => {
    useSessionStore.setState({ busy: true });
    await render(<CreatePinScreen />);
    expect(screen.getByText('Ativando este aparelho…')).toBeTruthy();
    expect(screen.queryByLabelText('PIN')).toBeNull();
    expect(screen.queryByText('Crie um PIN de 6 dígitos')).toBeNull();
  });
});
