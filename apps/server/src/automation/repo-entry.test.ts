import { describe, expect, it } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { setupSchema, type ProjectSetupData } from '../setup/schema.js';
import { activeEntries, entryFor, isMultiRepo, legacyEntry, loadRepoEntries, runEntry } from './repo-entry.js';

const row = (full_name: string, key: string, status: 'ok' | 'no_access' = 'ok') => ({ id: key, project_id: 'p1', full_name, key, description: null, status, discovered_at: '', updated_at: '', checkouts: [] });
const single = setupSchema.parse({
  repo: { integration_id: 'i1', full_name: 'acme/app', base_branch: 'develop', deploy_workflow: 'deploy.yml' },
  automation: { enabled: true, autonomy: 'release', required_checks: ['ci'], release_paths: ['apps/agent/**'], store_paths: ['apps/mobile/app.json'], release_workflows: ['publish.yml'] },
});

describe('repo entries', () => {
  it('a single-repo project has one entry with the setup\'s repository and the project-wide policy', async () => {
    const list = await loadRepoEntries({} as Repositories, 'p1', single);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      full_name: 'acme/app', integration_id: 'i1', base_branch: 'develop', deploy_workflow: 'deploy.yml', autonomy: 'release',
      required_checks: ['ci'], release_paths: ['apps/agent/**'], store_paths: ['apps/mobile/app.json'], release_workflows: ['publish.yml'],
    });
    expect(isMultiRepo(list)).toBe(false);
    expect(runEntry(list, single)?.full_name).toBe('acme/app');
  });

  it('reads discovery\'s rows; disabled and unreadable repositories are not active', async () => {
    const setup = setupSchema.parse({ ...single, repos: [{ full_name: 'acme/old', enabled: false }] });
    const repos = { projectRepositories: { listByProject: async () => [row('acme/app', 'app'), row('acme/api', 'api'), row('acme/old', 'old'), row('acme/secret', 'secret', 'no_access')] } } as unknown as Repositories;
    const list = await loadRepoEntries(repos, 'p1', setup);
    expect(activeEntries(list).map((e) => e.key).sort()).toEqual(['api', 'app']);
    expect(entryFor(list, 'ACME/API')?.autonomy).toBe('pr');
    expect(isMultiRepo(list)).toBe(true);
  });

  it('the run\'s repository is setup.repo, else the first active one', () => {
    const list = [{ ...legacyEntry(single, 'acme/app')!, enabled: false }, { ...legacyEntry(single, 'acme/app')!, full_name: 'acme/other' }];
    expect(runEntry(list, single)?.full_name).toBe('acme/other');
  });

  it('fills a partial setup with the defaults', async () => {
    const partial = { repo: { integration_id: 'i1', full_name: 'acme/app' }, automation: { enabled: true } } as unknown as ProjectSetupData;
    expect((await loadRepoEntries({} as Repositories, 'p1', partial))[0]).toMatchObject({ full_name: 'acme/app', base_branch: 'main', autonomy: 'pr' });
    expect(legacyEntry(partial, 'acme/nope')).toBeNull();
  });
});
