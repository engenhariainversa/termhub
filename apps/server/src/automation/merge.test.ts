import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ciErrorOf, setCiError } from '../ci/status.js';
import type { WorkflowRun } from '../ci/rules.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import { GithubCiError } from '../integrations/github-ci.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { setupSchema, type ProjectSetupData } from '../setup/schema.js';
import { epicBranchName } from './branches.js';
import { mergeApproved, mergeKey, MERGE_TOOL, runMergeExecutor, type MergeDeps } from './merge.js';
import { mergeWaitOf, resetMergeWaits } from './merge-wait.js';

// The card's sentence is built from many repositories; what matters here is that the card is asked and published.
vi.mock('../db/repositories/chat-actions-view.js', () => ({ describeActions: vi.fn(async (_r: unknown, rows: ChatAction[]) => rows.map(() => ({ summary: 's', subagent: null }))) }));

const EPIC = { id: 'e1', ref: 'TER-1', title: 'Termhub agêntico', auto: true, type: 'epic', epic_id: null, project_id: 'p1' };
const EPIC_BRANCH = epicBranchName('epic/{ref}-{slug}', EPIC);
const CARD = { id: 'c1', ref: 'TER-5', title: 'Arrastar cards', auto: true, type: 'story', epic_id: 'e1', project_id: 'p1' };
const LONE = { id: 'c2', ref: 'TER-6', title: 'Card avulso', auto: true, type: 'story', epic_id: 'e2', project_id: 'p1' };
const MANUAL = { id: 'c3', ref: 'TER-7', title: 'Card manual', auto: false, type: 'story', epic_id: 'e1', project_id: 'p1' };
const EPIC2 = { id: 'e2', ref: 'TER-2', title: 'Geral', auto: false, type: 'epic', epic_id: null, project_id: 'p1' };

const run = (name: string, status: string, conclusion: string | null, id = 1): WorkflowRun => ({ id, name, path: `.github/workflows/${name}.yml`, status, conclusion, html_url: `r/${name}`, created_at: '2026-10-05T12:00:00Z' });

const BRANCH: Record<string, string> = { c1: 'TER-5-arrastar-cards', c2: 'TER-6-card-avulso', c3: 'TER-7-card-manual' };

function pr(over: Partial<TaskPullRequest> = {}): TaskPullRequest {
  const task = over.task_id ?? 'c1';
  return {
    id: 'pr1', project_id: 'p1', task_id: 'c1', repo: 'acme/app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Board: drag cards',
    head_ref: BRANCH[task]!, head_sha: 'h1', base_ref: EPIC_BRANCH, state: 'open', draft: false, merged_at: null, merge_commit_sha: null,
    ci_state: 'passed', ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null, release_runs: [], changed_level: null, synced_at: '',
    ...over,
  };
}

function setupWith(automation: Record<string, unknown> = {}, repo: Record<string, unknown> = {}): ProjectSetupData {
  return setupSchema.parse({
    repo: { integration_id: 'i1', full_name: 'acme/app', base_branch: 'main', deploy_workflow: null, ...repo },
    automation: { enabled: true, autonomy: 'merge', ...automation },
  });
}

