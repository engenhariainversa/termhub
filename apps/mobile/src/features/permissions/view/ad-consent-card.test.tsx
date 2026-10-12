import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/permissions/viewmodel/usePermissionsStore', () => ({ usePermissionsStore: require('../../../../test/helpers/ui-stores').stores.permissions }));

import { stores } from '../../../../test/helpers/ui-stores';
import { AdConsentCard } from './ad-consent-card';

const store = stores.permissions;
beforeEach(() => store.setState({ platform: 'ios', adConsent: 'unknown', trackingStatus: 'undetermined' }));

it('on iOS asks while consent is unknown, and "Continuar" always goes through ATT', async () => {
  await render(<AdConsentCard />);
  expect(screen.getByText('Ajude a melhorar o termhub')).toBeTruthy();
  expect(screen.queryByText('Agora não')).toBeNull();
  expect(screen.queryByText('Permitir')).toBeNull();
  await act(async () => fireEvent.press(screen.getByText('Continuar')));
  expect(stores.permissionDeps.requestTracking).toHaveBeenCalled();
  expect(store.getState().adConsent).toBe('granted');
  expect(screen.queryByText('Ajude a melhorar o termhub')).toBeNull();
});

it('on Android "Permitir" and "Agora não" are ours, and "Agora não" declines and hides it', async () => {
  store.setState({ platform: 'android', trackingStatus: 'unavailable' });
  await render(<AdConsentCard />);
  expect(screen.getByText('Permitir')).toBeTruthy();
  expect(screen.queryByText('Continuar')).toBeNull();
  await act(async () => fireEvent.press(screen.getByText('Agora não')));
  expect(store.getState().adConsent).toBe('denied');
  expect(screen.queryByText('Ajude a melhorar o termhub')).toBeNull();
});

it('stays hidden once decided, or when iOS already refused ATT', async () => {
  store.setState({ adConsent: 'denied' });
  await render(<AdConsentCard />);
  expect(screen.queryByText('Ajude a melhorar o termhub')).toBeNull();
  await act(async () => store.setState({ adConsent: 'unknown', trackingStatus: 'denied' }));
  expect(screen.queryByText('Ajude a melhorar o termhub')).toBeNull();
});
