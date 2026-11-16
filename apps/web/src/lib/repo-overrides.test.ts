import { describe, expect, it } from 'vitest';
import { dropOverride, levelsUpTo, overrideFor, setOverride, showRepoTable, shownRepo } from './repo-overrides';
import type { EffectiveRepo, RepoOverride } from './types';

const entry = (over: Partial<EffectiveRepo> = {}): EffectiveRepo => ({
  full_name: 'acme/web',
  key: 'web',
  discovered: true,
  has_override: false,
  status: 'ok',
  enabled: true,
  integration_id: 'gh',
  description: 'front',
  base_branch: 'develop',
  branch_pattern: '{ticket}-{slug}',
  draft_pr: true,
  deploy_workflow: 'deploy.yml',
  autonomy: 'merge',
  required_checks: ['ci'],
  release_workflows: [],
  release_paths: ['apps/x/**'],
  store_paths: [],
  merge_order: 2,
  checkouts: [],
  ...over,
});

describe('repo overrides', () => {
  it('shows the table only with more than one repository', () => {
    expect(showRepoTable(undefined)).toBe(false);
    expect(showRepoTable([entry({ key: 'main' })])).toBe(false);
    expect(showRepoTable([entry(), entry({ full_name: 'acme/api' })])).toBe(true);
  });

  it('seeds a new override from what the repository does now, with the fallbacks left null', () => {
    const o = overrideFor(entry(), []);
    expect(o).toMatchObject({ full_name: 'acme/web', autonomy: 'merge', required_checks: ['ci'], deploy_workflow: 'deploy.yml', merge_order: 2 });
    expect(o.base_branch).toBeNull();
    expect(o.integration_id).toBeNull();
    expect(o.description).toBeNull();
  });

  it('edits one field: appends an override, then replaces it matching owner/repo without case', () => {
    const once = setOverride([], entry(), { autonomy: 'pr' });
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ autonomy: 'pr', required_checks: ['ci'] });
    const twice = setOverride(once, entry({ full_name: 'Acme/Web' }), { enabled: false });
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ autonomy: 'pr', enabled: false, full_name: 'Acme/Web' });
  });

  it('drops an override', () => {
    const list: RepoOverride[] = setOverride([], entry(), { merge_order: 5 });
    expect(dropOverride(list, 'ACME/web')).toEqual([]);
  });

  it('shows the override over the server value, null fields falling back', () => {
    const list = setOverride([], entry(), { autonomy: 'pr', base_branch: null });
    const shown = shownRepo(entry(), list);
    expect(shown.autonomy).toBe('pr');
    expect(shown.base_branch).toBe('develop');
  });

  it('caps the levels at the project’s', () => {
    expect(levelsUpTo('merge')).toEqual(['pr', 'merge']);
    expect(levelsUpTo('release')).toHaveLength(4);
  });
});