function world(o: { setup?: ProjectSetupData; prs?: TaskPullRequest[]; paused?: boolean; triggered?: number } = {}) {
  const state = {
    setup: o.setup ?? setupWith(),
    prs: o.prs ?? [pr()],
    paused: o.paused ?? false,
    actions: [] as ChatAction[],
    runs: [] as Array<{ id: string; task_id: string; role: string; trigger_sha: string | null; status: string; waiting_reason: string | null; tab_id: string | null; branch: string | null; fix_count: number; claimed_by?: string; ended_at?: Date | null }>,
    tabs: {} as Record<string, { id: string; state: string | null; state_text: string | null; rate_limited_at: string | null }>,
    openQuestion: false,
    eventSeq: 0,
    events: [] as Array<{ kind: string; task_id?: string | null; payload?: Record<string, unknown> }>,
    messages: [] as string[],
    /** the cards' runs, as the cleanup reads them */
    cleanupRuns: [] as Array<Record<string, unknown>>,
  };
  const tasks: Record<string, object> = { e1: EPIC, e2: EPIC2, c1: CARD, c2: LONE, c3: MANUAL };
  const repos = {
    projectSetup: { get: vi.fn(async () => ({ data: state.setup })) },
    projects: { findById: vi.fn(async (id: string) => ({ id, key: 'TER', name: 'termhub', owner_id: 'u1' })) },
    integrations: { findById: vi.fn(async () => ({ id: 'i1', provider: 'github', owner_id: 'u1' })), getSecret: vi.fn(async () => 'tok') },
    automationPauses: { state: vi.fn(async () => ({ user: null, project: state.paused ? new Date() : null })) },
    taskPullRequests: { listWatched: vi.fn(async () => state.prs), setChangedLevel: vi.fn(async () => {}) },
    machines: { findById: vi.fn(async (id: string) => ({ id, name: 'hulk' })) },
    projectMachines: { find: vi.fn(async () => ({ cwd: '/repo' })) },
    tasks: { listByProject: vi.fn(async () => Object.values(tasks)), findById: vi.fn(async (id: string) => tasks[id]), move: vi.fn(async (id: string) => ({ ...tasks[id], status: 'done' })) },
    users: { findById: vi.fn(async (id: string) => ({ id, locale: 'pt-BR' })) },
    chat: {
      findLatestActiveForProject: vi.fn(async () => ({ id: 'conv1', project_id: 'p1' })),
      getOrCreateForProject: vi.fn(async () => ({ id: 'conv1', project_id: 'p1' })),
      findByIdForUser: vi.fn(async (id: string, userId: string) => (id === 'conv1' && userId === 'u1' ? { id, project_id: 'p1' } : undefined)),
      addMessage: vi.fn(async (m: { text: string }) => {
        state.messages.push(m.text);
        return { id: 'm1', ...m };
      }),
    },
    chatActions: {
      findLatestByKeyInProject: vi.fn(async (_u: string, _p: string, key: string) => [...state.actions].reverse().find((a) => a.idempotency_key === key)),
      findOpenByKey: vi.fn(async () => undefined),
      insertPending: vi.fn(async (i: { conversation_id: string; tool: string; args: unknown; class: string; idempotency_key: string; project_id: string; injected?: boolean }) => {
        const a = { id: `a${state.actions.length + 1}`, conversation_id: i.conversation_id, tool: i.tool, args: i.args, class: i.class, status: 'pending', idempotency_key: i.idempotency_key, project_id: i.project_id, injected_at: i.injected ? 'now' : null, machine_id: null, tab_id: null, created_at: '' } as unknown as ChatAction;
        state.actions.push(a);
        return a;
      }),
      findById: vi.fn(async (id: string) => state.actions.find((a) => a.id === id)),
      claimApproved: vi.fn(async (id: string) => {
        const a = state.actions.find((x) => x.id === id);
        if (a?.status !== 'approved') return false;
        a.status = 'executed';
        return true;
      }),
      markExecuted: vi.fn(async (id: string, ok: boolean, code: string | null) => {
        const a = state.actions.find((x) => x.id === id)!;
        a.status = ok ? 'executed' : 'failed';
        a.error_code = code;
      }),
    },
    automationEvents: {
      insert: vi.fn(async (e: { kind: string }) => {
        state.events.push(e);
        return { id: 'ev', created_at: '', ...e };
      }),
      // the unique index of ci_fix_requested (task, pr, sha); a tick before the check lets two passes interleave
      insertOnce: vi.fn(async (e: { kind: string; task_id: string; payload: Record<string, unknown> }) => {
        await Promise.resolve();
        if (state.events.some((x) => x.kind === e.kind && x.task_id === e.task_id && x.payload?.pr === e.payload.pr && x.payload?.sha === e.payload.sha)) return null;
        const row = { id: `ev${++state.eventSeq}`, created_at: '', ...e };
        state.events.push(row);
        return row;
      }),
      setPayload: vi.fn(async (id: string, payload: Record<string, unknown>) => {
        const row = state.events.find((x) => (x as { id?: string }).id === id);
        if (!row) return null;
        row.payload = payload;
        return row;
      }),
      remove: vi.fn(async (id: string) => {
        state.events = state.events.filter((x) => (x as { id?: string }).id !== id);
      }),
      removeStale: vi.fn(async () => 0),
      findOnce: vi.fn(async (taskId: string, kind: string, match: Record<string, unknown>) => state.events.find((x) => x.kind === kind && x.task_id === taskId && Object.entries(match).every(([k, v]) => x.payload?.[k] === v)) ?? null),
      replacePayloadIf: vi.fn(async (id: string, match: Record<string, unknown>, payload: Record<string, unknown>) => {
        const row = state.events.find((x) => (x as { id?: string }).id === id);
        if (!row || !Object.entries(match).every(([k, v]) => row.payload?.[k] === v)) return null;
        row.payload = payload;
        return row;
      }),
    },
    tabs: { findById: vi.fn(async (id: string) => state.tabs[id]) },
    tabQuestions: { hasOpenQuestion: vi.fn(async () => state.openQuestion) },
    automationRuns: {
      // the branches the cards' automatic runs worked on
      branchesOfTask: vi.fn(async (taskId: string) => (taskId === 'c3' ? [] : [BRANCH[taskId]!])),
      // an epic's integrator runs: one that finished, by default
      triggeredStatuses: vi.fn(async (): Promise<string[]> => ['done']),
      countTriggered: vi.fn(async (taskId: string, role: string, except: string) => (o.triggered ?? 0) + state.runs.filter((r) => r.task_id === taskId && r.role === role && r.trigger_sha && r.waiting_reason !== except).length),
      claim: vi.fn(async (i: { task_id: string; role: string; trigger_sha?: string }) => {
        if (state.runs.some((r) => r.task_id === i.task_id && r.role === i.role && r.trigger_sha === i.trigger_sha)) return null;
        const r = { id: `r${state.runs.length + 1}`, project_id: 'p1', task_id: i.task_id, role: i.role, trigger_sha: i.trigger_sha ?? null, status: 'queued', waiting_reason: null, tab_id: null, branch: null, fix_count: 0, claimed_by: 'test' };
        state.runs.push(r);
        return r;
      }),
      update: vi.fn(async (id: string, _i: string, patch: { status?: string; waiting_reason?: string }) => {
        Object.assign(state.runs.find((r) => r.id === id)!, patch);
        return true;
      }),
      // the conflict escalation's marker: ended at once, one per (card, role, trigger)
      insertMarker: vi.fn(async (i: { task_id: string; role: string; trigger_sha: string; waiting_reason: string }) => {
        if (state.runs.some((r) => r.task_id === i.task_id && r.role === i.role && r.trigger_sha === i.trigger_sha)) return null;
        const r = { id: `r${state.runs.length + 1}`, project_id: 'p1', task_id: i.task_id, role: i.role, trigger_sha: i.trigger_sha, status: 'blocked', waiting_reason: i.waiting_reason, tab_id: null, branch: null, fix_count: 0, claimed_by: 'test', ended_at: new Date('2026-10-05T12:00:00Z') };
        state.runs.push(r);
        return r;
      }),
      updateActive: vi.fn(async (id: string, _i: string, patch: { status?: string; waiting_reason?: string | null; ended_at?: Date }) => {
        const r = state.runs.find((x) => x.id === id);
        if (!r || !['queued', 'starting', 'running', 'waiting'].includes(r.status)) return false;
        Object.assign(r, patch);
        return true;
      }),
      lastEndedAt: vi.fn(async (taskId: string) => {
        const ends = state.runs.filter((r) => r.task_id === taskId && r.ended_at).map((r) => r.ended_at!.getTime());
        return ends.length > 0 ? new Date(Math.max(...ends)) : null;
      }),
      activeByProject: vi.fn(async () => state.runs.filter((r) => ['queued', 'starting', 'running', 'waiting'].includes(r.status))),
      sumFixCount: vi.fn(async (taskId: string) => state.runs.filter((r) => r.task_id === taskId).reduce((n, r) => n + r.fix_count, 0)),
      bump: vi.fn(async (id: string) => ++state.runs.find((r) => r.id === id)!.fix_count),
      noteTyped: vi.fn(async () => {}),
      markCleanupDue: vi.fn(async (ids: string[]) => {
        for (const r of state.cleanupRuns) if (ids.includes(r.task_id as string) && r.cleanup_state === null) r.cleanup_state = 'due';
        return state.cleanupRuns.filter((r) => ids.includes(r.task_id as string) && r.cleanup_state === 'due');
      }),
      settleCleanup: vi.fn(async (id: string, st: string) => {
        const r = state.cleanupRuns.find((x) => x.id === id)!;
        if (r.cleanup_state !== 'due') return false;
        r.cleanup_state = st;
        return true;
      }),
      bumpCleanup: vi.fn(async (id: string) => ++(state.cleanupRuns.find((x) => x.id === id)!.cleanup_attempts as number)),
    },
  } as unknown as Repositories;

  // GitHub's view of the first PR: the run's branch, from this repository, into the row's base
  const pullFor = (over: Record<string, unknown> = {}) => ({
    mergeable: true as boolean | null,
    mergeable_state: 'clean',
    head_sha: 'h1',
    head_ref: state.prs[0]?.head_ref ?? BRANCH.c1!,
    head_repo: 'acme/app' as string | null,
    base_ref: state.prs[0]?.base_ref ?? EPIC_BRANCH,
    ...over,
  });
  const gh = {
    pull: vi.fn(async () => pullFor()),
    compare: vi.fn(async () => ({ ahead_by: 1, behind_by: 0 })),
    files: vi.fn(async () => ({ paths: ['apps/web/src/Board.tsx'], complete: true })),
    merge: vi.fn(async () => ({ merged: true, sha: 'm1' })),
    updateBranch: vi.fn(async () => true),
    branchSha: vi.fn(async () => 'base1'),
    createBranch: vi.fn(),
    openPull: vi.fn(),
    findOpenPull: vi.fn(),
  };
  const ci = { listRuns: vi.fn(async (_t: string, _r: string, _sha: string): Promise<WorkflowRun[]> => [run('ci', 'completed', 'success')]) };
  // a started fixer is a run keyed by the head; it ends at once here (each test drives the runs it needs active)
  const startFixer = vi.fn(async (i: { taskId: string; triggerSha: string; branch: string }): Promise<'started' | 'taken' | 'waiting' | 'halted'> => {
    state.runs.push({ id: `r${state.runs.length + 1}`, task_id: i.taskId, role: 'fixer', trigger_sha: i.triggerSha, status: 'done', waiting_reason: null, tab_id: null, branch: i.branch, fix_count: 0 });
    return 'started';
  });
  const type = vi.fn(async (_ctx: unknown, _tab: string, _text: string) => {});
  const lifecycle = { draining: false };
  // one green reading already seen for h1: the merge happens on this pass (the two-readings rule has its own test)
  const seen = new Map([['p1:acme/app#7', 'h1']]);
  const removeWorkspace = vi.fn(async (_m: unknown, _i: { repoDir: string; root: string; path: string }) => ({ removed: true, dirty: false }));
  const closeTab = vi.fn(async (_ctx: unknown, _tabId: string) => {});
  const deps: MergeDeps = { repos, gh: gh as unknown as GithubWriteClient, ci, lifecycle, instance: 'test', startFixer, type, seen, removeWorkspace: removeWorkspace as unknown as MergeDeps['removeWorkspace'], closeTab, now: () => new Date('2026-10-05T12:00:00Z') };
  return { state, repos, gh, ci, startFixer, type, lifecycle, seen, deps, pullFor, removeWorkspace, closeTab };
}

const approve = (a: ChatAction) => {
  a.status = 'approved';
};

beforeEach(() => {
  resetMergeWaits();
  setCiError('p1', null);
});

