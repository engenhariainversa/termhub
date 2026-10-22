import { describe, expect, it } from 'vitest';
import type { ProjectRepository, ProjectRepositoryCheckout } from '../db/repositories/types.js';
import { effectiveRepos, repoKeyFor, uniqueRepoKey, withRepoMirror } from './repos.js';
import { normalizeSetup, SETUP_VERSION, type ProjectSetupData } from './schema.js';

const setup = (raw: Record<string, unknown> = {}): ProjectSetupData => normalizeSetup(raw, SETUP_VERSION);

const checkout = (over: Partial<ProjectRepositoryCheckout> = {}): ProjectRepositoryCheckout => ({
  machine_id: 'm1', dir: '.', default_branch: 'main', has_commits: true, seen_at: '2026-10-12T00:00:00.000Z', missing_at: null, ...over,
});
const row = (full_name: string, key: string, over: Partial<ProjectRepository> = {}): ProjectRepository => ({
  id: `r-${key}`, project_id: 'p1', full_name, key, description: null, status: 'ok', discovered_at: '', updated_at: '', checkouts: [checkout({ dir: key })], ...over,
});

const legacyRepo = { integration_id: 'g1', full_name: 'acme/api', base_branch: 'develop', branch_pattern: 'feat/{ticket}', require_ticket: false, draft_pr: false, deploy_workflow: 'deploy.yml' };
const projectPolicy = { autonomy: 'merge', required_checks: ['CI'], release_workflows: ['publish.yml'], release_paths: ['apps/agent/package.json'], store_paths: ['apps/mobile/app.json'] };

