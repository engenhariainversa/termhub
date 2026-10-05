import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));

import { setLocale } from '@/i18n';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { StartScreen } from './start-screen';

afterEach(() => {
  setLocale(null);
  jest.restoreAllMocks();
});

it('shows the start screen in English', async () => {
  setLocale('en');
  const spy = jest.spyOn(useSessionStore.getState(), 'requestDevice').mockResolvedValue(undefined);
  await render(<StartScreen />);
  expect(screen.getByText("Sign in with your account's email to request access for this device.")).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('start-email'), 'not-an-email');
  await fireEvent.press(screen.getByRole('button', { name: 'Continue with email' }));
  expect(screen.getByText('Enter a valid email')).toBeTruthy();
  expect(spy).not.toHaveBeenCalled();
});
