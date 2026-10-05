import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { Task } from '../db/repositories/types.js';
import type { GithubWriteClient } from '../integrations/github-write.js';
import { setupSchema, type ProjectSetupData } from '../setup/schema.js';
import { cardUrl } from '../control/tasks.js';
import { epicBranchName } from './branches.js';
import type { TriggeredRun } from './dispatcher.js';
import { epicReady, INTEGRATOR_CAP, integrateEpic } from './integrator.js';
import { integratorPrompt } from './prompts.js';
import { policyText } from './policy.js';

const EPIC = { id: 'e1', project_id: 'p1', ref: 'TER-1', title: 'Termhub agêntico', type: 'epic', status: 'doing', auto: true, parent_id: null, epic_id: null } as Task;
const EPIC_BRANCH = epicBranchName('epic/{ref}-{slug}', EPIC);
const card = (id: string, ref: string, over: Partial<Task> = {}) => ({ id, project_id: 'p1', ref, title: `Card ${ref}`, type: 'story', status: 'done', auto: true, parent_id: null, epic_id: 'e1', ...over }) as Task;
const CARDS = [card('c1', 'TER-5'), card('c2', 'TER-6')];

const pr = (task_id: string, number: number, over: Partial<TaskPullRequest> = {}) =>
  ({ id: `pr${number}`, project_id: 'p1', task_id, repo: 'acme/app', number, url: `https://github.com/acme/app/pull/${number}`, title: 't', head_ref: `b${number}`, head_sha: 's', base_ref: EPIC_BRANCH, state: 'merged', draft: false, ...over }) as TaskPullRequest;

function setupWith(automation: Record<string, unknown> = {}): ProjectSetupData {
  return setupSchema.parse({ repo: { integration_id: 'i1', full_name: 'acme/app', base_branch: 'main', deploy_workflow: null }, automation: { enabled: true, ...automation } });
}

function world(o: { board?: Task[]; prs?: TaskPullRequest[]; paused?: boolean; runs?: string[] } = {}) {
  const state = {
    board: o.board ?? [EPIC, ...CARDS, card('x1', 'TER-9', { epic_id: 'e2', status: 'doing' })],
    prs: o.prs ?? [pr('c1', 7), pr('c2', 8)],
    paused: o.paused ?? false,
    /** the epic's integrator runs (statuses), as the claim wrote them */
    runs: [...(o.runs ?? [])] as string[],
    triggers: new Set<string>(),
    open: null as { number: number; url: string } | null,
    head: 'eh1',
    events: [] as Array<{ kind: string; task_id?: string | null; payload?: Record<string, unknown> }>,
  };
  const repos = {
    projects: { findById: vi.fn(async (id: string) => ({ id, key: 'TER', owner_id: 'u1' })) },
    integrations: { findById: vi.fn(async () => ({ id: 'i1', provider: 'github', owner_id: 'u1' })), getSecret: vi.fn(async () => 'tok') },
    automationPauses: { state: vi.fn(async () => ({ user: null, project: state.paused ? new Date() : null })) },
    automationRuns: { triggeredStatuses: vi.fn(async () => [...state.runs]) },
    tasks: { listByProject: vi.fn(async () => state.board) },
    taskPullRequests: { listByTasks: vi.fn(async (ids: string[]) => state.prs.filter((p) => ids.includes(p.task_id))) },
    automationEvents: {
      insert: vi.fn(async (e: { kind: string }) => {
        state.events.push(e);
        return { id: 'ev', created_at: '', ...e };
      }),
    },
  } as unknown as Repositories;
  const gh = {
    findOpenPull: vi.fn(async () => state.open),
    openPull: vi.fn(async () => (state.open = { number: 42, url: 'https://github.com/acme/app/pull/42' })),
    branchSha: vi.fn(async () => state.head),
  };
  // the dispatcher's claim: one run per (epic, role, head), and one active run per card
  const startTriggered = vi.fn(async (i: TriggeredRun) => {
    if (state.triggers.has(i.triggerSha) || state.runs.includes('running')) return 'taken' as const;
    state.triggers.add(i.triggerSha);
    state.runs.push('running');
    return 'started' as const;
  });
  const lifecycle = { draining: false };
  const deps = { repos, gh: gh as unknown as GithubWriteClient, lifecycle, startTriggered };
  return { state, repos, gh, startTriggered, lifecycle, deps };
}