describe('effectiveRepos', () => {
  it('is empty with nothing discovered and no repo, or a repo block that names none', () => {
    expect(effectiveRepos(setup(), [])).toEqual([]);
    expect(effectiveRepos(setup({ repo: { integration_id: 'g1' } }), [])).toEqual([]);
  });

  it('with nothing discovered, setup.repo is the single entry, key main, at the project policy (R19)', () => {
    expect(effectiveRepos(setup({ repo: legacyRepo, automation: projectPolicy }), [])).toEqual([{
      full_name: 'acme/api', key: 'main', discovered: false, has_override: false, status: 'ok', enabled: true,
      integration_id: 'g1', description: null, base_branch: 'develop', branch_pattern: 'feat/{ticket}', draft_pr: false, deploy_workflow: 'deploy.yml',
      autonomy: 'merge', required_checks: ['CI'], release_workflows: ['publish.yml'], release_paths: ['apps/agent/package.json'], store_paths: ['apps/mobile/app.json'],
      merge_order: 0, checkouts: [],
    }]);
  });

  it('the repo already in setup.repo keeps its level; any other discovered repo starts safe (R6)', () => {
    const rows = [
      row('acme/api', 'main', { checkouts: [checkout()] }),
      row('acme/web', 'web', { description: 'the site', checkouts: [checkout({ dir: 'web', default_branch: 'trunk' })] }),
    ];
    const [api, web] = effectiveRepos(setup({ repo: legacyRepo, repo_defaults: { integration_id: 'gd' }, automation: projectPolicy }), rows);
    expect(api).toMatchObject({ key: 'main', discovered: true, autonomy: 'merge', required_checks: ['CI'], base_branch: 'develop', deploy_workflow: 'deploy.yml', integration_id: 'g1' });
    expect(web).toMatchObject({
      full_name: 'acme/web', key: 'web', discovered: true, has_override: false, enabled: true, integration_id: 'gd', description: 'the site',
      base_branch: 'trunk', branch_pattern: 'feat/{ticket}', draft_pr: false, deploy_workflow: null,
      autonomy: 'pr', required_checks: [], release_workflows: [], release_paths: [], store_paths: [],
    });
  });

  it('setup.repo that discovery did not find stays listed, with no key, once rows exist', () => {
    const list = effectiveRepos(setup({ repo: legacyRepo, automation: projectPolicy }), [row('acme/web', 'web')]);
    expect(list.map((e) => [e.full_name, e.key, e.discovered, e.autonomy])).toEqual([['acme/web', 'web', true, 'pr'], ['acme/api', null, false, 'merge']]);
  });

  it('lists an override for a repository discovery has not seen yet', () => {
    const s = setup({ repo_defaults: { integration_id: 'gd' }, automation: { autonomy: 'deploy' }, repos: [{ full_name: 'acme/new', autonomy: 'merge', description: 'by hand', merge_order: 3, base_branch: 'dev' }] });
    expect(effectiveRepos(s, [])).toEqual([expect.objectContaining({
      full_name: 'acme/new', key: null, discovered: false, has_override: true, status: 'ok', integration_id: 'gd', description: 'by hand',
      base_branch: 'dev', branch_pattern: '{ticket}-{slug}', draft_pr: true, autonomy: 'merge', merge_order: 3, checkouts: [],
    })]);
  });

  it('clamps a stored level above the project to the project (R7)', () => {
    const s = setup({ automation: { autonomy: 'merge' }, repos: [{ full_name: 'acme/web', autonomy: 'release' }, { full_name: 'acme/bff', autonomy: 'pr' }] });
    expect(effectiveRepos(s, []).map((e) => [e.full_name, e.autonomy])).toEqual([['acme/bff', 'pr'], ['acme/web', 'merge']]);
  });

  it('matches owner/repo without case across setup.repo, the override and the row', () => {
    const s = setup({ repo: legacyRepo, automation: projectPolicy, repos: [{ full_name: 'ACME/Api', autonomy: 'pr', merge_order: 2 }] });
    const list = effectiveRepos(s, [row('Acme/API', 'main')]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ full_name: 'Acme/API', key: 'main', has_override: true, autonomy: 'pr', merge_order: 2 });
  });

  it('an override of the repo in setup.repo falls back to the repo block for what it leaves null, and rules the policy', () => {
    const s = setup({ repo: legacyRepo, automation: projectPolicy, repos: [{ full_name: 'acme/api', merge_order: 1 }] });
    expect(effectiveRepos(s, [row('acme/api', 'main')])[0]).toMatchObject({
      integration_id: 'g1', base_branch: 'develop', branch_pattern: 'feat/{ticket}', deploy_workflow: 'deploy.yml', autonomy: 'pr', required_checks: [], merge_order: 1,
    });
    const own = setup({ repo: legacyRepo, automation: projectPolicy, repos: [{ full_name: 'acme/api', integration_id: 'g2', base_branch: 'next', branch_pattern: '{slug}', deploy_workflow: 'ship.yml', autonomy: 'merge', required_checks: ['lint'] }] });
    expect(effectiveRepos(own, [])[0]).toMatchObject({ key: 'main', integration_id: 'g2', base_branch: 'next', branch_pattern: '{slug}', deploy_workflow: 'ship.yml', autonomy: 'merge', required_checks: ['lint'] });
  });

  it('reads the base branch from a checkout that is still there', () => {
    const gone = checkout({ machine_id: 'm1', default_branch: 'old', missing_at: '2026-10-12T01:00:00.000Z' });
    const unborn = checkout({ machine_id: 'm2', default_branch: null, has_commits: false });
    const here = checkout({ machine_id: 'm3', default_branch: 'trunk' });
    expect(effectiveRepos(setup(), [row('acme/web', 'web', { checkouts: [gone, unborn, here] })])[0].base_branch).toBe('trunk');
    expect(effectiveRepos(setup(), [row('acme/web', 'web', { checkouts: [gone, unborn] })])[0].base_branch).toBe('main');
  });

  it('keeps the status discovery gave and the disabled flag', () => {
    const s = setup({ repos: [{ full_name: 'acme/web', enabled: false }] });
    const list = effectiveRepos(s, [row('acme/web', 'web'), row('local/tools', 'tools', { status: 'unsupported' })]);
    expect(list.map((e) => [e.key, e.status, e.enabled])).toEqual([['tools', 'unsupported', true], ['web', 'ok', false]]);
  });

  it('orders by merge order, then key, then name, with unnamed repos last', () => {
    const s = setup({ repos: [{ full_name: 'acme/z', merge_order: 0 }, { full_name: 'acme/a', merge_order: 0 }, { full_name: 'acme/first', merge_order: 0 }, { full_name: 'acme/late', merge_order: 5 }] });
    const list = effectiveRepos(s, [row('acme/late', 'aaa'), row('acme/first', 'bff'), row('acme/other', 'api')]);
    expect(list.map((e) => e.full_name)).toEqual(['acme/other', 'acme/first', 'acme/a', 'acme/z', 'acme/late']);
  });
});

