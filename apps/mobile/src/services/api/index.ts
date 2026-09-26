// The app-wide `MobileApi` singleton (design spec §4.1). `src/services` must not import
// `react-native`, so platform/version come from `expo-application` and `expo-device` instead of
// `Platform` — both are already mocked under Jest (`test/logic-setup.js`, `test/ui-setup.js`).
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import { appHeader, type AppPlatform } from './app-header';
import { createHttpMobileApi } from './client';
import { TERMHUB_URL } from './config';
import { createMockTransport, type MockControls } from './mock';
import { FetchTransport } from './transport';
import type { Transport } from './transport';
import type { MobileApi } from './types';
import { socketWake } from './wake';
import { deviceKey } from '../key';

const platform: AppPlatform = Device.osName === 'iOS' ? 'ios' : 'android';
const app = appHeader(platform, Application.nativeApplicationVersion, Application.nativeBuildVersion);

// `mock` when unset (Jest, or `expo start` with no `.env`): only an explicit `http` talks to a
// server. `.env.example` and every `eas.json` profile set `http`.
const mode: 'mock' | 'http' = process.env.EXPO_PUBLIC_API_MODE === 'http' ? 'http' : 'mock';

// The session store (Task 10) calls this once at boot to register its single-flighted
// `challenge` + `token` renewal, without `index.ts` having to import the store (which would be a
// require cycle: the store imports `api` to make calls).
let renewer: () => Promise<string | null> = async () => null;
export function setTokenRenewer(fn: () => Promise<string | null>): void {
  renewer = fn;
}

// Same wiring as `renewer`, for the session store's `tokenStale` (Task 4): a refused chat socket
// renews only when this says the token is actually stale (TER-93).
let staleCheck: () => boolean = () => true;
export function setTokenStaleCheck(fn: () => boolean): void {
  staleCheck = fn;
}

function buildTransport(): { transport: Transport; mockControls: MockControls | null } {
  if (mode === 'http') return { transport: new FetchTransport(), mockControls: null };
  const mock = createMockTransport();
  return { transport: mock, mockControls: mock.controls };
}

const { transport, mockControls: resolvedMockControls } = buildTransport();

// The mock transport's controls (`approve`, `deny`, ...), reached by the *Aguardando* screen
// through the viewmodel's `mockControls` field. `null` in `http` mode.
export const mockControls: MockControls | null = resolvedMockControls;

export const api: MobileApi = createHttpMobileApi({
  transport,
  baseUrl: TERMHUB_URL,
  app,
  key: deviceKey,
  onTokenExpired: () => renewer(),
  mode,
  // `_layout.tsx` emits it on AppState `active`, the session store on entering `unlocked`.
  foreground: { subscribe: socketWake.subscribe },
  tokenStale: () => staleCheck(),
});
