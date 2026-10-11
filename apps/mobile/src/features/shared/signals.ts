import { signal } from '@/services/signal';

export { signal };

/**
 * Fired when a session ends — "Sair e remover este aparelho" or a `DEVICE_REVOKED` response
 * (design spec §5.5). Every feature store that persists per-session data subscribes and resets
 * itself, so the next enrolled device never sees the previous session's data.
 */
export const sessionEnded = signal();

/**
 * Fired when the app leaves the foreground (`AppState` `background`/`inactive`, emitted by
 * `app/_layout.tsx`): a store that writes on a throttle flushes now, before the OS may suspend the
 * process. The view layer emits it because viewmodels never import `react-native`.
 */
export const appBackgrounded = signal();

/**
 * Fired when the app comes back to the foreground (`AppState` `active`, emitted by `app/_layout.tsx`).
 * The permissions store re-reads the OS statuses: notifications turned on in the system settings
 * register the push token at once (TER-921).
 */
export const appForegrounded = signal();

/**
 * Fired when a session starts — activation after "Criar PIN", or an unlock (permission prompts
 * spec §3.1). The permissions store re-reads the OS statuses and re-applies the ad consent.
 */
export const sessionStarted = signal();

/** Fired by the chat store after the server accepted a message (retries included). The permissions
 * store opens the notification primer on the first one. */
export const messageSent = signal();

/** Fired by the permissions store when the OS grants notifications: the session store registers
 * the push token at once instead of waiting for the next session. */
export const pushGranted = signal();
