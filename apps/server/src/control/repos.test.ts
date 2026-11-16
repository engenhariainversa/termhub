import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { ProjectRepository } from '../db/repositories/types.js';
import { effectiveRepos } from '../setup/repos.js';
import { normalizeSetup, SETUP_VERSION, type ProjectSetupData } from '../setup/schema.js';
import type { ControlContext } from './context.js';
import { listProjectRepos, scanProjectRepos } from './repos.js';

const row = (full_name: string, key: string, checkouts: ProjectRepository['checkouts']): ProjectRepository => ({
  id: key, project_id: 'p1', full_name, key, description: null, status: 'ok', discovered_at: '', updated_at: '', checkouts,
});

function ctxWith(discovered: ProjectRepository[], setup: Record<string, unknown> = {}) {
  const data = normalizeSetup(setup, SETUP_VERSION);
  const repos = {
    projectSetup: { get: vi.fn(async () => ({ project_id: 'p1', data, version: SETUP_VERSION, updated_at: null })) },
    projectMachines: {
      listByProject: vi.fn(async () => [
        { id: 'l1', project_id: 'p1', machine_id: 'm1', cwd: '~/rea', position: 0, created_at: '' },
        { id: 'l2', project_id: 'p1', machine_id: 'm2', cwd: '/srv/rea', position: 1, created_at: '' },
      ]),
    },
    machines: { findById: vi.fn(async (id: string) => ({ id, name: id === 'm1' ? 'one' : 'two', type: 'agent' })) },
    projectRepositories: { effective: vi.fn(async (_p: string, d: ProjectSetupData) => effectiveRepos(d, discovered)), listByProject: vi.fn(async () => discovered) },
  } as unknown as Repositories;
  const ctx = { repos, scoped: { project: vi.fn(async (id: string) => ({ project: { id, owner_id: 'u1' } })) } } as unknown as ControlContext;
  return ctx;
}

describe('list_project_repos', () => {
  it('lists each repository with its level and folder per machine, and each machine with its last scan', async () => {
    const seen = '2026-11-16T12:00:00.000Z';
    const ctx = ctxWith(
      [
        row('acme/app', 'main', [{ machine_id: 'm1', dir: '.', default_branch: 'main', has_commits: true, seen_at: seen, missing_at: null }]),
        row('acme/bff', 'bff', [{ machine_id: 'm1', dir: 'bff', default_branch: 'main', has_commits: true, seen_at: seen, missing_at: seen }]),
      ],
      { repo: { integration_id: 'i1', full_name: 'acme/app' }, automation: { autonomy: 'merge' } },
    );
    const out = await listProjectRepos(ctx, { project_id: 'p1' }, { canScan: (m) => (m.id === 'm1' ? 'ok' : 'offline') });
    expect(out.repos.map((r) => [r.key, r.full_name, r.autonomy])).toEqual([['bff', 'acme/bff', 'pr'], ['main', 'acme/app', 'merge']]);
    expect(out.repos[0]!.machines).toEqual([{ machine_id: 'm1', machine: 'one', dir: 'bff', missing: true, seen_at: seen }]);
    expect(out.machines).toEqual([
      { machine_id: 'm1', machine: 'one', cwd: '~/rea', scanned_at: seen, can_scan: 'ok' },
      { machine_id: 'm2', machine: 'two', cwd: '/srv/rea', scanned_at: null, can_scan: 'offline' },
    ]);
  });

  it('a project nothing scanned yet lists its setup repository as key main', async () => {
    const out = await listProjectRepos(ctxWith([], { repo: { integration_id: 'i1', full_name: 'acme/app' } }), { project_id: 'p1' }, { canScan: () => 'no_repo_scan' });
    expect(out.repos.map((r) => [r.key, r.discovered, r.machines])).toEqual([['main', false, []]]);
  });
});

describe('scan_project_repos', () => {
  it('scans every linked machine now, skipping the ones that cannot, and answers the list', async () => {
    const ctx = ctxWith([]);
    const scan = vi.fn();
    const out = await scanProjectRepos(ctx, { project_id: 'p1' }, { canScan: () => 'no_repo_scan', scan, repoAccess: vi.fn(), now: () => 0 });
    expect(out.scans.map((s) => [s.machine_id, s.skipped])).toEqual([['m1', 'no_repo_scan'], ['m2', 'no_repo_scan']]);
    expect(scan).not.toHaveBeenCalled();
    expect(out.machines).toHaveLength(2);
  });
});
