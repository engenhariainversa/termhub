import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlContext } from '../control/context.js';
import { GithubCiError } from '../integrations/github-ci.js';
import { setupSchema } from '../setup/schema.js';
import { needsPrCiWarning, projectPrCi, resetPrCiCache } from './pr-ci.js';

function ctx(repo: Record<string, unknown> | null = { integration_id: 'i1', full_name: 'acme/app' }) {
  const setup = setupSchema.parse({ repo, automation: { enabled: true, autonomy: 'merge' } });
  return {
    repos: {
      projectSetup: { get: vi.fn(async () => ({ data: setup })) },
      integrations: { findById: vi.fn(async () => ({ id: 'i1', provider: 'github', owner_id: 'u1' })), getSecret: vi.fn(async () => 'tok') },
    },
    scoped: { project: vi.fn(async (id: string) => ({ project: { id, owner_id: 'u1' } })) },
  } as unknown as ControlContext;
}

beforeEach(() => resetPrCiCache());

describe('projectPrCi (TER-1114)', () => {
  it('present when a workflow ran on pull_request or pull_request_target, absent when none did', async () => {
    const some = { hasRunsFor: vi.fn(async (_t: string, _r: string, e: string) => e === 'pull_request_target') };
    expect(await projectPrCi(ctx(), 'p1', some)).toBe('present');
    expect(some.hasRunsFor).toHaveBeenCalledWith('tok', 'acme/app', 'pull_request');
    resetPrCiCache();
    expect(await projectPrCi(ctx(), 'p1', { hasRunsFor: vi.fn(async () => false) })).toBe('absent');
  });

  it('reads GitHub once per repository within the cache, and says unknown without GitHub or on an error', async () => {
    const gh = { hasRunsFor: vi.fn(async () => false) };
    await projectPrCi(ctx(), 'p1', gh, 0);
    await projectPrCi(ctx(), 'p1', gh, 60_000);
    expect(gh.hasRunsFor).toHaveBeenCalledTimes(2); // both events, on the first read only
    expect(await projectPrCi(ctx(null), 'p2', gh)).toBe('unknown');
    resetPrCiCache();
    expect(await projectPrCi(ctx(), 'p1', { hasRunsFor: vi.fn(async () => Promise.reject(new GithubCiError('http', 502))) })).toBe('unknown');
  });

  it('warns at merge level or above only', () => {
    expect(needsPrCiWarning({ autonomy: 'merge' }, 'absent')).toBe(true);
    expect(needsPrCiWarning({ autonomy: 'release' }, 'absent')).toBe(true);
    expect(needsPrCiWarning({ autonomy: 'pr' }, 'absent')).toBe(false);
    expect(needsPrCiWarning({ autonomy: 'merge' }, 'unknown')).toBe(false);
  });
});