describe('runMergeExecutor', () => {
  it('green + merge level into the epic branch: squash-merges with the PR title, records merged, moves the card to done, tells the chat', async () => {
    const w = world();
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
    expect(w.gh.merge).toHaveBeenCalledWith('tok', 'acme/app', 7, { sha: 'h1', title: 'Board: drag cards (#7)', method: 'squash' });
    expect(w.repos.taskPullRequests.setChangedLevel).toHaveBeenCalledWith('p1', 'acme/app', 7, 'merge');
    expect(w.repos.tasks.move).toHaveBeenCalledWith('c1', { status: 'done' }, 0);
    expect(w.state.events).toEqual([expect.objectContaining({ kind: 'merged', task_id: 'c1', payload: expect.objectContaining({ pr: 7, sha: 'm1', level: 'merge', by: 'policy', moved_to_done: true }) })]);
    expect(w.state.messages).toEqual(['Automático mesclou o PR #7 de TER-5: https://github.com/acme/app/pull/7']);
    expect(w.state.actions).toHaveLength(0);
  });

  it('into main with a deploy workflow at level merge: an irreversible approval card, asked once per head, and never a merge', async () => {
    const w = world({ setup: setupWith({}, { deploy_workflow: 'deploy.yml' }), prs: [pr({ task_id: 'c2', base_ref: 'main' })] });
    await runMergeExecutor(w.deps, 'p1');
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(w.state.actions).toHaveLength(1);
    expect(w.state.actions[0]).toMatchObject({ tool: MERGE_TOOL, class: 'irreversible', status: 'pending', idempotency_key: mergeKey('acme/app', 7, 'h1', 'main'), project_id: 'p1', injected_at: 'now' });
    expect(w.state.actions[0]!.args).toMatchObject({ project_id: 'p1', repo: 'acme/app', number: 7, head_sha: 'h1', needed: 'deploy' });
    expect(w.state.events).toEqual([expect.objectContaining({ kind: 'merge_needs_approval', task_id: 'c2', payload: expect.objectContaining({ pr: 7, needed: 'deploy', action_id: 'a1' }) })]);
    expect(mergeWaitOf('c2', new Date('2026-10-05T12:00:00Z'))).toBe('merge_needs_approval');
  });

  it('a store path (written ./…) at release: an approval card that says it needs a store build, never merged', async () => {
    const w = world({ setup: setupWith({ autonomy: 'release', store_paths: ['apps/mobile/app.json'] }) });
    w.gh.files.mockResolvedValue({ paths: ['./apps/mobile/app.json', 'apps/web/x.ts'], complete: true });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(w.state.actions[0]!.args).toMatchObject({ needed: 'store' });
    expect(w.state.events[0]).toMatchObject({ kind: 'merge_needs_approval', payload: expect.objectContaining({ needed: 'store', text: 'precisa de build nas lojas' }) });
    expect(w.repos.taskPullRequests.setChangedLevel).toHaveBeenCalledWith('p1', 'acme/app', 7, 'store');
    expect(mergeWaitOf('c1', new Date('2026-10-05T12:00:00Z'))).toBe('merge_store');
  });

  it('an incomplete or empty file list needs approval, at any level', async () => {
    for (const files of [{ paths: ['apps/web/x.ts'], complete: false }, { paths: [], complete: true }]) {
      const w = world({ setup: setupWith({ autonomy: 'release' }) });
      w.gh.files.mockResolvedValue(files);
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.merge).not.toHaveBeenCalled();
      expect(w.state.actions[0]!.args).toMatchObject({ needed: 'files_incomplete' });
    }
  });

  it('no CI at all, or CI still running, does nothing here', async () => {
    for (const ci_state of ['none', 'running'] as const) {
      const w = world({ prs: [pr({ ci_state })] });
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.pull).not.toHaveBeenCalled();
      expect(w.gh.merge).not.toHaveBeenCalled();
      expect(w.state.actions).toHaveLength(0);
      expect(w.startFixer).not.toHaveBeenCalled();
      expect(w.type).not.toHaveBeenCalled();
    }
  });

  it('without required_checks, a merge needs the same green reading on two passes; a new head starts over', async () => {
    const w = world();
    w.seen.clear();
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).not.toHaveBeenCalled();
    w.state.prs = [pr({ head_sha: 'h2' })];
    w.gh.pull.mockResolvedValue(w.pullFor({ mergeable: true, mergeable_state: 'clean', head_sha: 'h2', base_ref: EPIC_BRANCH }));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).not.toHaveBeenCalled();
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).toHaveBeenCalledWith('tok', 'acme/app', 7, expect.objectContaining({ sha: 'h2' }));
  });

  it('with required_checks, every listed workflow must have a successful run on the head', async () => {
    const w = world({ setup: setupWith({ required_checks: ['ci', 'e2e.yml'] }), prs: [pr({ ci_state: 'running' })] });
    w.seen.clear();
    w.ci.listRuns.mockResolvedValue([run('ci', 'completed', 'success', 1), run('e2e', 'in_progress', null, 2), run('lint', 'in_progress', null, 3)]);
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(mergeWaitOf('c1', new Date('2026-10-05T12:00:00Z'))).toBe('merge_checks_pending');
    w.ci.listRuns.mockResolvedValue([run('ci', 'completed', 'success', 1), run('e2e', 'completed', 'success', 2), run('lint', 'in_progress', null, 3)]);
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
  });

  it('into the base branch: only while the base head is green and nothing is being delivered (one delivery at a time)', async () => {
    const setup = setupWith({ autonomy: 'deploy', release_workflows: ['publish-agent.yml'] }, { deploy_workflow: 'deploy.yml' });
    const cases: Array<[WorkflowRun[], string | null]> = [
      [[run('ci', 'completed', 'failure')], 'merge_base_red'],
      [[run('ci', 'completed', 'success', 1), run('deploy', 'in_progress', null, 2)], 'merge_base_pending'],
      [[run('ci', 'completed', 'success', 1), run('publish-agent', 'queued', null, 2)], 'merge_base_pending'],
      [[], 'merge_base_pending'],
      // a cancelled deploy was superseded, not failed
      [[run('ci', 'completed', 'success', 1), run('deploy', 'completed', 'cancelled', 2)], null],
    ];
    for (const [baseRuns, wait] of cases) {
      const w = world({ setup, prs: [pr({ task_id: 'c2', base_ref: 'main' })] });
      w.ci.listRuns.mockImplementation(async (_t, _r, sha) => (sha === 'base1' ? baseRuns : [run('ci', 'completed', 'success')]));
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.branchSha).toHaveBeenCalledWith('tok', 'acme/app', 'main');
      expect(w.gh.merge).toHaveBeenCalledTimes(wait ? 0 : 1);
      if (wait) expect(mergeWaitOf('c2', new Date('2026-10-05T12:00:00Z'))).toBe(wait);
    }
  });

  it('a PR into the base that is behind it (compared explicitly) is updated and waits for CI again', async () => {
    const w = world({ setup: setupWith({ autonomy: 'deploy' }), prs: [pr({ task_id: 'c2', base_ref: 'main' })] });
    // GitHub says `clean` (no strict branch protection): only the explicit compare sees the PR is behind
    w.gh.compare.mockResolvedValue({ ahead_by: 1, behind_by: 2 });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.compare).toHaveBeenCalledWith('tok', 'acme/app', 'main', 'h1');
    expect(w.gh.updateBranch).toHaveBeenCalledWith('tok', 'acme/app', 7, 'h1');
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(w.seen.has('p1:acme/app#7')).toBe(false);
  });

  it('a PR into the epic branch is not compared nor throttled (epic branches deploy nothing)', async () => {
    const w = world();
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.compare).not.toHaveBeenCalled();
    expect(w.gh.branchSha).not.toHaveBeenCalled();
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
  });

  // Only the card's own automatic branch, from this repository, into its epic branch or the base branch.
  it('a head branch named like the base or the epic branch is never a candidate', async () => {
    for (const head_ref of ['main', EPIC_BRANCH]) {
      const w = world({ prs: [pr({ head_ref, base_ref: head_ref === 'main' ? EPIC_BRANCH : 'main' })] });
      vi.mocked(w.repos.automationRuns.branchesOfTask).mockResolvedValue([head_ref]);
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.pull).not.toHaveBeenCalled();
      expect(w.state.actions).toHaveLength(0);
    }
  });

  // Spec §10.2 (Task 26): the epic PR — the epic's own branch, which its integrator worked on, into the base branch.
  describe('the epic PR', () => {
    const epicPr = (over: Partial<TaskPullRequest> = {}) => pr({ task_id: 'e1', head_ref: EPIC_BRANCH, base_ref: 'main', title: `TER-1: integrate ${EPIC_BRANCH}`, ...over });
    const onEpicBranch = (w: ReturnType<typeof world>) => vi.mocked(w.repos.automationRuns.branchesOfTask).mockImplementation(async (id: string) => (id === 'e1' ? [EPIC_BRANCH] : [BRANCH[id]!]));

    it('is merged like a card PR, with the base branch rules, and moves the epic to done', async () => {
      const w = world({ prs: [epicPr()] });
      onEpicBranch(w);
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.compare).toHaveBeenCalledWith('tok', 'acme/app', 'main', 'h1'); // into the base: R1's delivery gate
      expect(w.gh.merge).toHaveBeenCalledWith('tok', 'acme/app', 7, { sha: 'h1', title: `TER-1: integrate ${EPIC_BRANCH} (#7)`, method: 'squash' });
      expect(w.repos.tasks.move).toHaveBeenCalledWith('e1', { status: 'done' }, 0);
      expect(w.state.events).toEqual([expect.objectContaining({ kind: 'merged', task_id: 'e1' })]);
    });

    it('while the integrator has not finished (none done yet, or one active), it is not touched: no update-branch, no merge, no card', async () => {
      for (const statuses of [[], ['blocked'], ['running'], ['done', 'running'], ['done', 'queued']]) {
        const w = world({ prs: [epicPr()] });
        onEpicBranch(w);
        vi.mocked(w.repos.automationRuns.triggeredStatuses).mockResolvedValue(statuses);
        w.gh.compare.mockResolvedValue({ ahead_by: 1, behind_by: 3 }); // behind the base: would be updated if it were a candidate
        await runMergeExecutor(w.deps, 'p1');
        expect(w.gh.pull).not.toHaveBeenCalled();
        expect(w.gh.updateBranch).not.toHaveBeenCalled();
        expect(w.gh.merge).not.toHaveBeenCalled();
        expect(w.state.actions).toHaveLength(0);
      }
    });

    it('above the level (main deploys) it asks, like a card PR', async () => {
      const w = world({ setup: setupWith({}, { deploy_workflow: 'deploy.yml' }), prs: [epicPr()] });
      onEpicBranch(w);
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.merge).not.toHaveBeenCalled();
      expect(w.state.actions[0]!.args).toMatchObject({ base: 'main', needed: 'deploy' });
    });

    it('a card PR from the epic branch is still refused, even when the card\'s run used that branch', async () => {
      for (const base_ref of ['main', EPIC_BRANCH]) {
        const w = world({ prs: [pr({ task_id: 'c1', head_ref: EPIC_BRANCH, base_ref })] });
        vi.mocked(w.repos.automationRuns.branchesOfTask).mockResolvedValue([EPIC_BRANCH]);
        await runMergeExecutor(w.deps, 'p1');
        expect(w.gh.pull).not.toHaveBeenCalled();
        expect(w.state.actions).toHaveLength(0);
      }
    });

    it('an epic PR from another head, into the epic branch or another base, or naming a card too, is refused', async () => {
      const cases: TaskPullRequest[][] = [
        [epicPr({ head_ref: 'TER-1-other' })],
        [epicPr({ base_ref: EPIC_BRANCH })],
        [epicPr({ base_ref: 'release' })],
        [epicPr(), epicPr({ id: 'pr2', task_id: 'c1' })],
      ];
      for (const prs of cases) {
        const w = world({ prs });
        vi.mocked(w.repos.automationRuns.branchesOfTask).mockImplementation(async (id: string) => (id === 'e1' ? [EPIC_BRANCH, 'TER-1-other'] : [BRANCH[id]!]));
        await runMergeExecutor(w.deps, 'p1');
        expect(w.gh.pull).not.toHaveBeenCalled();
        expect(w.state.actions).toHaveLength(0);
      }
    });

    it('a manual epic\'s PR is left to the person', async () => {
      const w = world({ prs: [epicPr({ task_id: 'e2', head_ref: epicBranchName('epic/{ref}-{slug}', EPIC2) })] });
      vi.mocked(w.repos.automationRuns.branchesOfTask).mockResolvedValue([epicBranchName('epic/{ref}-{slug}', EPIC2)]);
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.pull).not.toHaveBeenCalled();
    });
  });

  it('automation turned off during the pass stops the merge right before it (setup read fresh)', async () => {
    const w = world();
    vi.mocked(w.repos.projectSetup.get)
      .mockResolvedValueOnce({ data: w.state.setup } as never)
      .mockResolvedValue({ data: setupWith({ enabled: false }) } as never);
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.files).toHaveBeenCalled();
    expect(w.gh.merge).not.toHaveBeenCalled();
  });

  it('a PR from a fork is ignored: no merge, no card', async () => {
    const w = world();
    w.gh.pull.mockResolvedValue(w.pullFor({ head_repo: 'mallory/app' }));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(w.gh.files).not.toHaveBeenCalled();
    expect(w.state.actions).toHaveLength(0);
  });

  it('a collaborator PR that only names the card (another head branch) is ignored', async () => {
    const w = world({ prs: [pr({ head_ref: 'feature/naming-TER-5' })] });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.pull).not.toHaveBeenCalled();
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(w.state.actions).toHaveLength(0);
  });

  it('a PR into another base (neither the epic branch nor the base branch) is ignored, whatever the level', async () => {
    for (const base_ref of ['production', 'epic/TER-9-other', null]) {
      const w = world({ setup: setupWith({ autonomy: 'release' }), prs: [pr({ base_ref })] });
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.pull).not.toHaveBeenCalled();
      expect(w.gh.merge).not.toHaveBeenCalled();
      expect(w.state.actions).toHaveLength(0);
    }
  });

  it('GitHub reporting another head branch or base than the synced row is ignored', async () => {
    for (const over of [{ head_ref: 'other' }, { base_ref: 'main' }]) {
      const w = world();
      w.gh.pull.mockResolvedValue(w.pullFor(over));
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.merge).not.toHaveBeenCalled();
      expect(w.state.actions).toHaveLength(0);
    }
  });

  it('a head that moved since CI, or a mergeability GitHub has not computed, waits for the next sync', async () => {
    for (const p of [{ mergeable: true, mergeable_state: 'clean', head_sha: 'h9', base_ref: EPIC_BRANCH }, { mergeable: null, mergeable_state: 'unknown', head_sha: 'h1', base_ref: EPIC_BRANCH }]) {
      const w = world();
      w.gh.pull.mockResolvedValue(w.pullFor(p));
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.merge).not.toHaveBeenCalled();
      expect(w.startFixer).not.toHaveBeenCalled();
    }
  });

  it('not mergeable: a fixer run keyed by the PR head, with the conflict prompt; no merge', async () => {
    const w = world();
    w.gh.pull.mockResolvedValue(w.pullFor({ mergeable: false, mergeable_state: 'dirty', head_sha: 'h1', base_ref: EPIC_BRANCH }));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.startFixer).toHaveBeenCalledTimes(1);
    expect(w.startFixer).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', taskId: 'c1', role: 'fixer', triggerSha: 'h1', branch: 'TER-5-arrastar-cards', base: EPIC_BRANCH }));
    const { prompt } = (w.startFixer.mock.calls[0] as unknown as [{ prompt: string }])[0];
    expect(prompt).toContain('tem conflito com');
    expect(w.gh.merge).not.toHaveBeenCalled();
  });

  it('after fix_attempts conflict fixers: no new fixer, one escalation per head', async () => {
    const w = world({ triggered: 3 });
    w.gh.pull.mockResolvedValue(w.pullFor({ mergeable: false, mergeable_state: 'dirty', head_sha: 'h1', base_ref: EPIC_BRANCH }));
    await runMergeExecutor(w.deps, 'p1');
    await runMergeExecutor(w.deps, 'p1');
    expect(w.startFixer).not.toHaveBeenCalled();
    expect(w.state.events.filter((e) => e.kind === 'escalated')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: 'conflict_cap', pr: 7, sha: 'h1', attempts: 3 }) })]);
    // the marker has a trigger of its own: the head's fixer trigger stays free (final review I3)
    expect(w.state.runs).toEqual([expect.objectContaining({ role: 'fixer', trigger_sha: 'conflict_cap:h1', status: 'blocked', waiting_reason: 'conflict_cap' })]);
    expect(mergeWaitOf('c1', new Date('2026-10-05T12:00:00Z'))).toBe('merge_conflict_cap');
  });

  it('GitHub 405 (not mergeable) or 409 (head moved) on the merge: not merged, nothing recorded', async () => {
    for (const fail of [() => Promise.reject(new GithubCiError('not_mergeable', 405)), () => Promise.resolve({ merged: false, sha: null })]) {
      const w = world();
      w.gh.merge.mockImplementation(fail as never);
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.merge).toHaveBeenCalledTimes(1);
      expect(w.state.events).toEqual([]);
      expect(w.repos.tasks.move).not.toHaveBeenCalled();
    }
  });

  it('a read-only token (403 on the merge): not merged, and the card and the CI panel say why', async () => {
    const w = world();
    w.gh.merge.mockRejectedValue(new GithubCiError('forbidden', 403));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.state.events).toEqual([]);
    expect(mergeWaitOf('c1', new Date('2026-10-05T12:00:00Z'))).toBe('merge_no_write');
    expect(ciErrorOf('p1')).toBe('Integração do GitHub sem permissão de escrita');
  });

  it('a read-only token on update-branch says the same', async () => {
    const w = world({ setup: setupWith({ autonomy: 'deploy' }), prs: [pr({ task_id: 'c2', base_ref: 'main' })] });
    // GitHub says `clean` (no strict branch protection): only the explicit compare sees the PR is behind
    w.gh.compare.mockResolvedValue({ ahead_by: 1, behind_by: 2 });
    w.gh.updateBranch.mockRejectedValue(new GithubCiError('forbidden', 403));
    await runMergeExecutor(w.deps, 'p1');
    expect(mergeWaitOf('c2', new Date('2026-10-05T12:00:00Z'))).toBe('merge_no_write');
  });

  it('a draining instance, a paused project, or a project with automation off: nothing is read from GitHub, nothing merged', async () => {
    const draining = world();
    draining.lifecycle.draining = true;
    const paused = world({ paused: true });
    const off = world({ setup: setupWith({ enabled: false }) });
    for (const w of [draining, paused, off]) {
      await runMergeExecutor(w.deps, 'p1');
      expect(w.gh.pull).not.toHaveBeenCalled();
      expect(w.gh.merge).not.toHaveBeenCalled();
      expect(w.state.actions).toHaveLength(0);
    }
    expect(off.repos.taskPullRequests.listWatched).not.toHaveBeenCalled();
  });

  it('a pause pressed during the pass stops the merge right before it (Review Focus 4)', async () => {
    const w = world();
    vi.mocked(w.repos.automationPauses.state)
      .mockResolvedValueOnce({ user: null, project: null })
      .mockResolvedValue({ user: null, project: new Date() });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.files).toHaveBeenCalled();
    expect(w.gh.merge).not.toHaveBeenCalled();
  });

  it('a PR that also names a card a person works on is left to the person', async () => {
    const w = world({ prs: [pr(), pr({ id: 'pr2', task_id: 'c3' })] });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.pull).not.toHaveBeenCalled();
    expect(w.gh.merge).not.toHaveBeenCalled();
  });

  it('TER-1004: the PR held by a person\'s card says why, in the queue and once per head in the feed', async () => {
    const w = world({ prs: [pr(), pr({ id: 'pr2', task_id: 'c3' })] });
    await runMergeExecutor(w.deps, 'p1');
    await runMergeExecutor(w.deps, 'p1');
    expect(mergeWaitOf('c1', new Date('2026-10-05T12:00:00Z'))).toBe('merge_person_card');
    expect(w.state.events).toEqual([
      expect.objectContaining({ kind: 'escalated', task_id: 'c1', payload: expect.objectContaining({ reason: 'merge_person_card', pr: 7, sha: 'h1', cards: 'TER-7' }) }),
    ]);
    // a new head is a new question
    w.state.prs = [pr({ head_sha: 'h2' }), pr({ id: 'pr2', task_id: 'c3', head_sha: 'h2' })];
    await runMergeExecutor(w.deps, 'p1');
    expect(w.state.events.filter((e) => e.kind === 'escalated')).toHaveLength(2);
    expect(w.gh.merge).not.toHaveBeenCalled();
  });

  it('TER-1004: a person\'s card the PR only cites and that is already done does not hold the merge', async () => {
    const w = world({ prs: [pr(), pr({ id: 'pr2', task_id: 'c3' })] });
    const cards: Record<string, object> = { e1: EPIC, e2: EPIC2, c1: CARD, c2: LONE, c3: { ...MANUAL, status: 'done' } };
    vi.mocked(w.repos.tasks.findById).mockImplementation((async (id: string) => cards[id]) as never);
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
    expect(w.repos.tasks.move).toHaveBeenCalledTimes(1);
    expect(w.repos.tasks.move).toHaveBeenCalledWith('c1', { status: 'done' }, 0);
    expect(w.state.events.filter((e) => e.kind === 'merged').map((e) => e.task_id)).toEqual(['c1']);
  });

  it('TER-1004: another automatic card the PR only cites is neither moved to done nor told of the merge', async () => {
    // #395 (TER-992's branch) cited TER-994, whose own PR was still open: TER-994 went to done with it
    const w = world({ prs: [pr(), pr({ id: 'pr2', task_id: 'c2' })] });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
    expect(w.repos.tasks.move).toHaveBeenCalledTimes(1);
    expect(w.repos.tasks.move).toHaveBeenCalledWith('c1', { status: 'done' }, 0);
    expect(w.state.events.filter((e) => e.kind === 'merged').map((e) => e.task_id)).toEqual(['c1']);
    expect(w.state.messages.join('\n')).not.toContain('TER-6');
  });

  it('a draft PR is not merged', async () => {
    const w = world({ prs: [pr({ draft: true })] });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).not.toHaveBeenCalled();
  });
});

