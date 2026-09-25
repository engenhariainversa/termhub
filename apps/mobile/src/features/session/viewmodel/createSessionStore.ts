// The session store (design spec §5): enrolment, PIN and activation, unlock and silent renewal,
// relock, biometrics, leaving and revocation. A factory over injected services so tests drive it
// against the mock transport; `useSessionStore.ts` builds the app's one instance.
//
// Secrets never enter the zustand state: the access token, the unwrapped `pin_secret` and the
// enrolment `request_secret` live in this closure only, so neither `persist` nor a devtools dump
// can ever see them (spec §5.1).
//
// Every async action captures the session `generation` before its first `await` and drops its
// result when a relock or wipe bumped it meanwhile, so a late answer can never bring a token back
// behind the lock screen or revive a wiped session.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { sessionEnded } from '@/features/shared/signals';
import type { PinDecision } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { socketWake } from '@/services/api/wake';
import { b64url, fromB64url } from '@/services/crypto/encoding';
import { decisionProof, PIN_RE, pinProof } from '@/services/crypto/pin';
import { mmkvStateStorage, resetPersistedStores } from '@/services/storage';
import { readDeviceInfo } from '../model/device-info';
import { MSG } from '../model/messages';
import { readBiometricSecret, storeWrappedSecret, unwrapWithPin } from '../model/pin-vault';
import { persistablePhase, type SessionDeps, type SessionState } from '../model/session.types';

/** Relock after this long in the background (P§5.6). */
export const RELOCK_AFTER_MS = 5 * 60_000;

type Data = Omit<SessionState, { [K in keyof SessionState]: SessionState[K] extends (...args: never[]) => unknown ? K : never }[keyof SessionState]>;

const initialData = (mockControls: SessionDeps['mockControls']): Data => ({
  phase: 'new',
  hydrated: false,
  deviceId: null,
  deviceName: null,
  email: null,
  biometricsEnabled: false,
  lastBackgroundAt: null,
  pendingRoute: null,
  request: null,
  lockedUntil: null,
  attemptsLeft: null,
  error: null,
  busy: false,
  notice: null,
  mockControls,
  pinPrompt: null,
});

const isApiError = (e: unknown, code: string): e is ApiError => e instanceof ApiError && e.code === code;

type PinProof = { challenge: string; pin_proof: string };
type Prompt = { perform(proof: PinProof): Promise<void>; decision: PinDecision; resolve(): void; reject(e: unknown): void };

