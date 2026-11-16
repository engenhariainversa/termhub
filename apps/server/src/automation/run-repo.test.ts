import { describe, expect, it } from 'vitest';
import type { ProjectRepository, ProjectRepositoryCheckout } from '../db/repositories/types.js';
import { setupSchema } from '../setup/schema.js';
import { baseOf, checkoutDirOn, memberDirsOn, membersOf, pickRunRepo, repoDirOf, runKeysOf } from './run-repo.js';

const checkout = (machine_id: string, dir: string, missing = false): ProjectRepositoryCheckout => ({
  machine_id,
  dir,
  default_branch: 'main',
  has_commits: true,
  seen_at: '2026-11-16T00:00:00.000Z',
  missing_at: missing ? '2026-11-16T01:00:00.000Z' : null,
});
const row = (id: string, full_name: string, key: string, checkouts: ProjectRepositoryCheckout[]): ProjectRepository => ({
  id,
  project_id: 'p1',
  full_name,
  key,
  description: null,
  status: 'ok',
  discovered_at: '2026-11-16T00:00:00.000Z',
  updated_at: '2026-11-16T00:00:00.000Z',
  checkouts,
});
const setup = (repo: Record<string, unknown> | null = { integration_id: 'int-1', full_name: 'acme/app', base_branch: 'develop', branch_pattern: 'feat/{ticket}' }) =>
  setupSchema.parse({ repo, repo_defaults: { integration_id: 'int-1' }, automation: { enabled: true } });

describe('pickRunRepo (multi-repo Task 11)', () => {
  const two = [row('r-app', 'acme/app', 'app', [checkout('m1', 'app'), checkout('m2', 'code/app')]), row('r-api', 'acme/api', 'api', [checkout('m1', 'api', true)])];

  it("a card's single key is its repository, with that repository's id, base and pattern", () => {
    const r = pickRunRepo(setup(), two, ['api']);
    expect(r).toMatchObject({ repositoryId: 'r-api', multi: true, entry: { full_name: 'acme/api', key: 'api' } });
    // a repository other than setup.repo starts with the defaults (R6): its checkout's default branch
    expect(r.branch).toEqual({ branch_pattern: 'feat/{ticket}', base_branch: 'main', require_ticket: false });
    expect(pickRunRepo(setup(), two, ['app']).branch).toMatchObject({ base_branch: 'develop' });
  });

  it('no key is the project run repository; an unknown or disabled key is refused', () => {
    expect(pickRunRepo(setup(), two, []).entry?.full_name).toBe('acme/app');
    expect(() => pickRunRepo(setup(), two, ['app', 'web'])).toThrow(expect.objectContaining({ code: 'REPO_UNAVAILABLE' }));
    expect(() => pickRunRepo(setup(), two, ['web'])).toThrow(expect.objectContaining({ code: 'REPO_UNAVAILABLE' }));
    const off = setupSchema.parse({ ...setup(), repos: [{ full_name: 'acme/api', enabled: false }] });
    expect(() => pickRunRepo(off, two, ['api'])).toThrow(expect.objectContaining({ code: 'REPO_UNAVAILABLE' }));
  });

  it('each machine reads its own checkout; a missing one, or none in a multi-repo project, leaves the machine out (R5)', () => {
    const app = pickRunRepo(setup(), two, ['app']);
    expect(checkoutDirOn(app, 'm1')).toBe('app');
    expect(checkoutDirOn(app, 'm2')).toBe('code/app');
    expect(checkoutDirOn(app, 'm3')).toBeNull();
    expect(checkoutDirOn(pickRunRepo(setup(), two, ['api']), 'm1')).toBeNull();
  });

  it('a single-repo project reads the link folder: nothing discovered, a `.` checkout, or a machine the scan never saw', () => {
    const legacy = pickRunRepo(setup(), [], []);
    expect(legacy).toMatchObject({ repositoryId: null, multi: false, entry: { full_name: 'acme/app', key: 'main', discovered: false } });
    expect(legacy.branch).toEqual({ branch_pattern: 'feat/{ticket}', base_branch: 'develop', require_ticket: false });
    expect(checkoutDirOn(legacy, 'm1')).toBe('.');
    const one = pickRunRepo(setup(), [row('r1', 'acme/app', 'main', [checkout('m1', '.')])], []);
    expect(one.repositoryId).toBe('r1');
    expect(checkoutDirOn(one, 'm1')).toBe('.');
    expect(checkoutDirOn(one, 'm2')).toBe('.');
    // REA after the rollout: the link at the parent folder, one repository left enabled
    const parent = pickRunRepo(setup(), [row('r1', 'acme/app', 'app', [checkout('m1', 'frontend')])], []);
    expect(checkoutDirOn(parent, 'm1')).toBe('frontend');
  });

  it('a project with no repository at all keeps the link folder and setup.repo (null)', () => {
    const none = pickRunRepo(setup(null), [], []);
    expect(none).toMatchObject({ entry: null, repositoryId: null, branch: null });
    expect(checkoutDirOn(none, 'm1')).toBe('.');
    expect(baseOf(none, setup(null))).toBe('main');
  });
});