const cleanupRun = (over: Record<string, unknown> = {}) => ({
  id: 'run1', project_id: 'p1', task_id: 'c1', role: 'implementer', status: 'done', tab_id: 'tab1', machine_id: 'm1', worktree_path: '/wt/p1/TER-5', cleanup_state: null, cleanup_attempts: 0, ...over,
});

describe('cleanup after a merge (spec §7)', () => {
  const withRun = (over: Record<string, unknown> = {}, tab: { state: string } | null = { state: 'idle' }) => {
    const w = world();
    w.state.cleanupRuns.push(cleanupRun(over));
    if (tab) w.state.tabs.tab1 = { id: 'tab1', state: tab.state, state_text: null, rate_limited_at: null };
    return w;
  };

  it('a merged card PR removes the card worktree once and closes the idle tab of its finished run', async () => {
    const w = withRun();
    await runMergeExecutor(w.deps, 'p1');
    expect(w.removeWorkspace).toHaveBeenCalledTimes(1);
    expect(w.removeWorkspace.mock.calls[0]![1]).toEqual({ repoDir: '/repo', root: w.state.setup.automation.worktrees_dir, path: '/wt/p1/TER-5' });
    expect(w.closeTab).toHaveBeenCalledTimes(1);
    expect(w.closeTab.mock.calls[0]![1]).toBe('tab1');
    expect(w.state.cleanupRuns[0]!.cleanup_state).toBe('done');
    expect(w.state.events.map((e) => e.kind)).toEqual(['worktree_cleanup', 'merged']);
    expect(w.state.events[0]!.payload).toMatchObject({ outcome: 'removed', path: '/wt/p1/TER-5' });
    expect(w.state.events[1]!.payload).not.toHaveProperty('worktree_kept');
  });

  it('a dirty worktree is kept, and the merged event says so', async () => {
    const w = withRun();
    w.removeWorkspace.mockResolvedValue({ removed: false, dirty: true });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.state.cleanupRuns[0]!.cleanup_state).toBe('kept');
    expect(w.state.events.find((e) => e.kind === 'merged')!.payload).toMatchObject({ worktree_kept: true });
    expect(w.state.events.find((e) => e.kind === 'worktree_cleanup')!.payload).toMatchObject({ outcome: 'kept' });
  });

  it('a machine that is offline leaves the cleanup due (not an error for the merge)', async () => {
    const w = withRun();
    w.removeWorkspace.mockRejectedValue(Object.assign(new Error('offline'), { code: 'MACHINE_OFFLINE' }));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.state.events.map((e) => e.kind)).toEqual(['merged']);
    expect(w.state.cleanupRuns[0]).toMatchObject({ cleanup_state: 'due', cleanup_attempts: 1 });
  });

  it('a working tab is never closed, and a run that did not end done keeps its tab', async () => {
    for (const [status, tabState] of [['done', 'working'], ['done', 'waiting_background'], ['blocked', 'idle'], ['failed', 'idle']] as const) {
      const w = withRun({ status }, { state: tabState });
      await runMergeExecutor(w.deps, 'p1');
      expect(w.closeTab).not.toHaveBeenCalled();
    }
  });

  it('the epic PR also removes the worktrees of its cards that are still left', async () => {
    const w = world({ prs: [pr({ task_id: 'e1', head_ref: EPIC_BRANCH, base_ref: 'main', title: 'epic' })] });
    vi.mocked(w.repos.automationRuns.branchesOfTask).mockImplementation(async (id: string) => (id === 'e1' ? [EPIC_BRANCH] : [BRANCH[id]!]));
    w.state.cleanupRuns.push(
      cleanupRun({ id: 'ri', task_id: 'e1', role: 'integrator', tab_id: null, worktree_path: '/wt/p1/TER-1' }),
      cleanupRun({ id: 'rc', task_id: 'c1', worktree_path: '/wt/p1/TER-5', tab_id: null }),
      cleanupRun({ id: 'rx', task_id: 'c2', worktree_path: '/wt/p1/TER-6', tab_id: null }), // another epic's card
    );
    await runMergeExecutor(w.deps, 'p1');
    expect(w.removeWorkspace.mock.calls.map((c) => c[1].path).sort()).toEqual(['/wt/p1/TER-1', '/wt/p1/TER-5']);
  });

  it('runs of one card on the same worktree remove it once', async () => {
    const w = withRun();
    w.state.cleanupRuns.push(cleanupRun({ id: 'run2', role: 'fixer', tab_id: null }));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.removeWorkspace).toHaveBeenCalledTimes(1);
    expect(w.state.cleanupRuns.map((r) => r.cleanup_state)).toEqual(['done', 'done']);
  });

  it('a card with an active run (a fixer working) keeps its worktree until the run ends', async () => {
    const w = withRun();
    w.state.cleanupRuns.push(cleanupRun({ id: 'run2', role: 'fixer', status: 'running', tab_id: null }));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.removeWorkspace).not.toHaveBeenCalled();
    expect(w.state.cleanupRuns.map((r) => r.cleanup_state)).toEqual(['due', 'due']);
  });

  it('automation off, draining or paused merges nothing and cleans nothing', async () => {
    for (const mutate of [(w: ReturnType<typeof world>) => (w.state.setup = setupWith({ enabled: false })), (w: ReturnType<typeof world>) => (w.lifecycle.draining = true), (w: ReturnType<typeof world>) => (w.state.paused = true)]) {
      const w = withRun();
      mutate(w);
      await runMergeExecutor(w.deps, 'p1');
      expect(w.removeWorkspace).not.toHaveBeenCalled();
      expect(w.closeTab).not.toHaveBeenCalled();
      expect(w.state.cleanupRuns[0]!.cleanup_state).toBeNull();
    }
  });

  it('a failure while cleaning never fails the merge', async () => {
    const w = withRun();
    vi.mocked(w.repos.automationRuns.markCleanupDue).mockRejectedValue(new Error('db'));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.state.events.map((e) => e.kind)).toEqual(['merged']);
  });
});

