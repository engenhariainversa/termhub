import { describe, expect, it } from 'vitest';
import { automationSchema } from '../setup/schema.js';
import { allows, globMatches, policyText, requiredLevel } from './policy.js';

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
});
