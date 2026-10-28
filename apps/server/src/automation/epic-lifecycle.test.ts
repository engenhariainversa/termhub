import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { Project, Task } from '../db/repositories/types.js';
import { setupSchema, type ProjectSetupData } from '../setup/schema.js';
import { epicBorn, followExternalMerges, settleEpic } from './epic-lifecycle.js';

const BRANCH = 'epic/TER-1-identidade';
const project = { id: 'p1', owner_id: 'u1', key: 'TER', name: 'termhub' } as Project;
const setup = (repo: Record<string, unknown> = {}): ProjectSetupData =>
  setupSchema.parse({ repo: { integration_id: 'i1', full_name: 'o/r', base_branch: 'main', deploy_workflow: 'deploy.yml', ...repo }, automation: { enabled: true, autonomy: 'release' } });
const task = (over: Partial<Task> & { id: string }): Task => ({
  project_id: 'p1', type: 'story', number: 2, ref: `TER-${over.id}`, title: over.id, description: null, status: 'done', position: 0, external_ref: null, external_key: null,
  tab_id: null, parent_id: null, epic_id: 'e1', column_id: null, auto: true, created_at: '2026-10-28T10:00:00.000Z', updated_at: '2026-10-28T10:00:00.000Z', ...over,
});
const epic = (over: Partial<Task> = {}) => task({ id: 'e1', ref: 'TER-1', title: 'Identidade', type: 'epic', epic_id: null, status: 'doing', ...over });
const pr = (over: Partial<TaskPullRequest>): TaskPullRequest => ({
  id: 'x', project_id: 'p1', task_id: 'e1', repo: 'o/r', number: 50, url: 'https://github.com/o/r/pull/50', title: 'TER-1: integrate', head_ref: BRANCH, head_sha: 'h', base_ref: 'main',
  state: 'merged', draft: false, merged_at: new Date('2026-10-28T12:00:00Z'), merge_commit_sha: 'm', ci_state: 'passed', ci_summary: { total: 0, passed: 0, failed: 0, running: 0, failing: [] },
  deploy_state: 'passed', deploy_url: null, release_runs: [], changed_level: 'deploy', mention_only: false, synced_at: '', ...over,
});

function world(o: { tasks: Task[]; prs: TaskPullRequest[]; branches?: Record<string, string[]> }) {
  const events: Array<{ kind: string; task_id: string | null; payload: Record<string, unknown> }> = [];
  const byId = new Map(o.tasks.map((t) => [t.id, t]));
  const repos = {
    tasks: {
      findById: vi.fn(async (id: string) => byId.get(id)),
      move: vi.fn(async (id: string, target: { status: Task['status'] }) => {
        const t = { ...byId.get(id)!, status: target.status };
        byId.set(id, t);
        return t;
      }),
      startWork: vi.fn(async (id: string) => {
        const t = { ...byId.get(id)!, status: 'doing' as const };
        byId.set(id, t);
        return t;
      }),
    },
    taskPullRequests: { listByTasks: vi.fn(async (ids: string[]) => o.prs.filter((p) => ids.includes(p.task_id))) },
    automationRuns: {
      markCleanupDue: vi.fn(async () => []),
      activeByProject: vi.fn(async () => []),
      branchesOfTask: vi.fn(async (id: string) => o.branches?.[id] ?? []),
    },
    automationEvents: {
      insert: vi.fn(async (e: { kind: string; task_id: string | null; payload: Record<string, unknown> }) => {
        events.push(e);
        return { id: `ev${events.length}`, created_at: '', ...e };
      }),
    },
    projects: { findById: vi.fn(async () => project) },
    integrations: { findById: vi.fn(async () => ({ id: 'i1', provider: 'github', owner_id: 'u1' })), getSecret: vi.fn(async () => 'tok') },
  } as unknown as Repositories;
  const gh = { deleteBranch: vi.fn(async () => 'deleted' as const) };
  return { repos, gh, events, byId };
}

describe('epicBorn (TER-1150)', () => {
  it('the first card of an epic in the backlog moves it to Fazendo and records when, where and by whom', async () => {
    const e = epic({ status: 'backlog' });
    const card = task({ id: '7', status: 'doing' });
    const w = world({ tasks: [e, card], prs: [] });
    expect(await epicBorn({ repos: w.repos }, e, card, BRANCH)).toBe(true);
    expect(w.repos.tasks.startWork).toHaveBeenCalledWith('e1');
    expect(w.events).toEqual([expect.objectContaining({ kind: 'epic_started', task_id: 'e1', payload: { branch: BRANCH, by: 'TER-7', card_id: '7' } })]);
  });

  it('once: an epic already in Fazendo or Feito, or a manual one, is left where it is', async () => {
    for (const e of [epic({ status: 'doing' }), epic({ status: 'done' }), epic({ status: 'todo', auto: false })]) {
      const w = world({ tasks: [e], prs: [] });
      expect(await epicBorn({ repos: w.repos }, e, task({ id: '7' }), BRANCH)).toBe(false);
      expect(w.repos.tasks.startWork).not.toHaveBeenCalled();
      expect(w.events).toEqual([]);
    }
  });
});

