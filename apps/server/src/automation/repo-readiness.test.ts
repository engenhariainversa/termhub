import { describe, expect, it } from 'vitest';
import type { EffectiveRepo } from '../setup/repos.js';
import { cardRepoBlock } from './repo-readiness.js';

const repo = (key: string, over: Partial<EffectiveRepo> = {}): EffectiveRepo => ({
  full_name: `acme/${key}`,
  key,
  discovered: true,
  has_override: false,
  status: 'ok',
  enabled: true,
  integration_id: 'int-1',
  description: null,
  base_branch: 'main',
  branch_pattern: '{ticket}-{slug}',
  draft_pr: true,
  deploy_workflow: null,
  autonomy: 'pr',
  required_checks: [],
  release_workflows: [],
  release_paths: [],
  store_paths: [],
  merge_order: 0,
  checkouts: [{ machine_id: 'm1', dir: key, default_branch: 'main', has_commits: true, seen_at: '2026-11-16T00:00:00.000Z', missing_at: null }],
  ...over,
});

const linked = new Set(['m1']);
const repos = [repo('api'), repo('web')];

describe('cardRepoBlock (TER-1068, multi-repo §9)', () => {
  it('a card that names no repository is repo_unknown', () => {
    expect(cardRepoBlock([], repos, linked, true)).toEqual({ reason: 'repo_unknown' });
  });

  it('a card with several repositories waits for workspace runs', () => {
    expect(cardRepoBlock(['api', 'web'], repos, linked, true)).toEqual({ reason: 'repo_multi_soon' });
  });

  it('a key gone from the project or turned off in Setup is repo_disabled', () => {
    expect(cardRepoBlock(['gone'], repos, linked, true)).toEqual({ reason: 'repo_disabled', repo: 'gone' });
    expect(cardRepoBlock(['api'], [repo('api', { enabled: false }), repo('web')], linked, true)).toEqual({ reason: 'repo_disabled', repo: 'api' });
  });

  it('a repository the integration cannot read, or not on GitHub, is repo_no_access', () => {
    expect(cardRepoBlock(['api'], [repo('api', { status: 'no_access' })], linked, true)).toEqual({ reason: 'repo_no_access', repo: 'api' });
    expect(cardRepoBlock(['api'], [repo('api', { status: 'unsupported' })], linked, true)).toEqual({ reason: 'repo_no_access', repo: 'api' });
  });

  it('a repository with no GitHub integration keeps the repo_missing meaning', () => {
    expect(cardRepoBlock(['api'], [repo('api', { integration_id: null })], linked, true)).toEqual({ reason: 'repo_missing', repo: 'api' });
  });

  it('no machine that scans for repositories is agent_no_repo_scan', () => {
    expect(cardRepoBlock(['api'], repos, linked, false)).toEqual({ reason: 'agent_no_repo_scan' });
  });

  it('a repository with no present checkout on a linked machine is repo_not_on_machine', () => {
    const missing = repo('api', { checkouts: [{ ...repo('api').checkouts[0]!, missing_at: '2026-11-16T01:00:00.000Z' }] });
    expect(cardRepoBlock(['api'], [missing], linked, true)).toEqual({ reason: 'repo_not_on_machine', repo: 'api' });
    expect(cardRepoBlock(['api'], repos, new Set(['m2']), true)).toEqual({ reason: 'repo_not_on_machine', repo: 'api' });
  });

  it('a single ready repository is no block', () => {
    expect(cardRepoBlock(['web'], repos, linked, true)).toBeNull();
  });
});