describe('mergeApproved', () => {
  async function asked(setup = setupWith({ autonomy: 'merge' }, { deploy_workflow: 'deploy.yml' }), files = ['apps/web/src/Board.tsx']) {
    const w = world({ setup, prs: [pr({ task_id: 'c2', base_ref: 'main' })] });
    w.gh.files.mockResolvedValue({ paths: files, complete: true });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.state.actions).toHaveLength(1);
    return { w, action: w.state.actions[0]! };
  }

  it('an approved card merges once, even approved twice (two hooks, the executor and the hook at once)', async () => {
    const { w, action } = await asked();
    approve(action);
    await Promise.all([mergeApproved(w.deps, action.id), mergeApproved(w.deps, action.id), runMergeExecutor(w.deps, 'p1')]);
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
    expect(w.gh.merge).toHaveBeenCalledWith('tok', 'acme/app', 7, { sha: 'h1', title: 'Board: drag cards (#7)', method: 'squash' });
    expect(action.status).toBe('executed');
    expect(w.state.events.filter((e) => e.kind === 'merged')).toEqual([expect.objectContaining({ task_id: 'c2', payload: expect.objectContaining({ by: 'approval', level: 'deploy', moved_to_done: true }) })]);
    expect(w.repos.tasks.move).toHaveBeenCalledWith('c2', { status: 'done' }, 0);
  });

  it('a store card merges once a person approves it', async () => {
    const { w, action } = await asked(setupWith({ autonomy: 'release', store_paths: ['apps/mobile/**'] }), ['apps/mobile/app.json']);
    expect(action.args).toMatchObject({ needed: 'store' });
    expect(w.gh.merge).not.toHaveBeenCalled();
    approve(action);
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
  });

  it('a pending or denied card merges nothing', async () => {
    const { w, action } = await asked();
    await mergeApproved(w.deps, action.id);
    action.status = 'denied';
    await mergeApproved(w.deps, action.id);
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(w.state.actions).toHaveLength(1);
  });

  it('while paused or draining the approval waits, and the executor merges it once the pause is lifted', async () => {
    const { w, action } = await asked();
    approve(action);
    w.state.paused = true;
    await mergeApproved(w.deps, action.id);
    w.state.paused = false;
    w.lifecycle.draining = true;
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action.status).toBe('approved');
    w.lifecycle.draining = false;
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
    expect(action.status).toBe('executed');
  });

  it('a PR whose head moved since the card is not merged: the card fails with HEAD_MOVED', async () => {
    const { w, action } = await asked();
    approve(action);
    w.gh.pull.mockResolvedValue(w.pullFor({ mergeable: true, mergeable_state: 'clean', head_sha: 'h2', base_ref: 'main' }));
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action).toMatchObject({ status: 'failed', error_code: 'HEAD_MOVED' });
  });

  it('an approved merge into the base still waits for a green base with nothing delivering, then merges', async () => {
    const { w, action } = await asked();
    approve(action);
    w.ci.listRuns.mockImplementation(async (_t, _r, sha) => (sha === 'base1' ? [run('deploy', 'in_progress', null)] : [run('ci', 'completed', 'success')]));
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action.status).toBe('approved');
    expect(mergeWaitOf('c2', new Date('2026-10-05T12:00:00Z'))).toBe('merge_base_pending');
    w.ci.listRuns.mockImplementation(async () => [run('ci', 'completed', 'success')]);
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
  });

  it('an approved PR that fell behind the base is updated, not merged: the card closes with BEHIND_BASE', async () => {
    const { w, action } = await asked();
    approve(action);
    // GitHub says `clean` (no strict branch protection): only the explicit compare sees the PR is behind
    w.gh.compare.mockResolvedValue({ ahead_by: 1, behind_by: 2 });
    await mergeApproved(w.deps, action.id);
    expect(w.gh.updateBranch).toHaveBeenCalledWith('tok', 'acme/app', 7, 'h1');
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action).toMatchObject({ status: 'failed', error_code: 'BEHIND_BASE' });
  });

  it('a PR retargeted after the approval (epic branch → base branch, same head) is not merged: BASE_CHANGED', async () => {
    const w = world({ setup: setupWith({ autonomy: 'pr' }, { deploy_workflow: 'deploy.yml' }) });
    await runMergeExecutor(w.deps, 'p1');
    const action = w.state.actions[0]!;
    expect(action.args).toMatchObject({ base: EPIC_BRANCH, needed: 'merge' });
    expect(action.idempotency_key).toBe(mergeKey('acme/app', 7, 'h1', EPIC_BRANCH));
    approve(action);
    // the same head now targets main, which deploys
    w.state.prs = [pr({ base_ref: 'main' })];
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action).toMatchObject({ status: 'failed', error_code: 'BASE_CHANGED' });
    // the executor asks again, for the new base
    await runMergeExecutor(w.deps, 'p1');
    expect(w.state.actions).toHaveLength(2);
    expect(w.state.actions[1]!.args).toMatchObject({ base: 'main', needed: 'deploy' });
  });

  it('GitHub reporting a base other than the approved one closes the card the same way', async () => {
    const { w, action } = await asked();
    approve(action);
    w.gh.pull.mockResolvedValue(w.pullFor({ base_ref: EPIC_BRANCH }));
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action).toMatchObject({ status: 'failed', error_code: 'BASE_CHANGED' });
  });

  it('files that now need more than the approved level close the card: LEVEL_CHANGED', async () => {
    const { w, action } = await asked(setupWith({ autonomy: 'merge', release_paths: ['apps/agent/**'] }, { deploy_workflow: 'deploy.yml' }));
    expect(action.args).toMatchObject({ needed: 'deploy' });
    approve(action);
    w.gh.files.mockResolvedValue({ paths: ['apps/agent/package.json'], complete: true });
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action).toMatchObject({ status: 'failed', error_code: 'LEVEL_CHANGED' });
  });

  it('automation turned off during an approved merge stops it; the approval stays', async () => {
    const { w, action } = await asked();
    approve(action);
    vi.mocked(w.repos.projectSetup.get)
      .mockResolvedValueOnce({ data: w.state.setup } as never)
      .mockResolvedValue({ data: setupWith({ enabled: false }) } as never);
    await mergeApproved(w.deps, action.id);
    expect(w.gh.pull).toHaveBeenCalled();
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action.status).toBe('approved');
  });

  it('the CI turned red on the same head after the card: the approval closes with CI_FAILED, no merge', async () => {
    const { w, action } = await asked();
    approve(action);
    w.state.prs = [pr({ task_id: 'c2', base_ref: 'main', ci_state: 'failed' })];
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action).toMatchObject({ status: 'failed', error_code: 'CI_FAILED' });
  });

  it('CI re-running, or a required check not green yet: the approval waits, nothing merged', async () => {
    const { w, action } = await asked();
    approve(action);
    w.state.prs = [pr({ task_id: 'c2', base_ref: 'main', ci_state: 'running' })];
    await mergeApproved(w.deps, action.id);
    w.state.setup = setupWith({ autonomy: 'merge', required_checks: ['e2e'] }, { deploy_workflow: 'deploy.yml' });
    w.state.prs = [pr({ task_id: 'c2', base_ref: 'main' })];
    w.ci.listRuns.mockResolvedValue([run('e2e', 'completed', 'failure')]);
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action.status).toBe('approved');
  });

  it('a pause landing between the GitHub reads and the merge stops it; the approval stays', async () => {
    const { w, action } = await asked();
    approve(action);
    vi.mocked(w.repos.automationPauses.state)
      .mockResolvedValueOnce({ user: null, project: null })
      .mockResolvedValue({ user: null, project: new Date() });
    await mergeApproved(w.deps, action.id);
    expect(w.gh.pull).toHaveBeenCalled();
    expect(w.ci.listRuns).toHaveBeenCalled();
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action.status).toBe('approved');
  });

  it('draining that starts during the GitHub reads stops the merge too', async () => {
    const { w, action } = await asked();
    approve(action);
    w.gh.branchSha.mockImplementation(async () => {
      w.lifecycle.draining = true;
      return 'base1';
    });
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action.status).toBe('approved');
  });

  it('an approved PR that turned out to come from a fork is never merged', async () => {
    const { w, action } = await asked();
    approve(action);
    w.gh.pull.mockResolvedValue(w.pullFor({ head_repo: 'mallory/app' }));
    await mergeApproved(w.deps, action.id);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(action).toMatchObject({ status: 'failed', error_code: 'NOT_CANDIDATE' });
  });

  it('GitHub refusing the approved merge (405) fails the card and records no merge', async () => {
    const { w, action } = await asked();
    approve(action);
    w.gh.merge.mockRejectedValue(new GithubCiError('not_mergeable', 405));
    await mergeApproved(w.deps, action.id);
    expect(action).toMatchObject({ status: 'failed', error_code: 'NOT_MERGED' });
    expect(w.state.events.filter((e) => e.kind === 'merged')).toEqual([]);
  });

  it('ignores any other tool', async () => {
    const w = world();
    w.state.actions.push({ id: 'x1', tool: 'close_tab', status: 'approved', args: {}, conversation_id: 'conv1' } as unknown as ChatAction);
    await mergeApproved(w.deps, 'x1');
    expect(w.repos.chatActions.claimApproved).not.toHaveBeenCalled();
  });
});

