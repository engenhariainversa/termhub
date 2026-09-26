/* global jest */
// The `ui` jest project renders screens under jest-expo. Native modules touched at import time
// are replaced here, so a test only mocks what it is about.

// Every screen suite enrols and unlocks for real: scrypt at the production N = 2^14 made them
// time out on a slow CI runner. 2^10 keeps the derivation real but cheap (see `scryptLog2N`).
process.env.TERMHUB_SCRYPT_LOG2N = '10';

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
jest.mock('expo-local-authentication', () => require('./fakes/local-auth'));
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