describe('epicReady', () => {
  const merged = [pr('c1', 7), pr('c2', 8)];
  it('false with a card in doing', () => {
    expect(epicReady({ cards: [CARDS[0]!, card('c2', 'TER-6', { status: 'doing' })], prs: merged, epicBranch: EPIC_BRANCH })).toBe(false);
  });
  it('false with a card PR still open, or merged into another branch', () => {
    expect(epicReady({ cards: CARDS, prs: [pr('c1', 7), pr('c2', 8, { state: 'open' })], epicBranch: EPIC_BRANCH })).toBe(false);
    expect(epicReady({ cards: CARDS, prs: [pr('c1', 7), pr('c2', 8, { base_ref: 'main' })], epicBranch: EPIC_BRANCH })).toBe(false);
  });
  it('false with no card (the epic itself does not count)', () => {
    expect(epicReady({ cards: [], prs: [], epicBranch: EPIC_BRANCH })).toBe(false);
    expect(epicReady({ cards: [EPIC], prs: [], epicBranch: EPIC_BRANCH })).toBe(false);
  });
  it('true when every card is done and its PRs are merged into the epic branch (a card without PR, or a PR closed unmerged, is fine)', () => {
    expect(epicReady({ cards: CARDS, prs: merged, epicBranch: EPIC_BRANCH })).toBe(true);
    expect(epicReady({ cards: [...CARDS, card('c3', 'TER-7')], prs: [...merged, pr('c1', 6, { state: 'closed', base_ref: 'main' })], epicBranch: EPIC_BRANCH })).toBe(true);
  });
});

