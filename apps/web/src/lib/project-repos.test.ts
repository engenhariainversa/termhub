import { describe, expect, it } from 'vitest';
import { selectableRepos } from './project-repos';
import type { ProjectRepo } from './types';

const repo = (over: Partial<ProjectRepo>): ProjectRepo => ({
  key: 'main', full_name: 'acme/app', description: null, status: 'ok', enabled: true, discovered: true, autonomy: 'pr', machines: [], ...over,
});

describe('selectableRepos', () => {
  it('offers nothing in a project with one enabled repository', () => {
    expect(selectableRepos({ repos: [] })).toEqual({ multi: false, repos: [] });
    expect(selectableRepos({ repos: [repo({})] })).toEqual({ multi: false, repos: [] });
    expect(selectableRepos({ repos: [repo({ key: 'api' }), repo({ key: 'web', enabled: false })] }).multi).toBe(false);
  });

  it('offers the enabled, keyed repositories of a multi-repo project, in its order', () => {
    const r = selectableRepos({
      repos: [
        repo({ key: 'web', full_name: 'acme/web' }),
        repo({ key: 'off', full_name: 'acme/off', enabled: false }),
        repo({ key: null, full_name: 'acme/by-hand' }),
        repo({ key: 'api', full_name: 'acme/api', description: 'API' }),
      ],
    });
    expect(r.multi).toBe(true);
    expect(r.repos).toEqual([
      { key: 'web', full_name: 'acme/web', description: null },
      { key: 'api', full_name: 'acme/api', description: 'API' },
    ]);
  });
});
