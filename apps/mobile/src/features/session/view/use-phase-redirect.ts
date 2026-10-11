import { usePathname, useRouter, useSegments, type Href } from 'expo-router';
import { useEffect } from 'react';
import { useAccountStore } from '@/features/account/viewmodel/useAccountStore';
import { useLegalStore } from '@/features/legal/viewmodel/useLegalStore';
import { redirectFor } from '../model/redirect';
import { useSessionStore } from '../viewmodel/useSessionStore';

/**
 * Keeps the visible route in step with the session phase (design spec §8): each phase's screens
 * are reachable only while it is current, and once `unlocked` a stored `pendingRoute` is followed
 * — then cleared once the pathname shows it was reached (see `redirectFor`). A pending account
 * deletion (TER-720) holds an unlocked session on its blocking screen, and so does a Terms / Privacy
 * Policy version still to accept (TER-742) on the acceptance screen. The decision itself is
 * `redirectFor` (`../model/redirect.ts`); this hook only supplies the router and the store.
 */
export function usePhaseRedirect(): void {
  const router = useRouter();
  const segments = useSegments();
  const pathname = usePathname();
  const hydrated = useSessionStore((s) => s.hydrated);
  const phase = useSessionStore((s) => s.phase);
  const pendingRoute = useSessionStore((s) => s.pendingRoute);
  const clearPendingRoute = useSessionStore((s) => s.clearPendingRoute);
  const deletionPending = useAccountStore((s) => s.pending);
  const legalPending = useLegalStore((s) => s.pending.length > 0);

  useEffect(() => {
    if (!hydrated) return; // waiting for MMKV: redirecting before hydration would bounce a locked session to `new`.
    const { target, shouldClear } = redirectFor(phase, segments, pendingRoute, pathname, deletionPending, legalPending);
    if (target) router.replace(target as Href);
    if (shouldClear) clearPendingRoute();
  }, [hydrated, phase, pendingRoute, segments, pathname, router, clearPendingRoute, deletionPending, legalPending]);
}
