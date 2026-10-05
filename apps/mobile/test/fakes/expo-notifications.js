// Stand-in for `expo-notifications` under jest: no native module, permission granted, a fixed token,
// and no tapped notification.
module.exports = {
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ type: 'expo', data: 'ExponentPushToken[jest]' })),
  useLastNotificationResponse: () => null,
  clearLastNotificationResponse: jest.fn(),
  setBadgeCountAsync: jest.fn(async () => true),
  getPresentedNotificationsAsync: jest.fn(async () => []),
  dismissNotificationAsync: jest.fn(async () => undefined),
};
