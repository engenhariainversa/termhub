import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PullRequestBadge } from '../lib/types';
import { PullRequestBadges } from './ProgressPanel';
import { useTranslation } from '../i18n';

/** The card's pull requests with CI and deploy (spec 2026-09-26 progress-panel §5.6); nothing when it has none. */
export function CardPullRequests({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const [pulls, setPulls] = useState<PullRequestBadge[]>([]);
  useEffect(() => {
    let alive = true;
    // Wrapped in an async IIFE so a synchronous throw from api.tasks.pullRequests
    // (not just a rejected promise) is also caught: either way the card renders nothing.
    (async () => {
      try {
        const r = await api.tasks.pullRequests(taskId);
        if (alive) setPulls(r.pull_requests);
      } catch {
        // no PRs to show
      }
    })();
    return () => {
      alive = false;
    };
  }, [taskId]);
  if (pulls.length === 0) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium uppercase text-zinc-500">{t('Pull requests')}</h3>
      <PullRequestBadges pulls={pulls} />
    </div>
  );
}
