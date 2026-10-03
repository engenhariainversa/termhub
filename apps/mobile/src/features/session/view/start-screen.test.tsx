import { fireEvent, render, screen } from '@testing-library/react-native';
import type { DeviceKey } from '@/services/key/types';

// A real store over the mock transport (latency 0), per the brief: the screen is driven against
// its actual viewmodel, not a hand-written fake.
jest.mock('@/features/session/viewmodel/useSessionStore', () => {
  const { createSessionStore } = require('@/features/session/viewmodel/createSessionStore');
  const { createHttpMobileApi } = require('@/services/api/client');
  const { createMockTransport } = require('@/services/api/mock');
  const { SoftwareDeviceKey } = require('@/services/key/software');
  const { vault } = require('@/services/vault');
  const transport = createMockTransport({ latency: [0, 0] });
  const key = new SoftwareDeviceKey();
  const api = createHttpMobileApi({ transport, baseUrl: 'https://termhub.dev', app: 'ios/0.1.0+1', key, onTokenExpired: async () => null });
  return { useSessionStore: createSessionStore({ api, key, vault, mockControls: transport.controls }), mockKey: key };
});

import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';

const { mockKey } = jest.requireMock('@/features/session/viewmodel/useSessionStore') as { mockKey: DeviceKey };
import { StartScreen } from './start-screen';

describe('Início', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls requestDevice with a valid e-mail', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'requestDevice').mockResolvedValue(undefined);
    await render(<StartScreen />);
    await fireEvent.changeText(screen.getByTestId('start-email'), 'pedro@x.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Continuar com e-mail' }));
    expect(spy).toHaveBeenCalledWith('pedro@x.com');
  });

  it('shows the error for an invalid e-mail and calls nothing', async () => {
    const spy = jest.spyOn(useSessionStore.getState(), 'requestDevice').mockResolvedValue(undefined);
    await render(<StartScreen />);
    await fireEvent.changeText(screen.getByTestId('start-email'), 'not-an-email');
    await fireEvent.press(screen.getByRole('button', { name: 'Continuar com e-mail' }));
    expect(screen.getByText('Digite um e-mail válido')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  // Apple 5.1.1(i): the privacy policy is linked inside the app, and the screen says what the e-mail is for.
  it('says what the e-mail is for and links the terms and the privacy policy', async () => {
    await render(<StartScreen />);
    expect(screen.getByText(/Usamos o seu e-mail para/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Termos de uso' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Política de privacidade' })).toBeTruthy();
  });

  it("shows the store's error when requestDevice fails", async () => {
    jest.spyOn(mockKey, 'create').mockRejectedValueOnce(new Error('keystore'));
    await render(<StartScreen />);
    await fireEvent.changeText(screen.getByTestId('start-email'), 'pedro@x.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Continuar com e-mail' }));
    expect(await screen.findByText('Não foi possível falar com o servidor. Tente de novo.')).toBeTruthy();
    expect(useSessionStore.getState()).toMatchObject({ phase: 'new', busy: false });
  });
});
