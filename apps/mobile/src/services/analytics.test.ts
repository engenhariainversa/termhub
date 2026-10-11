import * as Analytics from '@react-native-firebase/analytics';
import { logScreen, setAdConsent } from './analytics';

const analytics = Analytics as unknown as Record<string, jest.Mock>;
beforeEach(() => jest.clearAllMocks());

it('grants or denies the ad signals and usage analytics together', async () => {
  await setAdConsent(true);
  expect(analytics.setConsent).toHaveBeenLastCalledWith({}, { ad_storage: true, ad_user_data: true, ad_personalization: true, analytics_storage: true });
  expect(analytics.setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith({}, true);
  await setAdConsent(false);
  expect(analytics.setConsent).toHaveBeenLastCalledWith({}, { ad_storage: false, ad_user_data: false, ad_personalization: false, analytics_storage: false });
  expect(analytics.setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith({}, false);
});

it('logs screen views only after the person accepted', async () => {
  await setAdConsent(false);
  logScreen('/chat/[id]');
  expect(analytics.logScreenView).not.toHaveBeenCalled();
  await setAdConsent(true);
  logScreen('/chat/[id]');
  expect(analytics.logScreenView).toHaveBeenCalledWith({}, { screen_name: '/chat/[id]', screen_class: '/chat/[id]' });
});

it('never throws when the native module is missing', async () => {
  analytics.getAnalytics!.mockImplementationOnce(() => {
    throw new Error('native module missing');
  });
  await expect(setAdConsent(true)).resolves.toBeUndefined();
  analytics.setConsent!.mockRejectedValueOnce(new Error('boom'));
  await expect(setAdConsent(true)).resolves.toBeUndefined();
  analytics.getAnalytics!.mockImplementationOnce(() => {
    throw new Error('native module missing');
  });
  expect(() => logScreen('/')).not.toThrow();
});