describe('integrateEpic', () => {
  it('opens the epic PR once (English title and body, not draft) and starts one integrator run on the epic branch head', async () => {
    const w = world();
    const setup = setupWith();
    await integrateEpic(w.deps, EPIC, setup);
    await integrateEpic(w.deps, EPIC, setup);

    expect(w.gh.openPull).toHaveBeenCalledTimes(1);
    const [, repo, args] = w.gh.openPull.mock.calls[0] as unknown as [string, string, { head: string; base: string; title: string; body: string; draft: boolean }];
    expect(repo).toBe('acme/app');
    expect(args).toMatchObject({ head: EPIC_BRANCH, base: 'main', draft: false, title: `TER-1: integrate ${EPIC_BRANCH}` });
    expect(args.body).toContain('Part of TER-1');
    expect(args.body).toContain('- TER-5 Card TER-5 (#7)');
    expect(args.body).toContain('- TER-6 Card TER-6 (#8)');
    expect(args.body).toContain('Impact on other users: see each card PR.');
    expect(args.body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b/i);
    expect(args.body).not.toContain('TER-9'); // another epic's card

    expect(w.state.events).toEqual([expect.objectContaining({ kind: 'pr_opened', task_id: 'e1', payload: { pr_url: 'https://github.com/acme/app/pull/42', number: 42, branch: EPIC_BRANCH } })]);
    expect(w.startTriggered).toHaveBeenCalledTimes(1);
    expect(w.startTriggered).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 'e1',
      role: 'integrator',
      triggerSha: 'eh1',
      branch: EPIC_BRANCH,
      base: 'main',
      prompt: integratorPrompt({
        epic: { ref: 'TER-1', url: cardUrl('TER-1'), title: EPIC.title },
        branch: EPIC_BRANCH,
        base: 'main',
        prUrl: 'https://github.com/acme/app/pull/42',
        policy: policyText(setup.automation, null),
        custom: null,
      }),
    });
  });

  it('a second call finds the open PR instead of opening another, and the same head never gets a second run', async () => {
    const w = world();
    w.state.open = { number: 42, url: 'https://github.com/acme/app/pull/42' };
    await integrateEpic(w.deps, EPIC, setupWith());
    expect(w.gh.openPull).not.toHaveBeenCalled();
    expect(w.state.events).toEqual([]);
    expect(w.startTriggered).toHaveBeenCalledTimes(1);
    // the run ended blocked on that head: the same head does not start another
    w.state.runs = ['blocked'];
    await integrateEpic(w.deps, EPIC, setupWith());
    expect(w.startTriggered).toHaveBeenCalledTimes(2);
    await expect(w.startTriggered.mock.results[1]!.value).resolves.toBe('taken');
  });

  it('no place now (waiting): nothing is kept, the next tick finds the PR and tries again', async () => {
    const w = world();
    w.startTriggered.mockResolvedValueOnce('waiting');
    await integrateEpic(w.deps, EPIC, setupWith());
    await integrateEpic(w.deps, EPIC, setupWith());
    expect(w.gh.openPull).toHaveBeenCalledTimes(1);
    expect(w.startTriggered).toHaveBeenCalledTimes(2);
    expect(w.state.runs).toEqual(['running']);
  });

  it('the other colour opened the PR a moment ago: found, no second pr_opened, the run starts', async () => {
    const w = world();
    w.gh.findOpenPull.mockResolvedValueOnce(null).mockResolvedValueOnce({ number: 43, url: 'https://github.com/acme/app/pull/43' });
    w.gh.openPull.mockRejectedValueOnce(Object.assign(new Error('422'), { kind: 'http' }));
    await integrateEpic(w.deps, EPIC, setupWith());
    expect(w.state.events).toEqual([]);
    expect(w.startTriggered).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('https://github.com/acme/app/pull/43') }));
  });

  it(`spike R2: none after an integrator finished done, and at most ${INTEGRATOR_CAP} per epic`, async () => {
    for (const runs of [['done'], ['blocked', 'failed'], ['waiting']]) {
      const w = world({ runs });
      await integrateEpic(w.deps, EPIC, setupWith());
      expect(w.gh.findOpenPull).not.toHaveBeenCalled();
      expect(w.startTriggered).not.toHaveBeenCalled();
    }
    // one blocked run and a new head (a person pushed): a second run
    const w = world({ runs: ['blocked'] });
    w.state.head = 'eh2';
    await integrateEpic(w.deps, EPIC, setupWith());
    expect(w.startTriggered).toHaveBeenCalledTimes(1);
  });

  it('a person closed or merged the epic PR: termhub opens no other and starts nothing', async () => {
    for (const state of ['closed', 'merged'] as const) {
      const w = world({ prs: [pr('c1', 7), pr('c2', 8), pr('e1', 42, { head_ref: EPIC_BRANCH, base_ref: 'main', state })], runs: ['blocked'] });
      await integrateEpic(w.deps, EPIC, setupWith());
      expect(w.gh.findOpenPull).not.toHaveBeenCalled();
      expect(w.gh.openPull).not.toHaveBeenCalled();
      expect(w.startTriggered).not.toHaveBeenCalled();
    }
  });

  it('runs cancelled by a pause or a sweep do not count against the cap', async () => {
    const w = world({ runs: ['cancelled', 'cancelled'] });
    await integrateEpic(w.deps, EPIC, setupWith());
    expect(w.startTriggered).toHaveBeenCalledTimes(1);
  });

  it('not ready (a card still doing, a card PR still open): no PR, no run', async () => {
    for (const o of [{ board: [EPIC, card('c1', 'TER-5', { status: 'doing' })] }, { prs: [pr('c1', 7, { state: 'open' })] }]) {
      const w = world(o);
      await integrateEpic(w.deps, EPIC, setupWith());
      expect(w.gh.findOpenPull).not.toHaveBeenCalled();
      expect(w.gh.openPull).not.toHaveBeenCalled();
      expect(w.startTriggered).not.toHaveBeenCalled();
    }
  });

  it('automation off, paused, draining, a manual or finished epic: nothing at all', async () => {
    const cases: Array<{ w: ReturnType<typeof world>; setup: ProjectSetupData; epic: Task }> = [];
    cases.push({ w: world(), setup: setupWith({ enabled: false }), epic: EPIC });
    cases.push({ w: world({ paused: true }), setup: setupWith(), epic: EPIC });
    const draining = world();
    draining.lifecycle.draining = true;
    cases.push({ w: draining, setup: setupWith(), epic: EPIC });
    cases.push({ w: world(), setup: setupWith(), epic: { ...EPIC, auto: false } });
    cases.push({ w: world(), setup: setupWith(), epic: { ...EPIC, status: 'done' } });
    for (const { w, setup, epic } of cases) {
      await integrateEpic(w.deps, epic, setup);
      expect(w.gh.findOpenPull).not.toHaveBeenCalled();
      expect(w.gh.openPull).not.toHaveBeenCalled();
      expect(w.startTriggered).not.toHaveBeenCalled();
      expect(w.state.events).toEqual([]);
    }
  });
});
