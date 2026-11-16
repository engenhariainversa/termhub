import { describe, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationEventInput } from '../db/repositories/automation-events.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { addRunRepo, type AddRepoDeps } from './add-repo.js';

const checkout = (machine_id: string, dir: string, missing = false) => ({ machine_id, dir, default_branch: 'main', has_commits: true, seen_at: '', missing_at: missing ? '2026-11-01T00:00:00.000Z' : null });
const repoRow = (id: string, key: string, full_name: string, checkouts: ReturnType<typeof checkout>[], status = 'ok') => ({ id, project_id: 'p1', key, full_name, description: null, status, discovered_at: '', updated_at: '', checkouts });

/**
 * A workspace run of TER-1 on m1 with `front` and `api`, in a project that also has `docs` (on m1), `infra`
 * (only on m2), `old` (turned off in Setup) and `ext` (not readable by the integration).
 */
function world(o: { single?: boolean; epicAuto?: boolean } = {}) {
  const runRows = [
    { run_id: 'run1', repository_id: 'r-front', branch: 'TER-1-x', base: 'main', worktree_path: '/wt/p1/TER-1/front', state: 'ready', created_at: new Date() },
    ...(o.single ? [] : [{ run_id: 'run1', repository_id: 'r-api', branch: 'TER-1-x', base: 'main', worktree_path: '/wt/p1/TER-1/api', state: 'ready', created_at: new Date() }]),
  ];
  const run = { id: 'run1', project_id: 'p1', task_id: 't1', role: 'implementer', status: 'running', tab_id: 'tab1', machine_id: 'm1', branch: 'TER-1-x', worktree_path: '/wt/p1/TER-1' };
  if (o.single) runRows[0]!.worktree_path = '/wt/p1/TER-1';
  const task = { id: 't1', project_id: 'p1', ref: 'TER-1', title: 'Card', epic_id: o.epicAuto ? 'e1' : null, repo_keys: o.single ? ['front'] : ['front', 'api'] };
  const events: AutomationEventInput[] = [];
  const repos = {
    automationRuns: { activeByTab: vi.fn(async (id: string) => (id === 'tab1' ? run : null)) },
    tasks: {
      findById: vi.fn(async (id: string) => (id === 't1' ? task : { id: 'e1', ref: 'TER-9', title: 'Épico', auto: true })),
      addRepoKey: vi.fn(async (_id: string, key: string) => ({ ...task, repo_keys: [...task.repo_keys, key] })),
    },
    automationRunRepos: { listByRun: vi.fn(async () => runRows), add: vi.fn(async () => {}) },
    projectSetup: {
      get: vi.fn(async () => ({
        data: {
          repo: { full_name: 'acme/front', integration_id: 'i1', base_branch: 'main', branch_pattern: '{ref}-{slug}', require_ticket: false },
          repos: [{ full_name: 'acme/old', enabled: false }],
          automation: { worktrees_dir: '/elsewhere', epic_branch_pattern: 'epic/{ref}-{slug}' },
        },
      })),
    },
    projectRepositories: {
      listByProject: vi.fn(async () => [
        repoRow('r-front', 'front', 'acme/front', [checkout('m1', 'front')]),
        repoRow('r-api', 'api', 'acme/api', [checkout('m1', 'api')]),
        repoRow('r-docs', 'docs', 'acme/docs', [checkout('m1', 'docs')]),
        repoRow('r-infra', 'infra', 'acme/infra', [checkout('m2', 'infra'), checkout('m1', 'infra', true)]),
        repoRow('r-old', 'old', 'acme/old', [checkout('m1', 'old')]),
        repoRow('r-ext', 'ext', 'acme/ext', [checkout('m1', 'ext')], 'no_access'),
      ]),
    },
    projectMachines: { find: vi.fn(async () => ({ project_id: 'p1', machine_id: 'm1', cwd: '/home/u/acme' })) },
    machines: { findById: vi.fn(async () => ({ id: 'm1', owner_id: 'u1' })) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    integrations: { findById: vi.fn(async () => ({ id: 'i1', provider: 'github', owner_id: 'u1' })), getSecret: vi.fn(async () => 'tok') },
    automationEvents: { insert: vi.fn(async (e: AutomationEventInput) => (events.push(e), { ...e, id: 'ev', created_at: '' })) },
  } as unknown as Repositories;
  const deps: AddRepoDeps = {
    ensureWorkspace: vi.fn(async (_m, i) => ({ path: `${i.root}/${i.projectId}/${i.ref}/${i.key}`, created: true })),
    ensureEpicBranch: vi.fn(async () => {}),
    gh: {} as GithubWriteClient,
  };
  const ctx = { repos, token: { id: 'tok', scopes: ['read'], tab: { id: 'tab1', project_id: 'p1' } } } as unknown as ControlContext;
  return { repos, deps, ctx, events };
}

describe('add_repo (spec 2026-10-07 multi-repo R12, TER-1064)', () => {
  it('adds a repository to a workspace run: its worktree under the run\'s root, the row, the card\'s key and the event', async () => {
    const w = world();
    const res = await addRunRepo(w.ctx, { key: 'docs' }, w.deps);
    expect(res).toEqual({ ok: true, key: 'docs', repo: 'acme/docs', path: '/wt/p1/TER-1/docs', base: 'main' });
    // the run's own workspace, not the Setup's folder of today
    expect(w.deps.ensureWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), { repoDir: '/home/u/acme/docs', root: '/wt', projectId: 'p1', ref: 'TER-1', branch: 'TER-1-x', base: 'main', key: 'docs' });
    expect(w.repos.automationRunRepos.add).toHaveBeenCalledWith({ run_id: 'run1', repository_id: 'r-docs', branch: 'TER-1-x', base: 'main', worktree_path: '/wt/p1/TER-1/docs' });
    expect(w.repos.tasks.addRepoKey).toHaveBeenCalledWith('t1', 'docs');
    expect(w.events).toEqual([expect.objectContaining({ kind: 'run_repo_added', run_id: 'run1', task_id: 't1', payload: { key: 'docs', repo: 'acme/docs', tab_id: 'tab1', path: '/wt/p1/TER-1/docs' } })]);
    expect(w.deps.ensureEpicBranch).not.toHaveBeenCalled();
  });

  it('in an automatic epic, makes the epic branch in the new repository first and cuts the worktree from it (R16)', async () => {
    const w = world({ epicAuto: true });
    const res = await addRunRepo(w.ctx, { key: 'docs' }, w.deps);
    expect(w.deps.ensureEpicBranch).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok', repo: 'acme/docs' }), 'main', res.base);
    expect(res.base).toMatch(/^epic\/TER-9/);
  });

  it('a key already in the run does nothing', async () => {
    const w = world();
    expect(await addRunRepo(w.ctx, { key: 'api' }, w.deps)).toMatchObject({ ok: true, key: 'api', already: true, path: '/wt/p1/TER-1/api' });
    expect(w.deps.ensureWorkspace).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
  });

  it.each([
    ['a key the project does not have', 'nope', 'REPO_UNKNOWN'],
    ['a repository turned off in Setup', 'old', 'REPO_UNAVAILABLE'],
    ['a repository the integration cannot read', 'ext', 'REPO_UNAVAILABLE'],
    ['a repository missing from the run\'s machine', 'infra', 'REPO_NOT_ON_MACHINE'],
  ])('refuses %s', async (_what, key, code) => {
    const w = world();
    await expect(addRunRepo(w.ctx, { key }, w.deps)).rejects.toMatchObject({ code });
    expect(w.deps.ensureWorkspace).not.toHaveBeenCalled();
    expect(w.repos.automationRunRepos.add).not.toHaveBeenCalled();
    expect(w.repos.tasks.addRepoKey).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
  });

  it('refuses a run in one repository: there is no workspace to add under', async () => {
    const w = world({ single: true });
    await expect(addRunRepo(w.ctx, { key: 'docs' }, w.deps)).rejects.toMatchObject({ code: 'ADD_REPO_SINGLE' });
    expect(w.deps.ensureWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a tab with no active run', async () => {
    const w = world();
    const other = { ...w.ctx, token: { id: 'tok', scopes: ['read'], tab: { id: 'tab9', project_id: 'p1' } } } as unknown as ControlContext;
    await expect(addRunRepo(other, { key: 'docs' }, w.deps)).rejects.toMatchObject({ code: 'NO_RUN' });
  });
});
