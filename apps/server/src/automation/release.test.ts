import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationEventInput } from '../db/repositories/automation-events.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TaskPullRequest } from '../db/repositories/task-pull-requests.js';
import type { WorkflowRun } from '../ci/rules.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { deliveryPending, followMerged, type DeliveryCtx } from './release.js';

const pauseAutomation = vi.fn(async () => ({ paused_at: 'x' }));
vi.mock('./pause.js', () => ({ pauseAutomation: (...a: unknown[]) => (pauseAutomation as (...a: unknown[]) => unknown)(...a) }));

const run = (over: Partial<WorkflowRun>): WorkflowRun => ({ id: 1, name: 'Deploy', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/app/actions/runs/1', created_at: '2026-10-05T10:00:00Z', ...over });
const publish = (over: Partial<WorkflowRun> = {}) => run({ id: 9, name: 'Publish @termhub/agent', path: '.github/workflows/publish-agent.yml', html_url: 'https://github.com/acme/app/actions/runs/9', ...over });

const pr = (over: Partial<TaskPullRequest> = {}): TaskPullRequest => ({
  id: 'r1', project_id: 'p1', task_id: 't1', repo: 'acme/app', number: 7, url: 'u', title: 'x', head_ref: 'h', head_sha: 'h1', base_ref: 'main', state: 'merged', draft: false, merged_at: new Date(), merge_commit_sha: 'm1',
  ci_state: 'passed', ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null, release_runs: [], changed_level: 'release', synced_at: '', ...over,
});

function world(o: { enabled?: boolean; auto?: boolean; byCommit?: Record<string, WorkflowRun[]>; headSha?: string | null; ancestor?: boolean; pkg?: string | null; files?: string[]; pkgs?: Record<string, string>; noOwner?: boolean; releaseWorkflows?: string[] } = {}) {
  const events: AutomationEventInput[] = [];
  const messages: string[] = [];
  const updateCi = vi.fn(async () => {});
  const repos = {
    taskPullRequests: { updateCi },
    tasks: { findById: vi.fn(async () => ({ id: 't1', ref: 'TER-1', auto: o.auto ?? true })) },
    automationEvents: { insert: vi.fn(async (e: AutomationEventInput) => (events.push(e), { id: `e${events.length}`, ...e, created_at: '' })) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    users: { findById: vi.fn(async () => (o.noOwner ? undefined : { id: 'u1', locale: null })) },
    chat: {
      findLatestActiveForProject: vi.fn(async () => ({ id: 'c1' })),
      addMessage: vi.fn(async (m: { text: string }) => (messages.push(m.text), { id: 'm', ...m })),
    },
  } as unknown as Repositories;
  const github = {
    listRuns: vi.fn(async (_t: string, _r: string, sha: string) => o.byCommit?.[sha] ?? []),
    branchSha: vi.fn(async () => (o.headSha === undefined ? 'm2' : o.headSha)),
    isAncestor: vi.fn(async () => o.ancestor ?? true),
    prFiles: vi.fn(async () => o.files ?? []),
    fileAt: vi.fn(async (_t: string, _r: string, path: string) => (o.pkgs ? (o.pkgs[path] ?? null) : o.pkg === undefined ? JSON.stringify({ name: '@termhub/agent', version: '0.19.0' }) : o.pkg)),
  };
  const setup = { repo: { deploy_workflow: 'deploy.yml' }, automation: { enabled: o.enabled ?? true, release_workflows: o.releaseWorkflows ?? ['publish-agent.yml'], release_paths: ['apps/agent/**', 'package.json'] } } as unknown as ProjectSetupData;
  const ctx: DeliveryCtx = { projectId: 'p1', ownerId: 'u1', token: 'tok', repo: 'acme/app', setup };
  return { deps: { repos, github }, ctx, events, messages, updateCi, github, setup };
}
const kinds = (events: AutomationEventInput[]) => events.map((e) => e.kind);

beforeEach(() => pauseAutomation.mockClear());

describe('followMerged: deploy', () => {
  it('a passed deploy is recorded once with its run URL and ids', async () => {
    const w = world({ byCommit: { m1: [run({})] } });
    await followMerged(w.deps, w.ctx, pr({ changed_level: 'deploy' }));
    expect(kinds(w.events)).toEqual(['deploy_ok']);
    expect(w.events[0].payload).toEqual({ pr: 7, sha: 'm1', url: 'https://github.com/acme/app/actions/runs/1', workflow: 'deploy.yml' });
    expect(w.updateCi).toHaveBeenCalledWith('p1', 'acme/app', 7, { deploy_state: 'passed', deploy_url: 'https://github.com/acme/app/actions/runs/1' });
    expect(pauseAutomation).not.toHaveBeenCalled();
  });

  it('a failed deploy stores its state last, so a throw before that retries; the event says whether it paused', async () => {
    const w = world({ byCommit: { m1: [run({ conclusion: 'failure' })] } });
    const order: string[] = [];
    pauseAutomation.mockImplementationOnce(async () => (order.push('pause'), { paused_at: 'x' }));
    w.updateCi.mockImplementation(async () => void order.push('store'));
    await followMerged(w.deps, w.ctx, pr());
    expect(order).toEqual(['pause', 'store']);
    expect(w.events[0].payload).toMatchObject({ paused: true });

    const boom = world({ byCommit: { m1: [run({ conclusion: 'failure' })] } });
    (boom.deps.repos.automationEvents.insert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    await expect(followMerged(boom.deps, boom.ctx, pr())).rejects.toThrow('db down');
    expect(pauseAutomation).toHaveBeenCalledTimes(2);
    expect(boom.updateCi).not.toHaveBeenCalled();
  });

  it('without an owner it cannot pause, and says so instead of claiming it', async () => {
    const w = world({ noOwner: true, byCommit: { m1: [run({ conclusion: 'failure' })] } });
    await followMerged(w.deps, w.ctx, pr());
    expect(pauseAutomation).not.toHaveBeenCalled();
    expect(w.events[0].payload).toMatchObject({ paused: false });
    expect(w.events[1].payload).toMatchObject({ reason: 'deploy_failed_not_paused' });
  });

  it('automation off keeps the plain deploy lookup: no cancelled-follow, no extra GitHub calls', async () => {
    const w = world({ enabled: false, byCommit: { m1: [run({ conclusion: 'cancelled' })], m2: [run({ id: 2 })] } });
    await followMerged(w.deps, w.ctx, pr());
    expect(w.github.branchSha).not.toHaveBeenCalled();
    expect(w.github.isAncestor).not.toHaveBeenCalled();
    expect(w.github.listRuns).toHaveBeenCalledTimes(1);
    expect(w.updateCi).toHaveBeenCalledWith('p1', 'acme/app', 7, { deploy_state: 'none', deploy_url: null });
  });

  it('a failed deploy pauses only that project, escalates once and tells the chat', async () => {
    const w = world({ byCommit: { m1: [run({ conclusion: 'failure' })] } });
    await followMerged(w.deps, w.ctx, pr());
    expect(kinds(w.events)).toEqual(['deploy_failed', 'escalated']);
    expect(w.events[1].payload).toMatchObject({ reason: 'deploy_failed', pr: 7 });
    expect(w.events[1].run_id ?? null).toBeNull();
    expect(pauseAutomation).toHaveBeenCalledTimes(1);
    expect(pauseAutomation).toHaveBeenCalledWith(expect.anything(), { scope: 'p1', reason: 'deploy_failed' });
    expect(w.messages).toHaveLength(1);
    expect(w.messages[0]).toContain('TER-1');
  });

  it('does not report again for a deploy that already finished', async () => {
    const w = world({ byCommit: { m1: [run({ conclusion: 'failure' })] } });
    await followMerged(w.deps, w.ctx, pr({ deploy_state: 'failed' }));
    expect(w.events).toEqual([]);
    expect(pauseAutomation).not.toHaveBeenCalled();
  });

  it('a running deploy records nothing', async () => {
    const w = world({ byCommit: { m1: [run({ status: 'in_progress', conclusion: null })] } });
    await followMerged(w.deps, w.ctx, pr());
    expect(w.events).toEqual([]);
    expect(w.updateCi).toHaveBeenCalledWith('p1', 'acme/app', 7, expect.objectContaining({ deploy_state: 'running' }));
  });

  it('a cancelled deploy is not a failure: it follows the newest main run that contains the merge', async () => {
    const w = world({ byCommit: { m1: [run({ conclusion: 'cancelled' })], m2: [run({ id: 2, html_url: 'https://github.com/acme/app/actions/runs/2', conclusion: 'success' })] } });
    await followMerged(w.deps, w.ctx, pr({ changed_level: 'deploy' }));
    expect(w.github.isAncestor).toHaveBeenCalledWith('tok', 'acme/app', 'm1', 'm2');
    expect(kinds(w.events)).toEqual(['deploy_ok']);
    expect(w.events[0].payload).toMatchObject({ url: 'https://github.com/acme/app/actions/runs/2' });
    expect(pauseAutomation).not.toHaveBeenCalled();
  });

  it('a cancelled deploy with nothing newer yet stays pending and silent', async () => {
    const w = world({ byCommit: { m1: [run({ conclusion: 'cancelled' })] }, headSha: 'm1' });
    await followMerged(w.deps, w.ctx, pr());
    expect(w.events).toEqual([]);
    expect(w.updateCi).toHaveBeenCalledWith('p1', 'acme/app', 7, expect.objectContaining({ deploy_state: 'none', deploy_url: null }));
  });

  it('a newer main run that does not contain the merge is not followed', async () => {
    const w = world({ byCommit: { m1: [run({ conclusion: 'cancelled' })], m2: [run({ id: 2, conclusion: 'failure' })] }, ancestor: false });
    await followMerged(w.deps, w.ctx, pr());
    expect(w.events).toEqual([]);
    expect(pauseAutomation).not.toHaveBeenCalled();
  });

  it('with automation off it stores the state and records nothing', async () => {
    const w = world({ enabled: false, byCommit: { m1: [run({ conclusion: 'failure' })] } });
    await followMerged(w.deps, w.ctx, pr());
    expect(w.updateCi).toHaveBeenCalledWith('p1', 'acme/app', 7, { deploy_state: 'failed', deploy_url: expect.any(String) });
    expect(w.events).toEqual([]);
    expect(w.messages).toEqual([]);
    expect(pauseAutomation).not.toHaveBeenCalled();
  });

  it('a card that is not automatic records nothing', async () => {
    const w = world({ auto: false, byCommit: { m1: [run({ conclusion: 'failure' })] } });
    await followMerged(w.deps, w.ctx, pr());
    expect(w.events).toEqual([]);
    expect(pauseAutomation).not.toHaveBeenCalled();
  });
});

describe('followMerged: release workflows', () => {
  it('matches a release workflow by file name or by name and records release_ok with the merged version', async () => {
    const byFile = world({ byCommit: { m1: [run({}), publish()] } });
    await followMerged(byFile.deps, byFile.ctx, pr({ deploy_state: 'passed' }));
    expect(kinds(byFile.events)).toEqual(['release_ok']);
    expect(byFile.events[0].payload).toEqual({ pr: 7, sha: 'm1', url: 'https://github.com/acme/app/actions/runs/9', workflow: 'publish-agent.yml', version: '0.19.0' });
    expect(byFile.github.fileAt).toHaveBeenCalledWith('tok', 'acme/app', 'package.json', 'm1');
    expect(byFile.messages).toEqual(['Publicado publish-agent.yml 0.19.0']);

    const byName = world({ releaseWorkflows: ['Publish @termhub/agent'], byCommit: { m1: [publish()] } });
    await followMerged(byName.deps, byName.ctx, pr({ deploy_state: 'passed' }));
    expect(kinds(byName.events)).toEqual(['release_ok']);
  });

  it('a failed release escalates and does not pause', async () => {
    const w = world({ byCommit: { m1: [publish({ conclusion: 'failure' })] } });
    await followMerged(w.deps, w.ctx, pr({ deploy_state: 'passed' }));
    expect(kinds(w.events)).toEqual(['release_failed', 'escalated']);
    expect(w.events[1].payload).toMatchObject({ reason: 'release_failed' });
    expect(pauseAutomation).not.toHaveBeenCalled();
    expect(w.messages).toHaveLength(1);
  });

  it('is followed only for a PR that changed release paths', async () => {
    const w = world({ byCommit: { m1: [publish({ conclusion: 'failure' })] } });
    await followMerged(w.deps, w.ctx, pr({ deploy_state: 'passed', changed_level: 'deploy' }));
    expect(w.events).toEqual([]);
    expect(w.updateCi.mock.calls[0]?.[3]).not.toHaveProperty('release_runs');
  });

  it('reports a release once, and keeps the version off a private package', async () => {
    const done = world({ byCommit: { m1: [publish()] } });
    await followMerged(done.deps, done.ctx, pr({ deploy_state: 'passed', release_runs: [{ workflow: 'publish-agent.yml', state: 'passed', url: 'u', version: '0.19.0' }] }));
    expect(done.events).toEqual([]);

    const priv = world({ byCommit: { m1: [publish()] }, pkg: JSON.stringify({ version: '1.0.0', private: true }) });
    await followMerged(priv.deps, priv.ctx, pr({ deploy_state: 'passed' }));
    expect(priv.events[0].payload).not.toHaveProperty('version');
  });

  it('reads the version from the package.json the PR changed under release_paths, falling back to the root', async () => {
    const nested = world({ byCommit: { m1: [publish()] }, files: ['apps/agent/package.json', 'apps/web/package.json'], pkgs: { 'package.json': JSON.stringify({ version: '1.0.0', private: true }), 'apps/agent/package.json': JSON.stringify({ name: '@termhub/agent', version: '0.19.1' }) } });
    await followMerged(nested.deps, nested.ctx, pr({ deploy_state: 'passed' }));
    expect(nested.events[0].payload).toMatchObject({ version: '0.19.1' });
    expect(nested.github.fileAt).not.toHaveBeenCalledWith('tok', 'acme/app', 'apps/web/package.json', 'm1');

    const root = world({ byCommit: { m1: [publish()] }, files: ['apps/agent/src/x.ts'] });
    await followMerged(root.deps, root.ctx, pr({ deploy_state: 'passed' }));
    expect(root.events[0].payload).toMatchObject({ version: '0.19.0' });
  });

  it('a cancelled release is not a failure', async () => {
    const w = world({ byCommit: { m1: [publish({ conclusion: 'cancelled' })] }, headSha: null });
    await followMerged(w.deps, w.ctx, pr({ deploy_state: 'passed' }));
    expect(w.events).toEqual([]);
  });
});

describe('deliveryPending', () => {
  const setup = (over: object) => ({ repo: { deploy_workflow: 'deploy.yml' }, automation: { enabled: true, release_workflows: ['publish-agent.yml'], ...over } }) as unknown as ProjectSetupData;
  it('waits for the deploy, then for each release workflow of a release-level PR', () => {
    expect(deliveryPending(setup({}), pr({ deploy_state: 'running' }))).toBe(true);
    expect(deliveryPending(setup({}), pr({ deploy_state: 'passed' }))).toBe(true);
    expect(deliveryPending(setup({}), pr({ deploy_state: 'passed', release_runs: [{ workflow: 'publish-agent.yml', state: 'passed', url: null, version: null }] }))).toBe(false);
    expect(deliveryPending(setup({}), pr({ deploy_state: 'passed', changed_level: 'deploy' }))).toBe(false);
    expect(deliveryPending(setup({ enabled: false }), pr({ deploy_state: 'passed' }))).toBe(false);
  });
});

describe('the chat hears of deliveries (spec D25)', () => {
  it('a finished deploy posts one line; a failed one posts only its escalation line', async () => {
    const ok = world({ byCommit: { m1: [run({ conclusion: 'success' })] } });
    await followMerged(ok.deps, ok.ctx, pr());
    expect(kinds(ok.events)).toEqual(['deploy_ok']);
    expect(ok.messages).toHaveLength(1);
    expect(ok.messages[0]).toContain('Deploy concluído');
    const failed = world({ byCommit: { m1: [run({ conclusion: 'failure' })] } });
    await followMerged(failed.deps, failed.ctx, pr());
    expect(failed.messages).toHaveLength(1);
    expect(failed.messages[0]).not.toContain('Deploy concluído');
  });
});
