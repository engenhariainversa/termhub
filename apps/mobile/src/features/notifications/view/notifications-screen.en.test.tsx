import { render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), useFocusEffect: () => undefined }));

import { setLocale } from '@/i18n';
import { useNotificationsStore } from '../viewmodel/useNotificationsStore';
import { syntheticConfirmationRow } from '../model/synthetic-row';
import { NotificationsScreen } from './notifications-screen';

afterEach(() => setLocale(null));

it('shows the empty notifications screen in English', async () => {
  setLocale('en');
  useNotificationsStore.setState({ items: [], loading: false, error: null });
  await render(<NotificationsScreen />);
  expect(screen.getByText('Notifications')).toBeTruthy();
  expect(screen.getByText('Nothing here')).toBeTruthy();
});

it('writes the placeholder row of a live confirmation in English', () => {
  setLocale('en');
  const event = { type: 'confirmation', action_id: 'a1', conversation_id: 'c1', project_id: 'p1' } as never;
  expect(syntheticConfirmationRow(event, 'termhub', 0)).toMatchObject({
    title: 'termhub needs you',
    body: 'The termhub project chat asked for approval to act.',
  });
});
