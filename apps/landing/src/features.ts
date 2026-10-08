import { useEffect, useState } from 'react';

/**
 * Feature flags the landing reads (TER-1040, docs/feature-flags.md): the instance values from
 * `GET /api/public/features` (nginx forwards termhub.dev/api/public/ to the app). The landing has no
 * session, so a per-person override never applies here: plans and prices show only once an admin
 * turns the flag on for everyone.
 */
export type FeatureFlag = 'subscriptions';

let cached: Promise<Partial<Record<FeatureFlag, boolean>>> | null = null;

function loadFeatures(): Promise<Partial<Record<FeatureFlag, boolean>>> {
  cached ??= fetch('/api/public/features', { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : { features: {} }))
    .then((body: { features?: Partial<Record<FeatureFlag, boolean>> }) => body.features ?? {})
    // offline, or an app older than the flags: everything stays off
    .catch(() => ({}));
  return cached;
}

/** Whether `flag` is on for the instance; off until the answer comes, and when it never does. */
export function useFeatureFlag(flag: FeatureFlag): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadFeatures().then((features) => alive && setOn(features[flag] === true));
    return () => {
      alive = false;
    };
  }, [flag]);
  return on;
}
