// The app's one session store: the factory over the real singletons. Importing this module
// registers the store's renewal as the API client's renewer (`index.ts` never imports the store,
// so there is no require cycle).
import * as LocalAuthentication from 'expo-local-authentication';
import { api, mockControls, setTokenRenewer, setTokenStaleCheck } from '@/services/api';
import { deviceKey } from '@/services/key';
import { vault } from '@/services/vault';
import type { LocalAuth } from '../model/session.types';
import { createSessionStore } from './createSessionStore';

const localAuth: LocalAuth = {
  available: async () => (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()),
  authenticate: async () => (await LocalAuthentication.authenticateAsync({ promptMessage: 'Ativar a biometria' })).success,
};

export const useSessionStore = createSessionStore({ api, key: deviceKey, vault, mockControls, localAuth });

setTokenRenewer(() => useSessionStore.getState().renewToken());
setTokenStaleCheck(() => useSessionStore.getState().tokenStale());
