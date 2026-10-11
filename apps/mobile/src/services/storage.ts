import { MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

export const mmkv = new MMKV({ id: 'termhub' });

export const mmkvStateStorage: StateStorage = {
  getItem: (name) => mmkv.getString(name) ?? null,
  setItem: (name, value) => {
    mmkv.set(name, value);
  },
  removeItem: (name) => {
    mmkv.delete(name);
  },
};

/** The device's language choice (`src/i18n`): a setting of the phone, not of the account. */
const KEPT_ON_WIPE = ['locale'];

/**
 * Clears every persisted zustand store (design spec §5.5: `wipe()` on "Sair e remover este
 * aparelho" or a `DEVICE_REVOKED` response resets every store that persists to MMKV). The language
 * choice survives: whoever enrols next on this phone still reads the language picked for it.
 */
export function resetPersistedStores(): void {
  const kept = KEPT_ON_WIPE.map((key) => [key, mmkv.getString(key)] as const);
  mmkv.clearAll();
  for (const [key, value] of kept) if (value !== undefined) mmkv.set(key, value);
}
