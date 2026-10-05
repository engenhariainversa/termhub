/* global jest */
// The `logic` jest project runs models, viewmodels and services in plain Node (spec §2, §14):
// none of them may import React Native or expo-router, and every native module they do touch
// gets an in-memory fake here instead of a real binding.

// MVVM guard (spec §2): models, viewmodels and services must run without React Native.
jest.mock('react-native', () => {
  throw new Error('react-native must not be imported by models, viewmodels or services');
});
jest.mock('expo-router', () => {
  throw new Error('expo-router must not be imported by models, viewmodels or services');
});
jest.mock('react-native-mmkv', () => require('./fakes/mmkv'));
jest.mock('expo-secure-store', () => require('./fakes/secure-store'));
jest.mock('expo-device', () => require('./fakes/expo-device'));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '0.1.0', nativeBuildVersion: '1' }));
jest.mock('expo-updates', () => ({ updateId: null, isEmbeddedLaunch: true }));
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