export function createSessionStore(deps: SessionDeps) {
  const { api, key, vault, mockControls } = deps;
  const now = deps.now ?? Date.now;

  // In memory only (spec §5.1).
  let accessToken: string | null = null;
  let pinSecret: Uint8Array | null = null;
  let requestSecret: string | null = null;

  let generation = 0;
  let wiping: Promise<void> = Promise.resolve();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let renewing: Promise<string | null> | null = null;
  let prompt: Prompt | null = null;

  const store = create<SessionState>()(
    persist(
      (set, get) => {
        // `set` for an early `return` from an action typed `Promise<void>` (zustand's `set` returns `unknown`).
        const patch = (partial: Partial<SessionState>): void => {
          set(partial);
        };

        const stopPolling = () => {
          if (pollTimer) clearTimeout(pollTimer);
          pollTimer = null;
        };

        const dropPrompt = () => {
          prompt?.reject(new Error('CANCELLED'));
          prompt = null;
          set({ pinPrompt: null });
        };

        /** Forgets every in-memory credential and invalidates the actions in flight. */
        const forgetSession = () => {
          generation++;
          accessToken = null;
          pinSecret = null;
          api.forgetTokens();
          dropPrompt();
        };

        /** `unlocked` → `locked` without touching the vault (spec §5.4). A wrong PIN typed in the
         * approval sheet must not follow the person to Desbloquear: `error` and `attemptsLeft` go too. */
        const relock = () => {
          forgetSession();
          set({ phase: 'locked', busy: false, error: null, attemptsLeft: null });
        };

        /** A new session (activation or unlock): the token, `unlocked`, a wake-up for a chat socket
         * that backed off while locked, and — in mock mode only, the fake token means nothing to a
         * real server — one push-token registration, fire-and-forget: it must never block the flow (P§9). */
        const startSession = (token: string, secret: Uint8Array) => {
          accessToken = token;
          pinSecret = secret;
          set({ phase: 'unlocked', lockedUntil: null, attemptsLeft: null, error: null, busy: false });
          socketWake.emit();
          if (api.mode === 'mock') {
            const deviceId = get().deviceId;
            api.setPushToken({ accessToken: token }, `ExponentPushToken[mock-${deviceId}]`).catch(() => undefined);
          }
        };

        /** The end of a failed action started at generation `gen`: ignored when a relock or wipe
         * superseded it; otherwise `handleApiError`, or the error's own (pt-BR) text. */
        const fail = async (gen: number, e: unknown): Promise<void> => {
          if (gen !== generation) return;
          if (get().handleApiError(e)) return wiping;
          set({ error: e instanceof ApiError ? e.message : MSG.network, busy: false });
        };

        /** `challenge` + `token` for a candidate secret, kept only once the server accepts it. */
        const redeem = async (gen: number, candidate: Uint8Array) => {
          const deviceId = get().deviceId!;
          const { challenge } = await api.challenge({ device_id: deviceId, purpose: 'refresh' });
          if (gen !== generation) return;
          const res = await api.token({ device_id: deviceId, challenge, pin_proof: pinProof(candidate, challenge) });
          if (gen !== generation) return;
          startSession(res.access_token, candidate);
        };

        const schedulePoll = (id: string, after: number) => {
          pollTimer = setTimeout(async () => {
            pollTimer = null;
            if (get().request?.id !== id || !requestSecret) return;
            let status: 'pending' | 'approved' | 'closed' = 'pending';
            try {
              status = (await api.pollRequest(id, requestSecret)).status;
            } catch {
              // a transient failure: keep polling, the server's `closed` ends it eventually
            }
            if (get().request?.id !== id) return; // cancelled while in flight
            if (status === 'approved') set({ phase: 'pin_setup' });
            else if (status === 'closed') {
              requestSecret = null;
              set({ phase: 'new', request: null, notice: MSG.closed });
            } else schedulePoll(id, after);
          }, after);
        };

        return {
          ...initialData(mockControls),

          handleApiError(e) {
            if (isApiError(e, 'DEVICE_REVOKED')) {
              void get().wipe(MSG.revoked);
              return true;
            }
            if (isApiError(e, 'DEVICE_LOCKED')) {
              relock();
              set({ lockedUntil: new Date(now() + (e.retryAfter ?? 0) * 1000).toISOString(), attemptsLeft: null, error: MSG.locked });
              return true;
            }
            if (isApiError(e, 'PIN_INVALID')) {
              set({ error: MSG.pinInvalid, attemptsLeft: e.attemptsLeft ?? null, busy: false });
              return true;
            }
            return false;
          },

          async requestDevice(email) {
            stopPolling();
            const gen = generation;
            set({ busy: true, error: null, notice: null });
            try {
              const publicKey = await key.create();
              const info = readDeviceInfo();
              const res = await api.requestDevice({ email, public_key: publicKey, ...info });
              if (gen !== generation) return;
              requestSecret = res.request_secret;
              set({
                phase: 'waiting',
                request: { id: res.request_id, code: res.verification_code, expiresAt: res.expires_at },
                email: email.trim().toLowerCase(),
                deviceName: info.device.name,
                busy: false,
              });
              schedulePoll(res.request_id, res.poll_after);
            } catch (e) {
              await fail(gen, e);
            }
          },

          cancelRequest() {
            stopPolling();
            requestSecret = null;
            set({ phase: 'new', request: null, busy: false, error: null });
          },

          async createPin(pin, confirm) {
            if (get().busy) return;
            if (!PIN_RE.test(pin)) return patch({ error: MSG.pinFormat });
            if (pin !== confirm) return patch({ error: MSG.pinMismatch });
            const request = get().request;
            if (get().phase !== 'pin_setup' || !request || !requestSecret) return;
            const gen = generation;
            set({ busy: true, error: null });
            let res;
            try {
              res = await api.activate({ request_id: request.id, request_secret: requestSecret });
            } catch (e) {
              if (gen === generation && isApiError(e, 'REQUEST_INVALID')) {
                requestSecret = null;
                return patch({ phase: 'new', request: null, busy: false, notice: MSG.closed });
              }
              return fail(gen, e);
            }
            if (gen !== generation) return;
            const secret = fromB64url(res.pin_secret);
            try {
              await storeWrappedSecret(vault, pin, secret, res.device_id);
            } catch {
              // The device now exists on the server with no usable local secret: remove it and
              // start over rather than leave a half-enrolled phone behind.
              await api.revokeSelf({ accessToken: res.access_token }).catch(() => undefined);
              return get().wipe(MSG.storeFailed);
            }
            if (gen !== generation) return;
            requestSecret = null;
            set({ deviceId: res.device_id, request: null });
            startSession(res.access_token, secret);
          },

          async unlock(pin) {
            if (get().busy) return;
            if (!PIN_RE.test(pin)) return patch({ error: MSG.pinFormat });
            const gen = generation;
            set({ busy: true, error: null });
            try {
              const candidate = await unwrapWithPin(vault, pin, get().deviceId);
              if (gen !== generation) return;
              // The vault lost an item, or holds another device's: a half session only a wipe ends.
              if (!candidate) return get().wipe(MSG.dataLost);
              await redeem(gen, candidate);
            } catch (e) {
              await fail(gen, e);
            }
          },

          async unlockWithBiometrics() {
            if (get().busy) return;
            const gen = generation;
            set({ busy: true, error: null });
            const secret = await readBiometricSecret(vault);
            if (gen !== generation) return;
            if (!secret) return patch({ busy: false, error: MSG.usePin });
            try {
              await redeem(gen, secret);
            } catch (e) {
              if (isApiError(e, 'DEVICE_REVOKED') || isApiError(e, 'DEVICE_LOCKED')) return fail(gen, e);
              if (gen === generation) set({ busy: false, error: MSG.usePin });
            }
          },

          async enableBiometrics() {
            const secret = pinSecret;
            if (!secret || !deps.localAuth) return false;
            try {
              if (!(await deps.localAuth.available()) || !(await deps.localAuth.authenticate())) {
                set({ error: MSG.biometricsOff });
                return false;
              }
              await vault.set('pin.biometric', b64url(secret), { biometric: true });
              set({ biometricsEnabled: true, error: null });
              return true;
            } catch {
              set({ error: MSG.biometricsOff });
              return false;
            }
          },

          async disableBiometrics() {
            await vault.delete('pin.biometric').catch(() => undefined);
            set({ biometricsEnabled: false });
          },

          renewToken() {
            if (renewing) return renewing;
            const secret = pinSecret;
            const deviceId = get().deviceId;
            if (!secret || !deviceId) {
              if (get().phase === 'unlocked') relock();
              return Promise.resolve(null);
            }
            const gen = generation;
            renewing = (async () => {
              try {
                const { challenge } = await api.challenge({ device_id: deviceId, purpose: 'refresh' });
                if (gen !== generation) return null;
                const res = await api.token({ device_id: deviceId, challenge, pin_proof: pinProof(secret, challenge) });
                if (gen !== generation) return null;
                accessToken = res.access_token;
                return accessToken;
              } catch (e) {
                // Silent: only the session-ending answers surface (a wrong proof means the secret
                // in memory is no good any more — ask for the PIN).
                if (gen === generation) {
                  if (isApiError(e, 'PIN_INVALID')) relock();
                  else if (get().handleApiError(e)) await wiping;
                }
                return null;
              } finally {
                renewing = null;
              }
            })();
            return renewing;
          },

          auth() {
            if (!accessToken) throw new Error('LOCKED');
            return { accessToken };
          },

          requestPinProof(actionId, perform, decision = 'approve') {
            dropPrompt();
            return new Promise<void>((resolve, reject) => {
              prompt = { perform, decision, resolve, reject };
              set({ pinPrompt: { actionId, decision }, error: null, attemptsLeft: null });
            });
          },

          async resolvePinPrompt(pin) {
            if (get().busy) return;
            const waiting = prompt;
            const actionId = get().pinPrompt?.actionId;
            if (!waiting || !actionId) return;
            if (pin !== 'biometrics' && !PIN_RE.test(pin)) return patch({ error: MSG.pinFormat });
            const gen = generation;
            // A newer `requestPinProof` replaced this prompt: this answer belongs to no one.
            const superseded = () => gen !== generation || prompt !== waiting;
            set({ busy: true, error: null });
            let proof: PinProof;
            try {
              const secret = pin === 'biometrics' ? await readBiometricSecret(vault) : await unwrapWithPin(vault, pin, get().deviceId);
              if (superseded()) return patch({ busy: false });
              if (!secret) return patch({ busy: false, error: MSG.usePin });
              const { challenge } = await api.challenge({ device_id: get().deviceId!, purpose: 'decision', action_id: actionId });
              if (superseded()) return patch({ busy: false });
              proof = { challenge, pin_proof: decisionProof(secret, challenge, actionId, waiting.decision) };
            } catch (e) {
              return fail(gen, e);
            }
            // The server checks the proof while the sheet stays open and busy: a wrong PIN is
            // answered inside it, and only an outcome that ends the prompt closes it.
            try {
              await waiting.perform(proof);
            } catch (e) {
              if (superseded()) return patch({ busy: false });
              if (isApiError(e, 'PIN_INVALID')) {
                get().handleApiError(e); // error + attempts left, the prompt stays for another try
                return;
              }
              if (get().handleApiError(e)) return wiping; // 423 relocked / revoked wiped: prompt dropped
              prompt = null;
              set({ pinPrompt: null, busy: false });
              waiting.reject(e); // the caller surfaces its own errors
              return;
            }
            if (superseded()) return patch({ busy: false });
            prompt = null;
            set({ pinPrompt: null, busy: false, error: null, attemptsLeft: null });
            waiting.resolve();
          },

          lockExpired() {
            if (!get().lockedUntil) return;
            set({ lockedUntil: null, error: null, attemptsLeft: null });
          },

          cancelPinPrompt() {
            dropPrompt();
          },

          background() {
            set({ lastBackgroundAt: now() });
          },

          foreground() {
            const since = get().lastBackgroundAt;
            set({ lastBackgroundAt: null });
            if (get().phase === 'unlocked' && since !== null && now() - since >= RELOCK_AFTER_MS) relock();
          },

          setPendingRoute(route) {
            patch({ pendingRoute: route });
          },

          clearPendingRoute() {
            patch({ pendingRoute: null });
          },

          async leave() {
            set({ busy: true });
            if (accessToken) await api.revokeSelf({ accessToken }).catch(() => undefined);
            await get().wipe();
          },

          wipe(reason) {
            stopPolling();
            forgetSession();
            requestSecret = null;
            wiping = (async () => {
              await vault.clear().catch(() => undefined);
              await key.destroy().catch(() => undefined);
              resetPersistedStores();
              sessionEnded.emit();
              set({ ...initialData(mockControls), hydrated: true, notice: reason ?? null });
            })();
            return wiping;
          },
        };
      },
      {
        name: 'session',
        storage: createJSONStorage(() => mmkvStateStorage),
        partialize: (s) => ({
          phase: persistablePhase(s.phase),
          deviceId: s.deviceId,
          deviceName: s.deviceName,
          email: s.email,
          biometricsEnabled: s.biometricsEnabled,
          lastBackgroundAt: s.lastBackgroundAt,
        }),
      },
    ),
  );

  const markHydrated = () => store.setState({ hydrated: true });
  store.persist.onFinishHydration(markHydrated);
  if (store.persist.hasHydrated()) markHydrated();
  return store;
}
