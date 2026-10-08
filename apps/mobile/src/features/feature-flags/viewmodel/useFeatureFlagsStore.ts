// The app's one feature-flags store, over the real API singleton and the session store, and the hook
// a screen behind a flag reads (TER-1040): `if (!useFeatureFlag('subscriptions')) return null`.
import { api } from '@/services/api';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { createFeatureFlagsStore, type FeatureFlag } from './createFeatureFlagsStore';

export const useFeatureFlagsStore = createFeatureFlagsStore({ api, session: () => useSessionStore.getState() });

/** Whether `flag` is on for the signed-in person; off until the server says otherwise. */
export function useFeatureFlag(flag: FeatureFlag): boolean {
  return useFeatureFlagsStore((s) => s.flags[flag]);
}
