import type { TPullRequestBadge } from '@/services/api/contract';
import { prGroups, repoOfPrUrl } from './pr-groups';

const pr = (url: string, number: number): TPullRequestBadge => ({
  number,
  url,
  title: `PR ${number}`,
  state: 'open',
  draft: false,
  ci_state: 'passed',
  ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] },
  deploy_state: 'none',
  deploy_url: null,
});

describe('PRs grouped by repository (TER-1061)', () => {
  it('reads owner/repo from a PR URL', () => {
    expect(repoOfPrUrl('https://github.com/acme/api/pull/12')).toBe('acme/api');
    expect(repoOfPrUrl('https://github.com/acme/api/pull/12/files')).toBe('acme/api');
    expect(repoOfPrUrl('not a url')).toBeNull();
  });

  it('a single-repo card keeps one unnamed group, in its order', () => {
    const prs = [pr('https://github.com/acme/app/pull/2', 2), pr('https://github.com/acme/app/pull/1', 1)];
    expect(prGroups({ repo_keys: [], pull_requests: prs })).toEqual([{ repo: null, pull_requests: prs }]);
    expect(prGroups({ repo_keys: [], pull_requests: [] })).toEqual([]);
  });

  it('groups the PRs of several repositories, each named, in first-seen order', () => {
    const a1 = pr('https://github.com/acme/api/pull/5', 5);
    const w = pr('https://github.com/acme/web/pull/9', 9);
    const a2 = pr('https://github.com/acme/api/pull/6', 6);
    expect(prGroups({ repo_keys: [], pull_requests: [a1, w, a2] })).toEqual([
      { repo: 'acme/api', pull_requests: [a1, a2] },
      { repo: 'acme/web', pull_requests: [w] },
    ]);
  });

  it('names the repository of a multi-repo card even with a single PR', () => {
    const a = pr('https://github.com/acme/api/pull/5', 5);
    expect(prGroups({ repo_keys: ['api', 'web'], pull_requests: [a] })).toEqual([{ repo: 'acme/api', pull_requests: [a] }]);
  });
});
