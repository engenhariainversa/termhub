// Feature flags (TER-1040, docs/feature-flags.md): what `GET me` says is on for this person. Read once
// per session (activation or unlock) and on demand; every flag is off until the server says otherwise,
// and again after the session ends, so a screen behind a flag never flashes before the answer.
// A factory over injected services, like the other feature stores; `useFeatureFlagsStore.ts` builds
// the app's one instance.
import { create } from 'zustand';
import { sessionEnded, sessionStarted } from '@/features/shared/signals';
import type { SessionState } from '@/features/session/model/session.types';
import type { TMeResponse } from '@/services/api/contract';
import type { MobileApi } from '@/services/api/types';

export type FeatureFlag = keyof TMeResponse['features'];
export type FeatureFlags = Record<FeatureFlag, boolean>;

export interface FeatureFlagsDeps {
  api: MobileApi;
  session: () => Pick<SessionState, 'auth' | 'handleApiError'>;
}

export interface FeatureFlagsState {
  flags: FeatureFlags;
  /** Re-reads `GET me`; single-flighted. A failure keeps what was known (off by default). */
  refresh(): Promise<void>;
}

export const FLAGS_OFF: FeatureFlags = { subscriptions: false };

export function createFeatureFlagsStore(deps: FeatureFlagsDeps) {
  const { api, session } = deps;
  let generation = 0;
  let refreshing: Promise<void> | null = null;

  const store = create<FeatureFlagsState>()((set) => ({
    flags: FLAGS_OFF,
    refresh() {
      refreshing ??= (async () => {
        const gen = generation;
        try {
          const me = await api.me(session().auth());
          if (gen === generation) set({ flags: { ...FLAGS_OFF, ...me.features } });
        } catch (e) {
          session().handleApiError(e);
        } finally {
          refreshing = null;
        }
      })();
      return refreshing;
    },
  }));

  sessionStarted.subscribe(() => void store.getState().refresh());
  sessionEnded.subscribe(() => {
    generation++;
    refreshing = null;
    store.setState({ flags: FLAGS_OFF });
  });

  return store;
}
