import { describe, expect, it } from 'vitest';
import { setupSchema } from '../setup/schema.js';
import { automationChangeWidens, automationPatchOf, changedFields, hasAutomationPatch } from './setup-patch.js';

const base = setupSchema.parse({}).automation;
const on = { ...base, enabled: true, autonomy: 'deploy' as const, max_parallel: 2, release_paths: ['apps/agent/package.json'] };

describe('automationChangeWidens (TER-975)', () => {
  it('asks to turn it on, whatever the level', () => {
    expect(automationChangeWidens(base, { ...base, enabled: true })).toBe(true);
  });

  it('asks for any raise of the level, also pr to merge and also while it is off', () => {
    expect(automationChangeWidens(on, { ...on, autonomy: 'release' })).toBe(true);
    expect(automationChangeWidens({ ...on, autonomy: 'pr' }, { ...on, autonomy: 'merge' })).toBe(true);
    expect(automationChangeWidens(base, { ...base, autonomy: 'merge' })).toBe(true);
  });

  it('asks for a change to a path, workflow or check list, and for a higher or lifted max_parallel', () => {
    expect(automationChangeWidens(on, { ...on, release_paths: [] })).toBe(true);
    expect(automationChangeWidens(on, { ...on, store_paths: ['apps/mobile/app.json'] })).toBe(true);
    expect(automationChangeWidens(on, { ...on, release_workflows: ['Publish'] })).toBe(true);
    expect(automationChangeWidens(on, { ...on, required_checks: ['CI'] })).toBe(true);
    expect(automationChangeWidens(on, { ...on, max_parallel: 3 })).toBe(true);
    expect(automationChangeWidens(on, { ...on, max_parallel: null })).toBe(true);
  });

  it('never asks for a brake: off, a lower level, a lower max_parallel, or nothing changing', () => {
    expect(automationChangeWidens(on, { ...on, enabled: false })).toBe(false);
    expect(automationChangeWidens(on, { ...on, autonomy: 'pr' })).toBe(false);
    expect(automationChangeWidens(on, { ...on, max_parallel: 1 })).toBe(false);
    expect(automationChangeWidens({ ...on, max_parallel: null }, { ...on, max_parallel: 5 })).toBe(false);
    expect(automationChangeWidens(on, { ...on, enabled: false, autonomy: 'merge', max_parallel: 1 })).toBe(false);
    expect(automationChangeWidens(on, { ...on })).toBe(false);
  });

  it('a brake combined with a widening asks', () => {
    expect(automationChangeWidens(on, { ...on, enabled: false, release_paths: [] })).toBe(true);
    expect(automationChangeWidens(on, { ...on, autonomy: 'pr', max_parallel: 10 })).toBe(true);
  });

  it('compares lists as sets: the same paths in another order are no change', () => {
    const two = { ...on, release_paths: ['a', 'b'] };
    expect(changedFields(two, { ...two, release_paths: ['b', 'a'] })).toEqual([]);
    expect(automationChangeWidens(two, { ...two, release_paths: ['b', 'a'] })).toBe(false);
  });
});

describe('automationPatchOf', () => {
  it('keeps only the patch fields that are present', () => {
    expect(automationPatchOf({ project_id: 'p1', enabled: false, max_parallel: null, types: ['spike'] })).toEqual({ enabled: false, max_parallel: null });
    expect(hasAutomationPatch({ project_id: 'p1' })).toBe(false);
    expect(hasAutomationPatch({ project_id: 'p1', max_parallel: null })).toBe(true);
  });
});