describe('red CI (spec D21)', () => {
  const red = (sha: string, failing = ['ci', 'e2e']) => pr({ head_sha: sha, ci_state: 'failed', ci_summary: { total: 2, passed: 0, failed: failing.length, running: 0, failing } });
  const requests = (w: ReturnType<typeof world>) => w.state.events.filter((e) => e.kind === 'ci_fix_requested');
  const NOW = new Date('2026-10-05T12:00:00Z');

  /** The implementer run that opened the PR, still on in its tab. */
  function owningRun(w: ReturnType<typeof world>, tab: Partial<{ state: string | null; state_text: string | null; rate_limited_at: string | null }> = {}) {
    w.state.runs.push({ id: 'impl', task_id: 'c1', role: 'implementer', trigger_sha: null, status: 'running', waiting_reason: null, tab_id: 'tab1', branch: BRANCH.c1!, fix_count: 0 });
    w.state.tabs.tab1 = { id: 'tab1', state: 'waiting_input', state_text: null, rate_limited_at: null, ...tab };
  }

  it('the owning run alive: typed into its tab with the failing job names only, fix_count bumped; the same SHA on two syncs is one request', async () => {
    const w = world({ prs: [red('h1')] });
    owningRun(w);
    await runMergeExecutor(w.deps, 'p1');
    await runMergeExecutor(w.deps, 'p1');
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.type).toHaveBeenCalledWith(expect.anything(), 'tab1', '[termhub automático] O CI falhou em ci, e2e. Corrija e faça push.');
    expect(w.startFixer).not.toHaveBeenCalled();
    expect(w.state.runs.find((r) => r.id === 'impl')!.fix_count).toBe(1);
    expect(requests(w)).toEqual([expect.objectContaining({ task_id: 'c1', payload: expect.objectContaining({ pr: 7, sha: 'h1', via: 'typed', run_id: 'impl', count: 1 }) })]);
    expect(w.gh.merge).not.toHaveBeenCalled();
    expect(w.gh.pull).not.toHaveBeenCalled();
  });

  it('the implementer run ended: a fixer run keyed by the PR head with the CI prompt; once per SHA', async () => {
    const w = world({ prs: [red('h1', ['Build web'])] });
    await runMergeExecutor(w.deps, 'p1');
    await runMergeExecutor(w.deps, 'p1');
    expect(w.startFixer).toHaveBeenCalledTimes(1);
    expect(w.startFixer).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', taskId: 'c1', role: 'fixer', triggerSha: 'h1', branch: BRANCH.c1, base: EPIC_BRANCH }));
    const { prompt } = (w.startFixer.mock.calls[0] as unknown as [{ prompt: string }])[0];
    expect(prompt).toContain('O CI do PR do card TER-5 falhou.');
    expect(prompt).toContain('Jobs com falha: Build web');
    expect(w.type).not.toHaveBeenCalled();
    expect(requests(w)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ pr: 7, sha: 'h1', via: 'fixer' }) })]);
  });

  it('a CI that keeps failing: three red SHAs get three fix requests, the fourth escalates once (Review Focus 3)', async () => {
    const w = world({ prs: [red('h1')] });
    owningRun(w);
    await runMergeExecutor(w.deps, 'p1');
    // the implementer ends; each new red head gets a fixer
    w.state.runs.find((r) => r.id === 'impl')!.status = 'done';
    for (const sha of ['h2', 'h3']) {
      w.state.prs = [red(sha)];
      await runMergeExecutor(w.deps, 'p1');
    }
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.startFixer).toHaveBeenCalledTimes(2);
    w.state.prs = [red('h4')];
    await runMergeExecutor(w.deps, 'p1');
    await runMergeExecutor(w.deps, 'p1');
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.startFixer).toHaveBeenCalledTimes(2);
    expect(requests(w).map((e) => e.payload?.via)).toEqual(['typed', 'fixer', 'fixer', 'escalated']);
    expect(w.state.events.filter((e) => e.kind === 'escalated')).toEqual([
      expect.objectContaining({ task_id: 'c1', payload: expect.objectContaining({ reason: 'ci_cap', pr: 7, sha: 'h4', attempts: 3 }) }),
    ]);
    expect(w.state.messages).toEqual(['Automático parou em TER-5: O CI do PR continua falhando depois das tentativas de correção; confira o PR.']);
    expect(mergeWaitOf('c1', NOW)).toBe('merge_ci_cap');
  });

  it('conflict fixers count against the same cap', async () => {
    const w = world({ prs: [red('h1')], triggered: 3 });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.startFixer).not.toHaveBeenCalled();
    expect(w.state.events.filter((e) => e.kind === 'escalated')).toHaveLength(1);
  });

  it('fix_attempts 0 escalates at once: nothing typed, no fixer', async () => {
    const w = world({ setup: setupWith({ fix_attempts: 0 }), prs: [red('h1')] });
    owningRun(w);
    await runMergeExecutor(w.deps, 'p1');
    expect(w.type).not.toHaveBeenCalled();
    expect(w.startFixer).not.toHaveBeenCalled();
    expect(w.state.events.filter((e) => e.kind === 'escalated')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: 'ci_cap', attempts: 0 }) })]);
  });

  it('automation off, or paused: nothing typed, started, recorded or escalated', async () => {
    for (const o of [{ setup: setupWith({ enabled: false }) }, { paused: true }]) {
      const w = world({ ...o, prs: [red('h1')] });
      owningRun(w);
      await runMergeExecutor(w.deps, 'p1');
      expect(w.type).not.toHaveBeenCalled();
      expect(w.startFixer).not.toHaveBeenCalled();
      expect(w.state.events).toEqual([]);
    }
  });

  it('an owning tab that cannot take a line now (a question, a limit, an exit) is asked again on a later sync, not reported', async () => {
    const cases: Array<(w: ReturnType<typeof world>) => void> = [
      (w) => void (w.state.openQuestion = true),
      (w) => void (w.state.tabs.tab1!.rate_limited_at = '2026-10-05T11:59:00Z'),
      (w) => void Object.assign(w.state.tabs.tab1!, { state: 'idle', state_text: 'Agente encerrado sem terminar o turno' }),
    ];
    for (const block of cases) {
      const w = world({ prs: [red('h1')] });
      owningRun(w);
      block(w);
      await runMergeExecutor(w.deps, 'p1');
      expect(w.type).not.toHaveBeenCalled();
      expect(w.startFixer).not.toHaveBeenCalled();
      expect(requests(w)).toEqual([]);
    }
  });

  it('no place for the fixer yet: not reported, asked again at the next sync', async () => {
    const w = world({ prs: [red('h1')] });
    w.startFixer.mockResolvedValueOnce('waiting');
    await runMergeExecutor(w.deps, 'p1');
    expect(requests(w)).toEqual([]);
    await runMergeExecutor(w.deps, 'p1');
    expect(w.startFixer).toHaveBeenCalledTimes(2);
    expect(requests(w)).toHaveLength(1);
  });

  it('two colours on the same red head at once: one line typed, one fix counted, one request (F-27)', async () => {
    const w = world({ prs: [red('h1')] });
    owningRun(w);
    await Promise.all([runMergeExecutor(w.deps, 'p1'), runMergeExecutor({ ...w.deps, seen: new Map() }, 'p1')]);
    expect(w.type).toHaveBeenCalledTimes(1);
    expect(w.state.runs.find((r) => r.id === 'impl')!.fix_count).toBe(1);
    expect(requests(w)).toHaveLength(1);
  });

  it('two colours at the cap at once: one escalation', async () => {
    const w = world({ prs: [red('h1')], triggered: 3 });
    await Promise.all([runMergeExecutor(w.deps, 'p1'), runMergeExecutor({ ...w.deps, seen: new Map() }, 'p1')]);
    expect(w.state.events.filter((e) => e.kind === 'escalated')).toHaveLength(1);
    expect(w.state.messages).toHaveLength(1);
  });

  it('a pause or untag that lands during the pass: not even the cap escalates', async () => {
    const off = world({ setup: setupWith({ fix_attempts: 0 }), prs: [red('h1')] });
    vi.mocked(off.repos.projectSetup.get).mockResolvedValueOnce({ data: setupWith({ fix_attempts: 0 }) } as never).mockResolvedValue({ data: setupWith({ fix_attempts: 0, enabled: false }) } as never);
    const untagged = world({ setup: setupWith({ fix_attempts: 0 }), prs: [red('h1')] });
    let reads = 0;
    vi.mocked(untagged.repos.tasks.findById).mockImplementation((async (id: string) => (id === 'c1' && ++reads > 1 ? { ...CARD, auto: false } : id === 'c1' ? CARD : EPIC)) as never);
    for (const w of [off, untagged]) {
      await runMergeExecutor(w.deps, 'p1');
      expect(w.state.events).toEqual([]);
      expect(w.state.messages).toEqual([]);
    }
  });

  it('a line that fails to type counts nothing and gives the head back: the next sync types it', async () => {
    const w = world({ prs: [red('h1')] });
    owningRun(w);
    w.type.mockRejectedValueOnce(new Error('tab gone'));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.state.runs.find((r) => r.id === 'impl')!.fix_count).toBe(0);
    expect(requests(w)).toEqual([]);
    await runMergeExecutor(w.deps, 'p1');
    expect(w.type).toHaveBeenCalledTimes(2);
    expect(w.state.runs.find((r) => r.id === 'impl')!.fix_count).toBe(1);
    expect(requests(w)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ via: 'typed' }) })]);
  });

  it('an active run on another branch: nothing typed or started, the head is given back', async () => {
    const w = world({ prs: [red('h1')] });
    owningRun(w);
    w.state.runs.find((r) => r.id === 'impl')!.branch = 'other';
    await runMergeExecutor(w.deps, 'p1');
    expect(w.type).not.toHaveBeenCalled();
    expect(w.startFixer).not.toHaveBeenCalled();
    expect(requests(w)).toEqual([]);
  });

  it('typed CI fixes count against the conflict cap too', async () => {
    const w = world();
    w.state.runs.push({ id: 'impl', task_id: 'c1', role: 'implementer', trigger_sha: null, status: 'done', waiting_reason: null, tab_id: 'tab1', branch: BRANCH.c1!, fix_count: 3 });
    w.gh.pull.mockResolvedValue(w.pullFor({ mergeable: false, mergeable_state: 'dirty', head_sha: 'h1', base_ref: EPIC_BRANCH }));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.startFixer).not.toHaveBeenCalled();
    expect(w.state.events.filter((e) => e.kind === 'escalated')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: 'conflict_cap', attempts: 3 }) })]);
  });
});