describe('withRepoMirror', () => {
  it('returns a setup with nothing discovered and no override as given', () => {
    const s = setup({ repo: legacyRepo, automation: projectPolicy });
    expect(withRepoMirror(s, [])).toBe(s);
    const none = setup();
    expect(withRepoMirror(none, [])).toBe(none);
  });

  it('rewrites the same repository with its own values, and a second pass changes nothing', () => {
    const s = setup({ repo: legacyRepo, automation: projectPolicy });
    const rows = [row('acme/api', 'main'), row('acme/web', 'web')];
    const once = withRepoMirror(s, rows);
    expect(once.repo).toEqual(legacyRepo);
    expect(once.repos).toEqual([]);
    expect(withRepoMirror(once, rows)).toEqual(once);
  });

  it('a tie on merge order keeps the repository already in repo, even when another sorts first', () => {
    const s = setup({ repo: { ...legacyRepo, full_name: 'acme/zeta' }, automation: projectPolicy });
    const out = withRepoMirror(s, [row('acme/alpha', 'alpha'), row('acme/zeta', 'zeta')]);
    expect(out.repo?.full_name).toBe('acme/zeta');
    expect(out.repos).toEqual([]);
  });

  it('writes an override value of the mirrored repository into repo', () => {
    const s = setup({ repo: legacyRepo, automation: projectPolicy, repos: [{ full_name: 'acme/api', base_branch: 'next', deploy_workflow: 'ship.yml', autonomy: 'merge' }] });
    expect(withRepoMirror(s, []).repo).toEqual({ ...legacyRepo, base_branch: 'next', deploy_workflow: 'ship.yml' });
  });

  it('moving the mirror writes explicit overrides for both repositories: nobody gains or loses a level', () => {
    const s = setup({ repo: legacyRepo, repo_defaults: { integration_id: 'gd' }, automation: projectPolicy, repos: [{ full_name: 'acme/api', enabled: false, autonomy: 'merge' }] });
    const rows = [row('acme/api', 'main'), row('acme/web', 'web', { checkouts: [checkout({ dir: 'web', default_branch: 'trunk' })] })];
    const out = withRepoMirror(s, rows);
    expect(out.repo).toEqual({ integration_id: 'gd', full_name: 'acme/web', base_branch: 'trunk', branch_pattern: 'feat/{ticket}', require_ticket: false, draft_pr: false, deploy_workflow: null });
    const list = effectiveRepos(out, rows);
    expect(list.find((e) => e.key === 'web')).toMatchObject({ has_override: true, autonomy: 'pr', required_checks: [], release_paths: [], store_paths: [] });
    // the repository that left repo keeps what it read from the repo block
    expect(list.find((e) => e.key === 'main')).toMatchObject({ enabled: false, integration_id: 'g1', base_branch: 'develop', deploy_workflow: 'deploy.yml', autonomy: 'merge' });
    expect(withRepoMirror(out, rows)).toEqual(out);
  });

  it('a repository leaving repo with no override keeps the project policy it had', () => {
    const s = setup({ repo: legacyRepo, automation: projectPolicy });
    const rows = [row('acme/api', 'main', { status: 'no_access' }), row('acme/web', 'web')];
    const out = withRepoMirror(s, rows);
    expect(out.repo?.full_name).toBe('acme/web');
    const list = effectiveRepos(out, rows);
    expect(list.find((e) => e.key === 'main')).toMatchObject({ autonomy: 'merge', required_checks: ['CI'], base_branch: 'develop', deploy_workflow: 'deploy.yml', store_paths: ['apps/mobile/app.json'] });
    expect(list.find((e) => e.key === 'web')).toMatchObject({ autonomy: 'pr', required_checks: [] });
  });

  it('a lower merge order takes the mirror', () => {
    const s = setup({ repo: legacyRepo, automation: projectPolicy, repos: [{ full_name: 'acme/api', merge_order: 2, autonomy: 'merge' }, { full_name: 'acme/web', merge_order: 1 }] });
    expect(withRepoMirror(s, [row('acme/api', 'main'), row('acme/web', 'web')]).repo?.full_name).toBe('acme/web');
  });

  it('with no repo block, the first discovered repository becomes the mirror, at pr', () => {
    const rows = [row('acme/web', 'web'), row('acme/api', 'api')];
    const out = withRepoMirror(setup({ automation: projectPolicy, repo_defaults: { integration_id: 'gd' } }), rows);
    expect(out.repo).toEqual({ integration_id: 'gd', full_name: 'acme/api', base_branch: 'main', branch_pattern: '{ticket}-{slug}', require_ticket: false, draft_pr: true, deploy_workflow: null });
    expect(effectiveRepos(out, rows).find((e) => e.key === 'api')).toMatchObject({ has_override: true, autonomy: 'pr', required_checks: [] });
  });

  it('never mirrors a disabled, unsupported or inaccessible repository; with none left, repo is kept', () => {
    const s = setup({ repo: legacyRepo, automation: projectPolicy, repos: [{ full_name: 'acme/api', enabled: false }, { full_name: 'acme/web', enabled: false }] });
    const rows = [row('acme/api', 'main'), row('acme/web', 'web'), row('local/tools', 'tools', { status: 'unsupported' }), row('acme/secret', 'secret', { status: 'no_access' })];
    expect(withRepoMirror(s, rows)).toBe(s);
  });

  it('does not move when the explicit overrides would not fit', () => {
    const repos = [{ full_name: 'acme/api', enabled: false }, ...Array.from({ length: 49 }, (_, i) => ({ full_name: `acme/off${i}`, enabled: false }))];
    const s = setup({ repo: legacyRepo, repos });
    expect(withRepoMirror(s, [row('acme/web', 'web')])).toBe(s);
  });
});

