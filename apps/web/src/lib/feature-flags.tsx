import type { ReactNode } from 'react';
import { useAuth } from './auth';
import type { FeatureFlagKey } from './types';

/**
 * Whether a feature flag is on for the signed-in person (TER-1040, docs/feature-flags.md). The server
 * resolves it (their own override, else the instance value) and sends it on `/auth/me`; signed out,
 * or on a server that does not send flags yet, every flag is off.
 */
export function useFeatureFlag(flag: FeatureFlagKey): boolean {
  const { user } = useAuth();
  return user?.features?.[flag] === true;
}

/** Renders `children` only while `flag` is on: plans, checkout, paywall and trial notices sit inside one. */
export function FeatureGate({ flag, children, fallback = null }: { flag: FeatureFlagKey; children: ReactNode; fallback?: ReactNode }) {
  return <>{useFeatureFlag(flag) ? children : fallback}</>;
}