describe('settleEpic (TER-1150)', () => {
  const stories = [task({ id: '2' }), task({ id: '3' })];

  it('merged and deployed: the epic goes to Feito, its branch is deleted, its runs are due for cleanup, epic_done', async () => {
    const e = epic();
    const w = world({ tasks: [e, ...stories], prs: [pr({})] });
    expect(await settleEpic({ repos: w.repos, gh: w.gh }, project, setup(), e, [e, ...stories])).toBe(true);
    expect(w.repos.tasks.move).toHaveBeenCalledWith('e1', { status: 'done' }, 0);
    expect(w.gh.deleteBranch).toHaveBeenCalledWith('tok', 'o/r', BRANCH);
    expect(w.repos.automationRuns.markCleanupDue).toHaveBeenCalledWith(['e1', '2', '3']);
    expect(w.events).toEqual([expect.objectContaining({ kind: 'epic_done', task_id: 'e1', payload: { branch: BRANCH, branch_deleted: true, pr: 50, url: 'https://github.com/o/r/pull/50' } })]);
  });

  it('never dies while integrating, delivering or failed, nor with a story out of Feito', async () => {
    const cases: Array<{ tasks: Task[]; prs: TaskPullRequest[] }> = [
      { tasks: stories, prs: [pr({ state: 'open', merged_at: null })] }, // integrating
      { tasks: stories, prs: [pr({ deploy_state: 'running' })] }, // delivering
      { tasks: stories, prs: [pr({ deploy_state: 'failed' })] }, // deploy failed: back to work, never done
      { tasks: [task({ id: '2' }), task({ id: '3', status: 'doing' })], prs: [pr({})] },
      { tasks: stories, prs: [] },
    ];
    for (const c of cases) {
      const e = epic();
      const w = world({ tasks: [e, ...c.tasks], prs: c.prs });
      expect(await settleEpic({ repos: w.repos, gh: w.gh }, project, setup(), e, [e, ...c.tasks])).toBe(false);
      expect(w.repos.tasks.move).not.toHaveBeenCalled();
      expect(w.gh.deleteBranch).not.toHaveBeenCalled();
      expect(w.events).toEqual([]);
    }
  });

  it('a branch GitHub already deleted, or one it refuses to delete, still lets the epic die', async () => {
    const e = epic();
    const w = world({ tasks: [e, ...stories], prs: [pr({})] });
    w.gh.deleteBranch.mockRejectedValueOnce(Object.assign(new Error('nope'), { kind: 'http' }));
    expect(await settleEpic({ repos: w.repos, gh: w.gh }, project, setup(), e, [e, ...stories])).toBe(true);
    expect(w.events[0]).toMatchObject({ kind: 'epic_done', payload: { branch_deleted: false } });
  });
});

describe('followExternalMerges (TER-1150)', () => {
  it('a card PR merged on GitHub by a person moves the card to Feito like the executor', async () => {
    const card = task({ id: '7', status: 'doing', updated_at: '2026-10-28T11:00:00.000Z' });
    const w = world({ tasks: [card], prs: [pr({ task_id: '7', number: 61, head_ref: 'TER-7-x', base_ref: BRANCH })], branches: { '7': ['TER-7-x'] } });
    expect(await followExternalMerges({ repos: w.repos }, project, setup(), [card])).toBe(1);
    expect(w.repos.tasks.move).toHaveBeenCalledWith('7', { status: 'done' }, 0);
    expect(w.repos.automationRuns.markCleanupDue).toHaveBeenCalledWith(['7']);
    expect(w.events).toEqual([expect.objectContaining({ kind: 'merged', task_id: '7', payload: expect.objectContaining({ pr: 61, by: 'external', moved_to_done: true }) })]);
  });

  it('leaves a card moved back after its merge, a PR its runs did not make, a manual card and one with an open PR', async () => {
    const merged = pr({ task_id: '7', number: 61, head_ref: 'TER-7-x' });
    const cases: Array<{ card: Task; prs: TaskPullRequest[]; branches: string[] }> = [
      { card: task({ id: '7', status: 'doing', updated_at: '2026-10-28T13:00:00.000Z' }), prs: [merged], branches: ['TER-7-x'] },
      { card: task({ id: '7', status: 'doing', updated_at: '2026-10-28T11:00:00.000Z' }), prs: [merged], branches: ['other'] },
      { card: task({ id: '7', status: 'doing', auto: false, updated_at: '2026-10-28T11:00:00.000Z' }), prs: [merged], branches: ['TER-7-x'] },
      { card: task({ id: '7', status: 'doing', updated_at: '2026-10-28T11:00:00.000Z' }), prs: [merged, pr({ task_id: '7', number: 62, state: 'open', head_ref: 'TER-7-y' })], branches: ['TER-7-x'] },
    ];
    for (const c of cases) {
      const w = world({ tasks: [c.card], prs: c.prs, branches: { '7': c.branches } });
      expect(await followExternalMerges({ repos: w.repos }, project, setup(), [c.card])).toBe(0);
      expect(w.repos.tasks.move).not.toHaveBeenCalled();
    }
  });
});