describe('repository keys', () => {
  it('main for the project folder, else the slugged base name', () => {
    expect(repoKeyFor('.')).toBe('main');
    expect(repoKeyFor('')).toBe('main');
    expect(repoKeyFor('./')).toBe('main');
    expect(repoKeyFor('hub-community-frontend')).toBe('hub-community-frontend');
    expect(repoKeyFor('Hub Community_BFF')).toBe('hub-community_bff');
    expect(repoKeyFor('apps/web/')).toBe('web');
    expect(repoKeyFor('apps\\Web.App')).toBe('web.app');
  });

  it('is always a safe path segment', () => {
    for (const dir of ['..', '@@@', 'a/..', '...', '-.-']) expect(repoKeyFor(dir), dir).toBe('repo');
    expect(repoKeyFor('a..b')).toBe('a.b');
    expect(repoKeyFor('x'.repeat(80))).toBe('x'.repeat(64));
    expect(repoKeyFor(`${'x'.repeat(63)}-y`)).toBe('x'.repeat(63));
  });

  it('adds a number when the key is taken', () => {
    expect(uniqueRepoKey('web', [])).toBe('web');
    expect(uniqueRepoKey('main', ['main', 'main-2'])).toBe('main-3');
    expect(uniqueRepoKey('x'.repeat(64), ['x'.repeat(64)])).toBe(`${'x'.repeat(62)}-2`);
  });
});
