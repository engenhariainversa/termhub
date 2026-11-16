import { describe, expect, it } from 'vitest';
import { automationSchema } from '../setup/schema.js';
import { effectiveRepos } from '../setup/repos.js';
import { setupSchema } from '../setup/schema.js';
import { allows, globMatches, policyRepos, policyText, requiredLevel, runPolicyRepos } from './policy.js';
import { runEntry } from './repo-entry.js';

const base = { base: 'main', epicBranch: null, baseBranch: 'main', deployWorkflow: null, files: ['apps/server/a.ts'], releasePaths: [], storePaths: [] };

describe('requiredLevel', () => {
  it('a card PR into its epic branch needs merge', () =>
    expect(requiredLevel({ ...base, base: 'epic/TER-1-x', epicBranch: 'epic/TER-1-x', deployWorkflow: 'CI e Deploy' })).toBe('merge'));
  it('into main with a deploy workflow needs deploy', () => expect(requiredLevel({ ...base, deployWorkflow: 'CI e Deploy' })).toBe('deploy'));
  it('into main without a deploy workflow needs merge', () => expect(requiredLevel(base)).toBe('merge'));
  it('a base that is neither the epic branch nor the base branch is other_base, never allowed', () => {
    const n = requiredLevel({ ...base, base: 'production' });
    expect(n).toBe('other_base');
    expect(allows('release', n)).toBe(false);
    expect(requiredLevel({ ...base, base: 'epic/y', epicBranch: 'epic/x' })).toBe('other_base');
    expect(requiredLevel({ ...base, base: 'production', files: ['apps/agent/package.json'], releasePaths: ['apps/agent/**'] })).toBe('other_base');
  });
  it('a release path anywhere needs release', () =>
    expect(requiredLevel({ ...base, files: ['apps/agent/package.json'], releasePaths: ['apps/agent/package.json'] })).toBe('release'));
  it('a release glob matches nested files', () =>
    expect(requiredLevel({ ...base, base: 'epic/x', epicBranch: 'epic/x', files: ['apps/agent/src/a.ts'], releasePaths: ['apps/agent/**'] })).toBe('release'));
  it('a store path wins over everything and is never allowed', () => {
    const n = requiredLevel({ ...base, deployWorkflow: 'x', files: ['apps/mobile/app.json'], releasePaths: ['apps/mobile/**'], storePaths: ['apps/mobile/app.json'] });
    expect(n).toBe('store');
    expect(allows('release', n)).toBe(false);
  });
});

describe('allows', () => {
  it('levels are cumulative', () => {
    expect(allows('deploy', 'merge')).toBe(true);
    expect(allows('merge', 'deploy')).toBe(false);
    expect(allows('pr', 'merge')).toBe(false);
    expect(allows('release', 'release')).toBe(true);
  });
});

describe('globMatches', () => {
  it('matches literals exactly', () => {
    expect(globMatches('a/b.ts', 'a/b.ts')).toBe(true);
    expect(globMatches('a/b.ts', 'a/bxts')).toBe(false);
  });
  it('* stays inside one segment', () => {
    expect(globMatches('apps/*/package.json', 'apps/agent/package.json')).toBe(true);
    expect(globMatches('apps/*/package.json', 'apps/a/b/package.json')).toBe(false);
    expect(globMatches('*.json', 'a.json')).toBe(true);
  });
  it('** crosses segments, including none', () => {
    expect(globMatches('apps/mobile/**', 'apps/mobile/a/b.ts')).toBe(true);
    expect(globMatches('apps/**/x.ts', 'apps/x.ts')).toBe(true);
    expect(globMatches('apps/**/x.ts', 'apps/a/b/x.ts')).toBe(true);
    expect(globMatches('apps/mobile/**', 'apps/web/a.ts')).toBe(false);
  });
  it('treats regex characters literally', () => {
    expect(globMatches('a.b+(c)', 'a.b+(c)')).toBe(true);
    expect(globMatches('a.b', 'axb')).toBe(false);
  });
});

describe('policyText', () => {
  const a = automationSchema.parse({});
  it('describes each level in pt-BR and ends with the report_card line', () => {
    for (const autonomy of ['pr', 'merge', 'deploy', 'release'] as const) {
      const t = policyText({ ...a, autonomy }, 'CI e Deploy');
      expect(t).toContain(autonomy);
      expect(t.endsWith('O merge é feito pelo termhub quando o CI fica verde e a política permite; abra o PR e avise com report_card.')).toBe(true);
    }
  });
  it('says stores are never done and lists protected paths', () => {
    const t = policyText({ ...a, autonomy: 'release', release_paths: ['apps/agent/**'], store_paths: ['apps/mobile/app.json'] }, null);
    expect(t).toContain('loja');
    expect(t).toContain('apps/agent/**');
    expect(t).toContain('apps/mobile/app.json');
  });
  it('says what a PR with no CI gets at merge level or above (TER-1188)', () => {
    expect(policyText({ ...a, autonomy: 'pr' }, null)).not.toContain('PR sem CI');
    expect(policyText({ ...a, autonomy: 'merge' }, null)).toContain('PR sem CI: o termhub não mescla sozinho');
    expect(policyText({ ...a, autonomy: 'merge', no_ci_merge: 'merge' }, null)).toContain('o termhub mescla o PR 2 minutos depois do último push');
  });
});

// Spec 2026-10-07 multi-repo §9: the repositories and their levels, the run's first, kept by the prompt's clip.
describe('policyText with several repositories', () => {
  const row = (full_name: string, key: string) => ({ id: key, project_id: 'p1', full_name, key, description: null, status: 'ok' as const, discovered_at: '', updated_at: '', checkouts: [] });
  const setup = setupSchema.parse({
    repo: { integration_id: 'i1', full_name: 'acme/app', deploy_workflow: 'deploy-prod.yml' },
    repos: [{ full_name: 'acme/bff', autonomy: 'merge', release_paths: ['package.json'] }, { full_name: 'acme/old', enabled: false }],
    automation: { enabled: true, autonomy: 'deploy' },
  });
  const entries = effectiveRepos(setup, [row('acme/app', 'app'), row('acme/bff', 'bff'), row('acme/old', 'old')]);

  it('lists each active repository with its level and deploy, the run\'s first, and leaves a disabled one out', () => {
    const t = policyText(setup.automation, 'deploy-prod.yml', policyRepos(entries, ['acme/bff']));
    const lines = t.split('\n');
    expect(lines[0]).toContain('Autonomia do projeto: deploy');
    expect(lines.slice(1, 4)).toEqual([
      'Repositórios (o nível de cada um nunca passa o do projeto):',
      '- bff (acme/bff): merge; release em package.json',
      '- app (acme/app): deploy; deploy "deploy-prod.yml"',
    ]);
    expect(t).not.toContain('acme/old');
  });

  it('the run\'s prompt lists the run\'s repository only', () => {
    const repos = runPolicyRepos(entries, runEntry(entries, setup));
    expect(repos?.map((r) => r.full_name)).toEqual(['acme/app']);
    expect(policyText(setup.automation, 'deploy-prod.yml', repos)).not.toContain('acme/bff');
  });

  it('a single-repo project reads the text as before', () => {
    const one = effectiveRepos(setup, [row('acme/app', 'app')]).filter((e) => e.full_name === 'acme/app');
    expect(policyRepos(one)).toBeUndefined();
    expect(runPolicyRepos(one, one[0]!)).toBeUndefined();
    expect(policyText(setup.automation, 'deploy-prod.yml', policyRepos(one))).toBe(policyText(setup.automation, 'deploy-prod.yml'));
  });
});
