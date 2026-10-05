// One mock transport, one session store, one chat store, one notifications store, one settings
// store, one chat grants store, one chat-memory store, one progress store, one permissions store and one account store
// over it, for the `ui` project: a screen test mocks `useSessionStore`, `useChatStore`,
// `useNotificationsStore`, `useSettingsStore`, `useChatGrantsStore`, `useChatMemoryStore`,
// `useProgressStore`, `usePermissionsStore`, `useAccountStore`, `useSessionsStore` and `makeTabChatStore` with these
// (each `jest.mock` factory requires this module, and Jest's registry hands every store the same
// instance within a test file).
// `enrolStores()` leaves the session unlocked; run it once, in `beforeAll`.
import { createAccountStore } from '@/features/account/viewmodel/createAccountStore';
import type { PermissionsDeps } from '@/features/permissions/model/permissions.types';
import { createPermissionsStore } from '@/features/permissions/viewmodel/createPermissionsStore';
import { createPauseStore } from '@/features/automation/viewmodel/createPauseStore';
import { createChatGrantsStore } from '@/features/chat-grants/viewmodel/createChatGrantsStore';
import { createChatMemoryStore } from '@/features/chat/viewmodel/createChatMemoryStore';
import { createChatStore } from '@/features/chat/viewmodel/createChatStore';
import { createNotificationsStore } from '@/features/notifications/viewmodel/createNotificationsStore';
import { createProgressStore } from '@/features/progress/viewmodel/createProgressStore';
import { createSettingsStore } from '@/features/settings/viewmodel/createSettingsStore';
import { createSessionsStore } from '@/features/tab-chat/viewmodel/createSessionsStore';
import { createTabChatStore } from '@/features/tab-chat/viewmodel/createTabChatStore';
import { enrol, setupSession } from './enrolled-session';

const ctx = setupSession(Date.now());

const chat = createChatStore({ api: ctx.api, session: () => ctx.store.getState() });

/** Fake OS answers for the permissions store: a screen test overrides one with `mockResolvedValueOnce`. */
const permissionDeps: jest.Mocked<PermissionsDeps> = {
  platform: 'ios',
  notificationStatus: jest.fn(async () => 'undetermined' as const),
  requestNotifications: jest.fn(async () => 'granted' as const),
  trackingStatus: jest.fn(async () => 'undetermined' as const),
  requestTracking: jest.fn(async () => 'authorized' as const),
  setAdConsent: jest.fn(async (_granted: boolean) => undefined),
  openSystemSettings: jest.fn(async () => undefined),
};

export const stores = {
  ...ctx,
  chat,
  notifications: createNotificationsStore({
    api: ctx.api,
    session: () => ctx.store.getState(),
    events: { subscribe: (fn) => chat.getState().subscribeEvents(fn) },
    projectName: (projectId) => (projectId ? (chat.getState().projects.find((p) => p.id === projectId)?.name ?? null) : null),
  }),
  settings: createSettingsStore({ api: ctx.api, session: () => ctx.store.getState() }),
  chatGrants: createChatGrantsStore({ api: ctx.api, session: () => ctx.store.getState() }),
  chatMemory: createChatMemoryStore({ api: ctx.api, session: () => ctx.store.getState() }),
  pause: createPauseStore({ api: ctx.api, session: () => ctx.store.getState(), events: { subscribe: (fn) => chat.getState().subscribeEvents(fn) } }),
  progress: createProgressStore({ api: ctx.api, session: () => ctx.store.getState() }),
  permissions: createPermissionsStore(permissionDeps),
  permissionDeps,
  account: createAccountStore({ api: ctx.api, session: () => ctx.store.getState() }),
  sessions: createSessionsStore({ api: ctx.api, session: () => ctx.store.getState() }),
  /** A session screen's store (spec 2026-10-01 tab chat): a test mocks `makeTabChatStore` with this. */
  makeTabChat: (tabId: string) => createTabChatStore({ api: ctx.api, session: () => ctx.store.getState(), tabId }),
};

export async function enrolStores(): Promise<void> {
  jest.useFakeTimers();
  try {
    await enrol(ctx);
  } finally {
    jest.useRealTimers();
  }
}
