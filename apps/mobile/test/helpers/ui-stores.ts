// One mock transport, one session store, one chat store, one notifications store, one settings
// store and one chat grants store over it, for the `ui` project: a screen test mocks
// `useSessionStore`, `useChatStore`, `useNotificationsStore`, `useSettingsStore` and
// `useChatGrantsStore` with these (each `jest.mock` factory requires this module, and Jest's
// registry hands every store the same instance within a test file).
// `enrolStores()` leaves the session unlocked; run it once, in `beforeAll`.
import { createChatGrantsStore } from '@/features/chat-grants/viewmodel/createChatGrantsStore';
import { createChatStore } from '@/features/chat/viewmodel/createChatStore';
import { createNotificationsStore } from '@/features/notifications/viewmodel/createNotificationsStore';
import { createSettingsStore } from '@/features/settings/viewmodel/createSettingsStore';
import { enrol, setupSession } from './enrolled-session';

const ctx = setupSession(Date.now());

const chat = createChatStore({ api: ctx.api, session: () => ctx.store.getState() });

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
};

export async function enrolStores(): Promise<void> {
  jest.useFakeTimers();
  try {
    await enrol(ctx);
  } finally {
    jest.useRealTimers();
  }
}
