// The notifications store (design spec §7): the account's notification history, its unread
// count, and the live tap into the chat store's socket for a `confirmation` (ruling: the chat
// store owns the only socket; this store never opens one of its own). A factory over injected
// services, same shape as the session and chat stores, so tests drive it against the mock
// transport; `useNotificationsStore.ts` builds the app's one instance.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { appForegrounded, sessionEnded, sessionStarted } from '@/features/shared/signals';
import type { TChatEvent, TNotificationRow } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';
import { mmkvStateStorage } from '@/services/storage';
import { NOTIF_MSG } from '../model/messages';
import { isLocalRowId, syntheticConfirmationRow } from '../model/synthetic-row';

/** What this store needs from the session store: `auth()` for every call, `handleApiError` for
 * the session-ending answers (`DEVICE_REVOKED`, `DEVICE_LOCKED`) — the same contract the chat
 * store's `SessionApi` uses. */
export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface NotificationsDeps {
  api: MobileApi;
  session: () => SessionApi;
  /** The chat store's `subscribeEvents` (or a fake in tests): every raw event of the app's one
   * socket, ahead of any conversation filter. */
  events: { subscribe(fn: (e: TChatEvent) => void): () => void };
  /** The chat store's cached project name for a `confirmation`'s `project_id`, when already
   * known — omitted (or returning `null`) falls back to the generic body (`synthetic-row.ts`). */
  projectName?: (projectId: string | null) => string | null;
  now?: () => number;
  /** The OS side (TER-923): the icon badge and the notification center. Omitted in tests that do not
   * look at it. */
  os?: { setBadge(count: number): Promise<void>; dismissDelivered(read: ReadonlySet<string> | 'all'): Promise<void> };
  /** Reload the history on every session start and every return to the foreground (the app's one
   * instance does; tests that do not look at it leave it off, so no store reloads behind another). */
  refreshOnForeground?: boolean;
}

export interface NotificationsState {
  items: TNotificationRow[];
  unread: number;
  loading: boolean;
  loadingMore: boolean;
  nextBefore: string | null;
  error: string | null;

  /** Page 1, newest first, replacing `items` — including any synthetic row a live event
   * prepended, which is why this is also how a placeholder gets replaced by the server's own
   * row. */
  load(): Promise<void>;
  /** The next page, appended; a no-op with no `nextBefore` or while already loading one. */
  loadMore(): Promise<void>;
  /** Marks one row read on the server, then locally — `unread` never drops below 0. Never
   * throws: a failure ends up in `error` (or the session store, for a session-ending one). */
  markRead(id: string): Promise<void>;
  /** The row a tapped push names (`data.notification_id`), read on the server even when this list
   * does not hold it yet — the push usually arrived while the app was closed — then page 1 again,
   * so the row and `unread` come back as the server now has them. Never throws, like `markRead`. */
  markPushRead(id: string): Promise<void>;
}

type Data = Omit<NotificationsState, { [K in keyof NotificationsState]: NotificationsState[K] extends (...args: never[]) => unknown ? K : never }[keyof NotificationsState]>;

const initialData = (): Data => ({ items: [], unread: 0, loading: false, loadingMore: false, nextBefore: null, error: null });

export function createNotificationsStore(deps: NotificationsDeps) {
  const { api, session, events } = deps;
  const now = deps.now ?? Date.now;
  const projectName = deps.projectName ?? (() => null);

  let generation = 0;

  const store = create<NotificationsState>()(
    persist(
      (set, get) => {
        const fail = (gen: number, e: unknown): void => {
          if (gen !== generation) return;
          if (session().handleApiError(e)) return;
          set({ error: e instanceof ApiError ? e.message : NOTIF_MSG.network, loading: false, loadingMore: false });
        };

        return {
          ...initialData(),

          async load() {
            const gen = generation;
            set({ loading: true, error: null });
            try {
              const res = await api.notifications(session().auth());
              if (gen !== generation) return;
              set({ items: res.notifications, unread: res.unread, nextBefore: res.next_before, loading: false });
            } catch (e) {
              fail(gen, e);
            }
          },

          async loadMore() {
            const before = get().nextBefore;
            if (before === null || get().loadingMore) return;
            const gen = generation;
            set({ loadingMore: true, error: null });
            try {
              const res = await api.notifications(session().auth(), before);
              if (gen !== generation) return;
              set((s) => ({ items: [...s.items, ...res.notifications], unread: res.unread, nextBefore: res.next_before, loadingMore: false }));
            } catch (e) {
              fail(gen, e);
            }
          },

          async markRead(id) {
            const row = get().items.find((r) => r.id === id);
            if (!row || row.read_at !== null) return;
            // A synthetic `local:` row exists only here: the server has no such id to mark.
            if (!isLocalRowId(id)) {
              try {
                await api.markRead(session().auth(), id);
              } catch (e) {
                return fail(generation, e);
              }
            }
            set((s) => ({
              items: s.items.map((r) => (r.id === id ? { ...r, read_at: new Date(now()).toISOString() } : r)),
              unread: Math.max(0, s.unread - 1),
            }));
          },

          async markPushRead(id) {
            if (get().items.some((r) => r.id === id)) return get().markRead(id);
            const gen = generation;
            try {
              await api.markRead(session().auth(), id);
            } catch (e) {
              return fail(gen, e);
            }
            if (gen !== generation) return;
            await get().load();
          },
        };
      },
      {
        name: 'notifications',
        storage: createJSONStorage(() => mmkvStateStorage),
        partialize: (s) => ({ items: s.items, unread: s.unread }),
      },
    ),
  );

  // Ruling: a live `confirmation` prepends a synthetic unread row, deduped by `data.action_id`
  // (against a synthetic row already there, or a server row a prior `load()` already fetched) —
  // it never doubles the unread count for the same action.
  events.subscribe((e) => {
    if (e.type !== 'confirmation') return;
    const state = store.getState();
    if (state.items.some((r) => (r.data as { action_id?: unknown } | null)?.action_id === e.action_id)) return;
    const row = syntheticConfirmationRow(e, projectName(e.project_id), now());
    store.setState({ items: [row, ...state.items], unread: state.unread + 1 });
  });

  // The icon and the notification center follow the history (TER-923): the badge is `unread`, and a
  // delivered push whose row is now read (tapped, read here, or its card handled anywhere) goes away.
  const os = deps.os;
  if (os) {
    store.subscribe((s, prev) => {
      if (s.unread !== prev.unread) void os.setBadge(s.unread);
      if (s.items !== prev.items) void os.dismissDelivered(new Set(s.items.filter((r) => r.read_at !== null && !isLocalRowId(r.id)).map((r) => r.id)));
    });
  }

  // Back in the app, or a new session: the server's history may have moved (a card handled on the web).
  // Locked (`auth()` throws): the unlock's `sessionStarted` loads it.
  const refresh = () => {
    try {
      session().auth();
    } catch {
      return;
    }
    void store.getState().load();
  };
  if (deps.refreshOnForeground) {
    appForegrounded.subscribe(refresh);
    sessionStarted.subscribe(refresh);
  }

  // Design spec §5.5: the end of a session resets every store that persists per-session data.
  sessionEnded.subscribe(() => {
    generation++;
    store.setState(initialData());
    if (os) void os.dismissDelivered('all').then(() => os.setBadge(0));
  });

  return store;
}
