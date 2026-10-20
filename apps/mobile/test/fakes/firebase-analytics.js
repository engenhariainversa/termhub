// Stand-in for `@react-native-firebase/analytics` under jest: no native module, calls recorded.
module.exports = {
  getAnalytics: jest.fn(() => ({})),
  logScreenView: jest.fn(async () => undefined),
  setConsent: jest.fn(async () => undefined),
  setAnalyticsCollectionEnabled: jest.fn(async () => undefined),
};
