// The chat store's persistence adapter (spec §4.2 "Persistence"). zustand's `persist` calls
// `storage.setItem` after every `set`, and `createJSONStorage` serialises the whole persisted slice
// each time before the backing store even sees it — on a phone that was one JSON.stringify of the
// chat history per streamed token. This wrapper sits at the `PersistStorage` level instead: it keeps
// only the latest value per key and serialises it into the backing `StateStorage` (MMKV) at most once
// every `intervalMs`, or at once on `flush()` (the end of a run, the app going to the background).
//
// Latest-wins per key is also what makes a wipe safe: a write pending across `sessionEnded`'s reset
// lands as the reset (empty) state, never as the old one.
import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';

export const PERSIST_INTERVAL_MS = 2000;

export interface ThrottledStorage<S> extends PersistStorage<S> {
  /** Writes whatever is pending right now and cancels the scheduled write. */
  flush(): void;
}

export function createThrottledStorage<S>(backing: StateStorage, intervalMs = PERSIST_INTERVAL_MS): ThrottledStorage<S> {
  const pending = new Map<string, StorageValue<S>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWriteAt = -Infinity;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (): void => {
    clearTimer();
    if (pending.size === 0) return;
    for (const [name, value] of pending) backing.setItem(name, JSON.stringify(value));
    pending.clear();
    lastWriteAt = Date.now();
  };

  const parse = (raw: string | null): StorageValue<S> | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StorageValue<S>;
    } catch {
      return null;
    }
  };

  return {
    getItem(name) {
      const raw = backing.getItem(name);
      return raw instanceof Promise ? raw.then(parse) : parse(raw);
    },
    setItem(name, value) {
      pending.set(name, value);
      if (timer !== null) return;
      // The first write after a quiet spell lands on the next tick; a burst then coalesces into one
      // write per interval.
      const due = Math.max(0, lastWriteAt + intervalMs - Date.now());
      timer = setTimeout(flush, due);
    },
    removeItem(name) {
      pending.delete(name);
      if (pending.size === 0) clearTimer();
      backing.removeItem(name);
    },
    flush,
  };
}
