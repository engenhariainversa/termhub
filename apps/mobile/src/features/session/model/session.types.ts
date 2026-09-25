// The session feature's state (design spec §5.1). The router reads `phase` and nothing else.
import type { PinDecision } from '@/services/api/contract';
import type { MockControls } from '@/services/api/mock';
import type { Auth, MobileApi } from '@/services/api/types';
import type { DeviceKey } from '@/services/key/types';
import type { vault } from '@/services/vault';

export type Phase = 'new' | 'waiting' | 'pin_setup' | 'locked' | 'unlocked';

/** Only `new` and `locked` survive a restart: a pending request expires on the server anyway, a
 * PIN never got created for `pin_setup`, and a cold start always asks for the PIN again. */
export function persistablePhase(phase: Phase): Phase {
  if (phase === 'waiting' || phase === 'pin_setup') return 'new';
  if (phase === 'unlocked') return 'locked';
  return phase;
}

/** The OS biometric prompt (`expo-local-authentication`), injected so the store stays testable. */
export interface LocalAuth {
  available(): Promise<boolean>;
  authenticate(): Promise<boolean>;
}

export interface SessionDeps {
  api: MobileApi;
  key: DeviceKey;
  vault: typeof vault;
  /** Milliseconds; defaults to `Date.now`. */
  now?: () => number;
  mockControls: MockControls | null;
  localAuth?: LocalAuth;
}

export interface SessionState {
  phase: Phase;
  hydrated: boolean;
  deviceId: string | null;
  deviceName: string | null;
  email: string | null;
  biometricsEnabled: boolean;
  lastBackgroundAt: number | null;
  pendingRoute: string | null;
  /** The enrolment request on screen — in memory only (its secret lives outside the state). */
  request: { id: string; code: string; expiresAt: string } | null;
  lockedUntil: string | null;
  attemptsLeft: number | null;
  error: string | null;
  busy: boolean;
  notice: string | null;
  mockControls: MockControls | null;
  /** The approval the PIN sheet is asking for: `decision` is the word the proof signs, and picks
   * the sheet's title ("Autorizar esta ação" / "Permitir sempre nesta aba"). */
  pinPrompt: { actionId: string; decision: PinDecision } | null;

  /** Routes an API error that ends or locks the session (chat and notification stores call it
   * too): `DEVICE_REVOKED` wipes, `DEVICE_LOCKED` locks with the countdown, `PIN_INVALID` shows
   * the attempts left. Returns false when the error is none of these (the caller handles it). */
  handleApiError(err: unknown): boolean;
  requestDevice(email: string): Promise<void>;
  cancelRequest(): void;
  createPin(pin: string, confirm: string): Promise<void>;
  unlock(pin: string): Promise<void>;
  unlockWithBiometrics(): Promise<void>;
  enableBiometrics(): Promise<boolean>;
  disableBiometrics(): Promise<void>;
  /** The client's renewer: single-flighted `challenge` + `token` with the in-memory secret. */
  renewToken(): Promise<string | null>;
  /** Throws `Error('LOCKED')` when there is no token in memory. */
  auth(): Auth;
  /** Opens the PIN sheet for an approval (P§5.6). `resolvePinPrompt` computes the proof and
   * awaits `perform(proof)` with the sheet still open: `PIN_INVALID` keeps it open with the error
   * and the attempts left; `DEVICE_LOCKED` relocks (rejects `CANCELLED`); success resolves; any
   * other error closes it and rejects with that error. A cancel rejects `CANCELLED`. The proof
   * signs `decision` (default `approve`): a proof for one decision is refused for the other. */
  requestPinProof(actionId: string, perform: (proof: { challenge: string; pin_proof: string }) => Promise<void>, decision?: PinDecision): Promise<void>;
  resolvePinPrompt(pin: string | 'biometrics'): Promise<void>;
  cancelPinPrompt(): void;
  /** The lock's countdown reached zero: clears `lockedUntil`, `error` and `attemptsLeft` so the
   * pad takes a PIN again. A no-op when not locked. */
  lockExpired(): void;
  background(): void;
  foreground(): void;
  /** A deep link caught while not `unlocked` (design spec §8); followed once unlocked. */
  setPendingRoute(route: string): void;
  clearPendingRoute(): void;
  leave(): Promise<void>;
  wipe(reason?: string): Promise<void>;
}
