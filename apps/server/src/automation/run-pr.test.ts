import { describe, expect, it } from 'vitest';
import { inRunRepo, isRunHead, runRepoOf } from './run-pr.js';

describe('the repository a run works on (spec 2026-10-07 multi-repo R14)', () => {
  it('is the project repository of Setup, or none', () => {
    expect(runRepoOf({ repo: { full_name: 'acme/app' } } as never)).toBe('acme/app');
    expect(runRepoOf({ repo: { full_name: '' } } as never)).toBeNull();
    expect(runRepoOf({ repo: null } as never)).toBeNull();
    expect(runRepoOf({} as never)).toBeNull();
  });

  it('a PR is the head of a run only in that repository, whatever the case of the name', () => {
    expect(isRunHead('acme/app', ['TER-12-x'], { repo: 'acme/app', head_ref: 'TER-12-x' })).toBe(true);
    expect(isRunHead('Acme/App', ['TER-12-x'], { repo: 'acme/app', head_ref: 'TER-12-x' })).toBe(true);
    expect(isRunHead('acme/app', ['TER-12-x'], { repo: 'acme/site', head_ref: 'TER-12-x' })).toBe(false);
    expect(isRunHead('acme/app', ['TER-12-x'], { repo: 'acme/app', head_ref: 'TER-12-y' })).toBe(false);
    expect(isRunHead('acme/app', [], { repo: 'acme/app', head_ref: 'TER-12-x' })).toBe(false);
  });

  it('with no project repository the branch alone decides', () => {
    expect(inRunRepo(null, 'acme/site')).toBe(true);
    expect(isRunHead(null, ['TER-12-x'], { repo: 'acme/site', head_ref: 'TER-12-x' })).toBe(true);
    expect(isRunHead(null, ['TER-12-x'], { repo: 'acme/site', head_ref: 'other' })).toBe(false);
  });
});
