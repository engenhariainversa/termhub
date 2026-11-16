import type { TProjectReposResponse } from '@/services/api/contract';
import { repoRows, showRepos } from './repos';

const view = (over: Partial<TProjectReposResponse> = {}): TProjectReposResponse => ({
  project_id: 'p1',
  machines: [
    { machine_id: 'm1', machine: 'mac' },
    { machine_id: 'm2', machine: 'server' },
  ],
  repos: [
    { key: 'api', full_name: 'acme/api', status: 'ok', enabled: true, autonomy: 'merge', machines: [{ machine_id: 'm1', machine: 'mac', dir: 'api', missing: false }] },
    { key: 'web', full_name: 'acme/web', status: 'ok', enabled: true, autonomy: 'pr', machines: [{ machine_id: 'm1', machine: 'mac', dir: 'web', missing: false }, { machine_id: 'm2', machine: 'server', dir: 'front', missing: true }] },
  ],
  ...over,
});

describe('project repositories (TER-1061)', () => {
  it('shows the block only for more than one repository', () => {
    expect(showRepos(null)).toBe(false);
    expect(showRepos(view({ repos: [] }))).toBe(false);
    expect(showRepos(view({ repos: view().repos.slice(0, 1) }))).toBe(false);
    expect(showRepos(view())).toBe(true);
  });

  it('gives each repository its level and its folder on every linked machine, "ausente" as null', () => {
    const rows = repoRows(view());
    expect(rows.map((r) => [r.label, r.level, r.note])).toEqual([
      ['api', 'Merge com CI verde', null],
      ['web', 'Só código e PR', null],
    ]);
    expect(rows[0]!.presence).toEqual([
      { machine: 'mac', dir: 'api' },
      { machine: 'server', dir: null },
    ]);
    // a folder a later scan did not find counts as absent
    expect(rows[1]!.presence[1]).toEqual({ machine: 'server', dir: null });
  });

  it('names a repository by owner/repo before discovery gives it a key, and says why it is left out', () => {
    const rows = repoRows(
      view({
        repos: [
          { key: null, full_name: 'acme/docs', status: 'ok', enabled: true, autonomy: 'pr', machines: [] },
          { key: 'gl', full_name: 'acme/gl', status: 'unsupported', enabled: true, autonomy: 'pr', machines: [] },
          { key: 'off', full_name: 'acme/off', status: 'no_access', enabled: false, autonomy: 'shiny', machines: [] },
        ],
      }),
    );
    expect(rows.map((r) => [r.label, r.note, r.level])).toEqual([
      ['acme/docs', null, 'Só código e PR'],
      ['gl', 'fora do GitHub', 'Só código e PR'],
      // off wins over the status; a level a newer server adds shows as it came
      ['off', 'desligado', 'shiny'],
    ]);
  });

  it('keeps a checkout on a machine no longer linked', () => {
    const rows = repoRows(view({ machines: [], repos: view().repos.slice(0, 1) }));
    expect(rows[0]!.presence).toEqual([{ machine: 'mac', dir: 'api' }]);
  });
});
