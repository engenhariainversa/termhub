/* global jest */
// The `ui` jest project renders screens under jest-expo. Native modules touched at import time
// are replaced here, so a test only mocks what it is about.

// Every screen suite enrols and unlocks for real: scrypt at the production N = 2^14 made them
// time out on a slow CI runner. 2^10 keeps the derivation real but cheap (see `scryptLog2N`).
process.env.TERMHUB_SCRYPT_LOG2N = '10';

// i18n spec §5: the suite runs in pt-BR whatever the machine's locale is (`systemLanguages()` in
// src/i18n reads this instead of `Intl`), so tests keep querying the Portuguese text. A test that
// renders English calls `setLocale('en')` and sets it back to `null` afterwards.
process.env.TERMHUB_TEST_LOCALE = 'pt-BR';


// The gesture handler's own jest setup (its native module has no binding here), and haptics as spies.
require('react-native-gesture-handler/jestSetup');
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => undefined), ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' } }));

// Safe-area insets have no native side under jest.
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    ...require('react-native-safe-area-context/jest/mock'),
    initialWindowMetrics: { insets, frame },
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    SafeAreaProvider: ({ children }) => children,
    SafeAreaView: View,
  };
});

// No native MMKV binding under jest; the in-memory fake backs zustand's persisted stores.
jest.mock('react-native-mmkv', () => require('./fakes/mmkv'));

// The same in-memory fakes the `logic` project uses for these native modules (test/logic-setup.js),
// minus the react-native/expo-router guard: screens under the `ui` project render React Native.
jest.mock('expo-secure-store', () => require('./fakes/secure-store'));
jest.mock('expo-device', () => require('./fakes/expo-device'));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '0.1.0', nativeBuildVersion: '1' }));
jest.mock('expo-updates', () => ({ updateId: null, isEmbeddedLaunch: true, createdAt: null }));
jest.mock('expo-local-authentication', () => require('./fakes/local-auth'));
jest.mock('expo-notifications', () => require('./fakes/expo-notifications'));
jest.mock('expo-tracking-transparency', () => require('./fakes/expo-tracking-transparency'));
jest.mock('@react-native-firebase/analytics', () => require('./fakes/firebase-analytics'));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { scheme: 'termhub' } } }));
jest.mock('@pagopa/io-react-native-crypto', () => ({
  generate: jest.fn(),
  sign: jest.fn(),
  getPublicKeyFixed: jest.fn(),
  deleteKey: jest.fn(),
}));

// The real renderer is ESM-heavy (markdown-it and friends); under jest its children are rendered
// as plain text, tagged so a test can tell a markdown bubble from a plain one.
jest.mock('react-native-markdown-display', () => require('./fakes/markdown'));

// The pickers open native sheets; under jest they answer what a test tells them to.
jest.mock('expo-image-picker', () => require('./fakes/image-picker'));
jest.mock('expo-document-picker', () => require('./fakes/document-picker'));

// The bubble's audio player (TER-1036): no native audio under jest.
jest.mock('expo-audio', () => require('./fakes/expo-audio'));