describe('runs and fixes that must not stall (final review I2, I3)', () => {
  const NOW = new Date('2026-10-05T12:00:00Z');
  const red = (sha: string) => pr({ head_sha: sha, ci_state: 'failed', ci_summary: { total: 1, passed: 0, failed: 1, running: 0, failing: ['ci'] } });
  const escalations = (w: ReturnType<typeof world>) => w.state.events.filter((e) => e.kind === 'escalated');
  /** A startFixer that answers like the dispatcher: `taken` once this head's trigger (or an active run) exists. */
  const realisticFixer = (w: ReturnType<typeof world>) =>
    w.startFixer.mockImplementation(async (i) => {
      if (w.state.runs.some((r) => r.task_id === i.taskId && (r.trigger_sha === i.triggerSha || ['queued', 'starting', 'running', 'waiting'].includes(r.status)))) return 'taken';
      w.state.runs.push({ id: `r${w.state.runs.length + 1}`, task_id: i.taskId, role: 'fixer', trigger_sha: i.triggerSha, status: 'running', waiting_reason: null, tab_id: 'tabf', branch: i.branch, fix_count: 0 });
      return 'started';
    });

  it('a merge ends the card\'s run still on (parked on a question) done, so nothing is resumed into it', async () => {
    const w = world();
    w.state.runs.push({ id: 'impl', task_id: 'c1', role: 'implementer', trigger_sha: null, status: 'waiting', waiting_reason: 'permission_needed', tab_id: 'tab1', branch: BRANCH.c1!, fix_count: 0, claimed_by: 'blue' });
    await runMergeExecutor(w.deps, 'p1');
    expect(w.gh.merge).toHaveBeenCalledTimes(1);
    expect(w.state.runs.find((r) => r.id === 'impl')).toMatchObject({ status: 'done', waiting_reason: null });
    expect(w.state.events.find((e) => e.kind === 'run_done')).toMatchObject({ task_id: 'c1', payload: expect.objectContaining({ via: 'merged' }) });
    expect(w.state.events.some((e) => e.kind === 'pr_opened')).toBe(false);
  });

  it('a conflict fixer that ended without pushing (the head did not move) is escalated once, and the board says why', async () => {
    const w = world();
    realisticFixer(w);
    w.gh.pull.mockResolvedValue(w.pullFor({ mergeable: false, mergeable_state: 'dirty', head_sha: 'h1', base_ref: EPIC_BRANCH }));
    await runMergeExecutor(w.deps, 'p1');
    expect(w.startFixer).toHaveBeenCalledTimes(1);
    // while the fixer works nothing is escalated
    await runMergeExecutor(w.deps, 'p1');
    expect(escalations(w)).toEqual([]);
    // it ends without a push: the same head is still in conflict
    Object.assign(w.state.runs[0]!, { status: 'done', ended_at: NOW });
    await runMergeExecutor(w.deps, 'p1');
    await runMergeExecutor(w.deps, 'p1');
    expect(escalations(w)).toEqual([expect.objectContaining({ task_id: 'c1', payload: expect.objectContaining({ reason: 'conflict_cap', pr: 7, sha: 'h1', cause: 'fixer_no_push' }) })]);
    expect(w.state.messages).toHaveLength(1);
    expect(mergeWaitOf('c1', NOW)).toBe('merge_conflict_cap');
    // the marker does not count as a fix
    expect(w.state.runs.filter((r) => r.waiting_reason === 'conflict_cap')).toHaveLength(1);
  });

  it('the conflict cap escalates even while the card has a run parked for the person (the marker is never active)', async () => {
    const w = world({ triggered: 3 });
    w.state.runs.push({ id: 'impl', task_id: 'c1', role: 'implementer', trigger_sha: null, status: 'waiting', waiting_reason: 'resume_cap', tab_id: 'tab1', branch: BRANCH.c1!, fix_count: 0 });
    w.gh.pull.mockResolvedValue(w.pullFor({ mergeable: false, mergeable_state: 'dirty', head_sha: 'h1', base_ref: EPIC_BRANCH }));
    await runMergeExecutor(w.deps, 'p1');
    expect(escalations(w)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: 'conflict_cap', attempts: 3 }) })]);
  });

  it('a red-CI fixer that ended without a push on the same head: escalated once past the grace, the head\'s claim reads escalated', async () => {
    const w = world({ prs: [red('h1')] });
    realisticFixer(w);
    await runMergeExecutor(w.deps, 'p1');
    expect(w.startFixer).toHaveBeenCalledTimes(1);
    // ended a minute ago: a push may not have been synced yet
    Object.assign(w.state.runs[0]!, { status: 'done', ended_at: new Date(NOW.getTime() - 60_000) });
    await runMergeExecutor(w.deps, 'p1');
    expect(escalations(w)).toEqual([]);
    Object.assign(w.state.runs[0]!, { ended_at: new Date(NOW.getTime() - 4 * 60_000) });
    await runMergeExecutor(w.deps, 'p1');
    await runMergeExecutor(w.deps, 'p1');
    expect(escalations(w)).toEqual([expect.objectContaining({ task_id: 'c1', payload: expect.objectContaining({ reason: 'ci_cap', pr: 7, sha: 'h1', cause: 'fixer_no_push' }) })]);
    expect(w.state.events.filter((e) => e.kind === 'ci_fix_requested').map((e) => e.payload?.via)).toEqual(['escalated']);
    expect(mergeWaitOf('c1', NOW)).toBe('merge_ci_cap');
    expect(w.startFixer).toHaveBeenCalledTimes(1);
  });

  it('TER-1025: a fix that ended without a push while GitHub is down is held, then asked once more when GitHub works', async () => {
    const w = world({ prs: [red('h1')] });
    realisticFixer(w);
    let degraded = ['Git Operations'];
    w.deps.githubHealth = async () => ({ degraded });
    await runMergeExecutor(w.deps, 'p1');
    Object.assign(w.state.runs[0]!, { status: 'done', ended_at: new Date(NOW.getTime() - 4 * 60_000) });
    await runMergeExecutor(w.deps, 'p1');
    expect(escalations(w)).toEqual([]);
    expect(mergeWaitOf('c1', NOW)).toBe('merge_github_down');
    expect(w.startFixer).toHaveBeenCalledTimes(1);

    degraded = [];
    await runMergeExecutor(w.deps, 'p1');
    expect(escalations(w)).toEqual([]);
    expect(w.startFixer).toHaveBeenCalledTimes(2);
    expect(w.startFixer.mock.calls[1]![0]).toMatchObject({ triggerSha: 'h1:github' });

    // the retry ended without a push too: now the person is told
    Object.assign(w.state.runs[1]!, { status: 'done', ended_at: new Date(NOW.getTime() - 4 * 60_000) });
    await runMergeExecutor(w.deps, 'p1');
    expect(escalations(w)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: 'ci_cap', cause: 'fixer_no_push' }) })]);
    expect(w.startFixer).toHaveBeenCalledTimes(2);
  });

  it('a red head whose fix is still on (a run of the card active) is not escalated', async () => {
    const w = world({ prs: [red('h1')] });
    realisticFixer(w);
    await runMergeExecutor(w.deps, 'p1');
    await runMergeExecutor(w.deps, 'p1');
    expect(escalations(w)).toEqual([]);
  });
});