describe('workspace runs (multi-repo Task 12)', () => {
  const two = [row('r-app', 'acme/app', 'app', [checkout('m1', 'app'), checkout('m2', 'code/app')]), row('r-api', 'acme/api', 'api', [checkout('m1', 'api'), checkout('m2', 'api', true)])];

  it('several keys are one run with a member per repository, in the order given; the first gives the naming', () => {
    const r = pickRunRepo(setup(), two, ['app', 'api']);
    expect(r).toMatchObject({ repositoryId: 'r-app', entry: { key: 'app' }, branch: { branch_pattern: 'feat/{ticket}', base_branch: 'develop' } });
    expect(membersOf(r).map((m) => [m.entry.key, m.repositoryId, m.branch?.base_branch])).toEqual([
      ['app', 'r-app', 'develop'],
      ['api', 'r-api', 'main'],
    ]);
    // a key given twice is one repository: no workspace
    expect(membersOf(pickRunRepo(setup(), two, ['api', 'api']))).toEqual([]);
    expect(membersOf(pickRunRepo(setup(), two, ['api']))).toEqual([]);
  });

  it('a machine holds the run only with every repository present there', () => {
    const r = pickRunRepo(setup(), two, ['app', 'api']);
    expect(memberDirsOn(r, 'm1')).toEqual([
      { key: 'app', dir: 'app' },
      { key: 'api', dir: 'api' },
    ]);
    expect(checkoutDirOn(r, 'm1')).toBe('app');
    // api is marked missing on m2
    expect(memberDirsOn(r, 'm2')).toBeNull();
    expect(checkoutDirOn(r, 'm2')).toBeNull();
    expect(checkoutDirOn(r, 'm3')).toBeNull();
  });

  it("reads a run's keys back from its rows: only worktrees right under its workspace", () => {
    const rows = [{ worktree_path: '/w/p1/TER-1/api' }, { worktree_path: '/w/p1/TER-1/app/' }, { worktree_path: '/w/p1/TER-1/api' }];
    expect(runKeysOf(rows, '/w/p1/TER-1')).toEqual(['api', 'app']);
    expect(runKeysOf(rows, '/w/p1/TER-1/')).toEqual(['api', 'app']);
    // a single-repo run: its row is the worktree itself
    expect(runKeysOf([{ worktree_path: '/w/p1/TER-1' }], '/w/p1/TER-1')).toEqual([]);
    expect(runKeysOf(rows, null)).toEqual([]);
  });
});

describe('repoDirOf', () => {
  it("returns the link's folder unchanged for `.`, and joins a subfolder", () => {
    expect(repoDirOf('/home/u/app/', '.')).toBe('/home/u/app/');
    expect(repoDirOf('~/code', '.')).toBe('~/code');
    expect(repoDirOf('/home/u/rea', 'frontend')).toBe('/home/u/rea/frontend');
    expect(repoDirOf('/home/u/rea/', 'apps/api')).toBe('/home/u/rea/apps/api');
  });
});
