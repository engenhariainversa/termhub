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
