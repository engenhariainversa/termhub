import { describe, expect, it } from 'vitest';
import type { ProjectRepository } from '../db/repositories/types.js';
import { isMultiRepo, REPO_KEYS_MAX, resolveRepoKeys } from './repo-keys.js';
import { effectiveRepos } from './repos.js';
import { normalizeSetup, SETUP_VERSION } from './schema.js';

const row = (full_name: string, key: string): ProjectRepository => ({
  id: `r-${key}`, project_id: 'p1', full_name, key, description: null, status: 'ok', discovered_at: '', updated_at: '', checkouts: [],
});
const repos = (raw: Record<string, unknown>, rows: ProjectRepository[]) => effectiveRepos(normalizeSetup(raw, SETUP_VERSION), rows);
const multi = repos({}, [row('acme/api', 'api'), row('acme/web', 'web'), row('acme/docs', 'docs')]);

describe('resolveRepoKeys', () => {
  it('takes keys and owner/repo (any case), counts repeats once and follows the project order', () => {
    expect(resolveRepoKeys(['web', 'ACME/Api', 'api', ' web '], multi)).toEqual({ keys: ['api', 'web'] });
    expect(resolveRepoKeys(['Docs'], multi)).toEqual({ keys: ['docs'] });
    expect(resolveRepoKeys([], multi)).toEqual({ keys: [] });
  });

  it('refuses a repository the project does not have, by key or by owner/repo', () => {
    expect(resolveRepoKeys(['api', 'mobile'], multi)).toEqual({ problem: { code: 'UNKNOWN', repo: 'mobile' } });
    expect(resolveRepoKeys(['other/api'], multi)).toEqual({ problem: { code: 'UNKNOWN', repo: 'other/api' } });
  });

  it('refuses a repository turned off in Setup', () => {
    const list = repos({ repos: [{ full_name: 'acme/docs', enabled: false }] }, [row('acme/api', 'api'), row('acme/web', 'web'), row('acme/docs', 'docs')]);
    expect(resolveRepoKeys(['acme/docs'], list)).toEqual({ problem: { code: 'DISABLED', repo: 'docs' } });
  });

  it('refuses a repository named by hand that discovery has not keyed yet', () => {
    const list = repos({ repos: [{ full_name: 'acme/new' }] }, [row('acme/api', 'api'), row('acme/web', 'web')]);
    expect(resolveRepoKeys(['acme/new'], list)).toEqual({ problem: { code: 'NO_KEY', repo: 'acme/new' } });
  });

  it(`caps a card at ${REPO_KEYS_MAX} repositories`, () => {
    const many = repos({}, Array.from({ length: 11 }, (_, i) => row(`acme/r${i}`, `r${i}`)));
    expect(resolveRepoKeys(many.slice(0, 10).map((r) => r.key!), many)).toMatchObject({ keys: expect.any(Array) });
    expect(resolveRepoKeys(many.map((r) => r.key!), many)).toEqual({ problem: { code: 'TOO_MANY' } });
  });

  it('a project with one repository stores an empty list, even for a valid ref (R8)', () => {
    const single = repos({ repo: { full_name: 'acme/api' } }, []);
    expect(single.map((r) => r.key)).toEqual(['main']);
    expect(isMultiRepo(single)).toBe(false);
    expect(resolveRepoKeys(['main'], single)).toEqual({ keys: [] });
    expect(resolveRepoKeys(['acme/api'], single)).toEqual({ keys: [] });
    expect(resolveRepoKeys(['web'], single)).toEqual({ problem: { code: 'UNKNOWN', repo: 'web' } });
  });

  it('two repositories with only one enabled count as one', () => {
    const list = repos({ repos: [{ full_name: 'acme/web', enabled: false }] }, [row('acme/api', 'api'), row('acme/web', 'web')]);
    expect(isMultiRepo(list)).toBe(false);
    expect(resolveRepoKeys(['api'], list)).toEqual({ keys: [] });
  });

  it('a project with no repository refuses any ref', () => {
    expect(resolveRepoKeys(['main'], [])).toEqual({ problem: { code: 'UNKNOWN', repo: 'main' } });
    expect(resolveRepoKeys([], [])).toEqual({ keys: [] });
  });
});
