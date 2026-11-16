// TER-1061 (spec 2026-10-07 multi-repo): a card's PRs grouped by repository on Progresso. A single-repo
// card (no `repo_keys`, every PR in one repository) gets one unnamed group, so it renders as before.
import type { TCardProgress, TPullRequestBadge } from '@/services/api/contract';

export interface PrGroup {
  /** `owner/repo` heading the group; null = not named (a single-repo card) */
  repo: string | null;
  pull_requests: TPullRequestBadge[];
}

/** `owner/repo` of a GitHub PR URL (`https://github.com/owner/repo/pull/12`); null when it does not read as one. */
export function repoOfPrUrl(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The card's PRs by repository, in the order each repository first appears. */
export function prGroups(card: Pick<TCardProgress, 'pull_requests' | 'repo_keys'>): PrGroup[] {
  const order: string[] = [];
  const byRepo = new Map<string, TPullRequestBadge[]>();
  for (const p of card.pull_requests) {
    const repo = repoOfPrUrl(p.url) ?? '';
    if (!byRepo.has(repo)) {
      byRepo.set(repo, []);
      order.push(repo);
    }
    byRepo.get(repo)!.push(p);
  }
  const named = card.repo_keys.length > 0 || order.length > 1;
  if (!named) return card.pull_requests.length > 0 ? [{ repo: null, pull_requests: card.pull_requests }] : [];
  return order.map((repo) => ({ repo: repo || null, pull_requests: byRepo.get(repo)! }));
}
