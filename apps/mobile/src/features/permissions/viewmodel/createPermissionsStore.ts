// The permission prompts (permission prompts spec §3.2): the notification primer after the first
// accepted message, and the ad measurement consent (ATT on iOS). A factory over injected OS and
// Firebase services, so the logic project drives it with fakes; `usePermissionsStore.ts` builds
// the app's one instance.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { appForegrounded, messageSent, pushGranted, sessionEnded, sessionStarted } from '@/features/shared/signals';
import { mmkvStateStorage } from '@/services/storage';
import type { AdConsent, PermissionsDeps, PermissionsState } from '../model/permissions.types';

/** "Agora não" twice and the primer is gone for good; Ajustes keeps the way in. */
export const MAX_PUSH_PRIMER_DISMISSALS = 2;

const initialData = {
  firstMessageSent: false,
  pushPrimerDismissals: 0,
  adConsent: 'unknown' as AdConsent,
  pushPrimerOpen: false,
  notificationStatus: null,
  trackingStatus: null,
};

/** The Home card: consent not decided yet and a status that still lets us ask (Android has no
 * ATT; iOS asks while undetermined, and an authorized ATT only needs our own yes). */
export function showAdCard(s: Pick<PermissionsState, 'adConsent' | 'trackingStatus'>): boolean {
  if (s.adConsent !== 'unknown') return false;
  return s.trackingStatus === 'unavailable' || s.trackingStatus === 'undetermined' || s.trackingStatus === 'authorized';
}

/** A native call that may fail (missing module, OS error): the fallback instead of a throw. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export function createPermissionsStore(deps: PermissionsDeps) {
  const store = create<PermissionsState>()(
    persist(
      (set, get) => ({
        ...initialData,
        platform: deps.platform,

        async refreshStatuses() {
          const [notificationStatus, trackingStatus] = await Promise.all([safe(deps.notificationStatus, null), safe(deps.trackingStatus, null)]);
          const before = get().notificationStatus;
          if (notificationStatus) set({ notificationStatus });
          // Turned on outside the app (the system settings): register the token now, not at the next
          // unlock (TER-921). Only a change we saw: a first read at launch is the session start's job.
          if (notificationStatus === 'granted' && before !== null && before !== 'granted') pushGranted.emit();
          if (trackingStatus) set({ trackingStatus });
        },

        async maybeOpenPushPrimer() {
          if (get().pushPrimerOpen || get().pushPrimerDismissals >= MAX_PUSH_PRIMER_DISMISSALS) return;
          const status = await safe(deps.notificationStatus, null);
          if (status) set({ notificationStatus: status });
          if (status === 'undetermined') set({ pushPrimerOpen: true });
        },

        async acceptPush() {
          set({ pushPrimerOpen: false });
          const status = await safe(deps.requestNotifications, null);
          if (status) set({ notificationStatus: status });
          if (status === 'granted') pushGranted.emit();
        },

        dismissPush() {
          set((s) => ({ pushPrimerOpen: false, pushPrimerDismissals: s.pushPrimerDismissals + 1 }));
        },

        async acceptAds() {
          let granted = true;
          if (deps.platform === 'ios') {
            const status = await safe(deps.requestTracking, null);
            if (status) set({ trackingStatus: status });
            granted = status === 'authorized';
          }
          set({ adConsent: granted ? 'granted' : 'denied' });
          await safe(() => deps.setAdConsent(granted), undefined);
        },

        async declineAds() {
          set({ adConsent: 'denied' });
          await safe(() => deps.setAdConsent(false), undefined);
        },

        async setAdsFromSettings(on) {
          if (!on) return get().declineAds();
          if (deps.platform === 'android') return get().acceptAds();
          const status = await safe(deps.trackingStatus, null);
          if (status) set({ trackingStatus: status });
          if (status === 'undetermined' || status === 'authorized') return get().acceptAds();
          // iOS never shows the ATT prompt twice: the system settings are the only way back.
          if (status) await safe(deps.openSystemSettings, undefined);
        },

        async syncAdConsent() {
          await get().refreshStatuses();
          const { adConsent, trackingStatus } = get();
          if (deps.platform === 'ios' && adConsent === 'granted' && trackingStatus !== null && trackingStatus !== 'authorized') set({ adConsent: 'denied' });
          await safe(() => deps.setAdConsent(get().adConsent === 'granted'), undefined);
        },

        async openSystemSettings() {
          await safe(deps.openSystemSettings, undefined);
        },
      }),
      {
        name: 'permissions',
        storage: createJSONStorage(() => mmkvStateStorage),
        partialize: (s) => ({ firstMessageSent: s.firstMessageSent, pushPrimerDismissals: s.pushPrimerDismissals, adConsent: s.adConsent }),
      },
    ),
  );

  sessionStarted.subscribe(() => {
    void store.getState().syncAdConsent();
  });
  appForegrounded.subscribe(() => {
    void store.getState().refreshStatuses();
  });
  messageSent.subscribe(() => {
    if (store.getState().firstMessageSent) return;
    store.setState({ firstMessageSent: true });
    void store.getState().maybeOpenPushPrimer();
  });
  sessionEnded.subscribe(() => {
    store.setState({ ...initialData });
    void safe(() => deps.setAdConsent(false), undefined); // denied until the next person accepts
  });

  return store;
}
