import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { runPermission } from './permission.js';

const run = { id: 'r1', project_id: 'p1', allowed_tools: ['Bash(npm test:*)'], branch: 'TER-1-x', worktree_path: '/w/p1/TER-1' };
const reposWith = (rows: Array<{ worktree_path: string }>) => ({ automationRunRepos: { listByRun: vi.fn(async () => rows) } }) as unknown as Repositories;

describe('runPermission (multi-repo Task 12)', () => {
  it("a workspace run keeps its repositories' keys on every restart, read from its rows", async () => {
    const p = await runPermission(reposWith([{ worktree_path: '/w/p1/TER-1/api' }, { worktree_path: '/w/p1/TER-1/web' }]), run);
    expect(p).toMatchObject({ branch: 'TER-1-x', worktree: '/w/p1/TER-1', repoKeys: ['api', 'web'] });
  });

  it('a run in one repository has no keys, as before', async () => {
    expect(await runPermission(reposWith([{ worktree_path: '/w/p1/TER-1' }]), run)).not.toHaveProperty('repoKeys');
    expect(await runPermission(reposWith([]), run)).not.toHaveProperty('repoKeys');
    // a fake without the table, or a run with no worktree, reads nothing
    expect(await runPermission({} as Repositories, run)).not.toHaveProperty('repoKeys');
    expect(await runPermission(reposWith([{ worktree_path: '/x/a' }, { worktree_path: '/x/b' }]), { ...run, worktree_path: null })).not.toHaveProperty('repoKeys');
  });
});
