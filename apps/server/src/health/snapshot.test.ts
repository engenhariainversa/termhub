import { describe, expect, it, vi } from 'vitest';

vi.mock('../automation/pause.js', () => ({ isPaused: vi.fn(async () => false) }));
vi.mock('../automation/queue.js', () => ({ automationQueue: vi.fn(async () => []) }));
vi.mock('../automation/merge-wait.js', () => ({ baseReadingOf: vi.fn(() => null), mergeWaitOf: vi.fn(() => null), mergeWaitEntryOf: vi.fn(() => null) }));
vi.mock('../control/context.js', () => ({ controlContextFor: vi.fn(() => ({})) }));

import type { Repositories } from '../db/repositories/index.js';
import type { Project, User } from '../db/repositories/types.js';
import { setupSchema } from '../setup/schema.js';
import { buildSnapshot } from './snapshot.js';

const card = (id: string, column_id: string) => ({ id, ref: `TER-${id}`, title: id, status: 'doing', parent_id: null, type: 'task', column_id, tab_id: null, auto: true, updated_at: '2026-10-27T10:00:00.000Z' });

describe('buildSnapshot (TER-1134)', () => {
  it('leaves the cards of a waiting column out of Doing: they are never orphans', async () => {
    const repos = {
      tasks: { listByProject: vi.fn(async () => [card('1', 'doing'), card('2', 'wait')]) },
      taskColumns: { list: vi.fn(async () => [{ id: 'doing', category: 'doing', waiting: false }, { id: 'wait', category: 'doing', waiting: true }]) },
      tabs: { listByProject: vi.fn(async () => []) },
      automationRuns: { activeByProject: vi.fn(async () => []), lastStartedAt: vi.fn(async () => null), latestOfTask: vi.fn(async () => null) },
      projectMachines: { listByProject: vi.fn(async () => []) },
      taskPullRequests: { listForHealth: vi.fn(async () => []) },
    } as unknown as Repositories;
    const setup = setupSchema.parse({ automation: { enabled: true } });
    const s = await buildSnapshot(repos, { id: 'p1', owner_id: 'u1' } as Project, { id: 'u1', locale: 'pt-BR' } as User, setup, new Date('2026-10-27T12:00:00Z'));
    expect(s.doing.map((c) => c.ref)).toEqual(['TER-1']);
  });

  // TER-1150
  it('an automatic epic in Fazendo: alive with a card in Doing or a delivery still followed; a card in Feito with an open PR', async () => {
    const now = new Date('2026-10-28T12:00:00Z');
    const epic = { ...card('1', 'doing'), type: 'epic', epic_id: null };
    const story = { ...card('2', 'done'), status: 'done', epic_id: '1' };
    const pr = (over: Record<string, unknown>) => ({
      task_id: '1', url: 'https://github.com/o/r/pull/9', repo: 'o/r', number: 9, title: 'x', state: 'merged', draft: false, ci_state: 'passed', base_ref: 'main', head_ref: 'epic/TER-1-1',
      merged_at: new Date('2026-10-28T10:00:00Z'), deploy_state: 'running', deploy_url: null, release_runs: [], changed_level: 'deploy', mention_only: false, ...over,
    });
    const build = async (prs: unknown[]) => {
      const repos = {
        tasks: { listByProject: vi.fn(async () => [epic, story]) },
        taskColumns: { list: vi.fn(async () => [{ id: 'doing', category: 'doing', waiting: false }]) },
        tabs: { listByProject: vi.fn(async () => []) },
        automationRuns: { activeByProject: vi.fn(async () => []), lastStartedAt: vi.fn(async () => null), latestOfTask: vi.fn(async () => null) },
        projectMachines: { listByProject: vi.fn(async () => []) },
        taskPullRequests: { listForHealth: vi.fn(async () => prs) },
      } as unknown as Repositories;
      const setup = setupSchema.parse({ repo: { integration_id: 'i1', full_name: 'o/r', deploy_workflow: 'deploy.yml' }, automation: { enabled: true } });
      return buildSnapshot(repos, { id: 'p1', owner_id: 'u1' } as Project, { id: 'u1', locale: 'pt-BR' } as User, setup, now);
    };
    expect((await build([pr({})])).epics).toEqual([expect.objectContaining({ task_id: '1', active_card: false, open_pr: true })]);
    // the sync stopped following the deploy a day after the merge: nothing alive any more
    expect((await build([pr({ merged_at: new Date('2026-10-27T10:00:00Z') })])).epics?.[0]?.open_pr).toBe(false);
    const s = await build([pr({ task_id: '2', state: 'open', merged_at: null, ci_state: 'failed', number: 12, url: 'u12' })]);
    expect(s.done_unmerged).toEqual([expect.objectContaining({ task_id: '2', ref: 'TER-2', number: 12, ci_state: 'failed' })]);
  });
});
