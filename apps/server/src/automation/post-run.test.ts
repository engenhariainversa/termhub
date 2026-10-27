import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { AutomationEventInput } from '../db/repositories/automation-events.js';
import type { Tab } from '../db/repositories/types.js';
import { isTypedRequest, reopenedRunNote, reopenRunInTab } from './post-run.js';

const ME = 'instance-me';
const ended = new Date('2026-10-22T10:00:00.000Z');

/** A tab whose last run ended, the card it worked on, and fakes that keep the new run and the events. */
function world(o: { prev?: Partial<AutomationRun>; active?: boolean; enabled?: boolean; paused?: boolean; task?: Record<string, unknown> | null; claimTaken?: boolean } = {}) {
  const prev: AutomationRun = {
    id: 'run0', project_id: 'p1', task_id: 't1', role: 'implementer', status: 'done', waiting_reason: null, tab_id: 'tab1', machine_id: 'm1', account_id: 'a1',
    branch: 'TER-1-card', worktree_path: '/w/TER-1', resume_count: 2, fix_count: 0, restart_count: 0, allowed_tools: ['Bash(git *)'], last_typed_at: null, woken_at: null,
    trigger_sha: null, cleanup_state: null, cleanup_attempts: 0, claimed_by: 'old-instance', heartbeat_at: ended, started_at: ended, ended_at: ended, created_at: ended, ...o.prev,
  };
  const tab = { id: 'tab1', project_id: 'p1', machine_id: 'm1', ai_account_id: 'a2', name: 'TER-1' } as Tab;
  const events: AutomationEventInput[] = [];
  const claimed: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const repos = {
    automationRuns: {
      activeByTab: vi.fn(async () => (o.active ? { ...prev, status: 'running' } : null)),
      latestByTab: vi.fn(async () => prev),
      claim: vi.fn(async (i: Record<string, unknown>) => (o.claimTaken ? null : (claimed.push(i), { ...prev, id: 'run1', status: 'queued', claimed_by: ME, tab_id: null, ended_at: null }))),
      update: vi.fn(async (_id: string, _instance: string, patch: Record<string, unknown>) => (updates.push(patch), true)),
      noteTyped: vi.fn(async () => {}),
    },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    projectSetup: { get: vi.fn(async () => ({ data: { automation: { enabled: o.enabled ?? true } } })) },
    tasks: { findById: vi.fn(async () => (o.task === null ? undefined : { id: 't1', ref: 'TER-1', title: 'Card', status: 'doing', auto: true, ...o.task })) },
    automationPauses: { state: vi.fn(async () => ({ user: o.paused ? new Date() : null, project: null })) },
    automationEvents: { insert: vi.fn(async (e: AutomationEventInput) => (events.push(e), { ...e, id: `e${events.length}`, created_at: '' })) },
  } as unknown as Repositories;
  const at = new Date('2026-10-22T12:00:00.000Z');
  const deps = { repos, instance: ME, lifecycle: { draining: false }, now: () => at };
  return { prev, tab, events, claimed, updates, repos, deps, at };
}

describe('reopenRunInTab (TER-1112)', () => {
  it('a typed request in a tab whose run ended reopens a running run of the card on the same branch', async () => {
    const w = world();
    const run = await reopenRunInTab(w.deps, w.tab);
    expect(run).toMatchObject({ id: 'run1', status: 'running', tab_id: 'tab1', branch: 'TER-1-card' });
    expect(w.claimed).toEqual([{ project_id: 'p1', task_id: 't1', role: 'implementer', instance: ME }]);
    expect(w.updates[0]).toEqual({
      status: 'running', tab_id: 'tab1', machine_id: 'm1', account_id: 'a2', branch: 'TER-1-card', worktree_path: '/w/TER-1', allowed_tools: ['Bash(git *)'], started_at: w.at,
    });
    expect(w.repos.automationRuns.noteTyped).toHaveBeenCalledWith('run1', w.at);
    expect(w.events).toEqual([expect.objectContaining({ kind: 'run_resumed', run_id: 'run1', task_id: 't1', payload: { tab_id: 'tab1', by: 'prompt', reopened: true, previous_run_id: 'run0' } })]);
  });

  it('a run that ended blocked reopens too', async () => {
    expect(await reopenRunInTab(world({ prev: { status: 'blocked', waiting_reason: 'reported_blocked' } }).deps, world().tab)).not.toBeNull();
  });

  it('reopens nothing while a run is active, or for a cancelled or failed run', async () => {
    for (const w of [world({ active: true }), world({ prev: { status: 'cancelled' } }), world({ prev: { status: 'failed' } })]) {
      expect(await reopenRunInTab(w.deps, w.tab)).toBeNull();
      expect(w.claimed).toEqual([]);
    }
  });

  it('reopens nothing with automation off or paused, while draining, or on a card gone, untagged or done', async () => {
    const cases = [world({ enabled: false }), world({ paused: true }), world({ task: null }), world({ task: { auto: false } }), world({ task: { status: 'done' } })];
    for (const w of cases) {
      expect(await reopenRunInTab(w.deps, w.tab)).toBeNull();
      expect(w.claimed).toEqual([]);
      expect(w.events).toEqual([]);
    }
    const draining = world();
    expect(await reopenRunInTab({ ...draining.deps, lifecycle: { draining: true } }, draining.tab)).toBeNull();
    expect(draining.repos.automationRuns.latestByTab).not.toHaveBeenCalled();
  });

  it('a lost claim (the card got a run meanwhile) writes nothing', async () => {
    const w = world({ claimTaken: true });
    expect(await reopenRunInTab(w.deps, w.tab)).toBeNull();
    expect(w.updates).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('a tab of another project, or a run with no card, reopens nothing', async () => {
    expect(await reopenRunInTab(world({ prev: { project_id: 'p2' } }).deps, world().tab)).toBeNull();
    expect(await reopenRunInTab(world({ prev: { task_id: null } }).deps, world().tab)).toBeNull();
  });

  it('never throws', async () => {
    const w = world();
    (w.repos.automationRuns.claim as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('db'), { code: 'P1001' }));
    expect(await reopenRunInTab(w.deps, w.tab)).toBeNull();
  });
});

describe('isTypedRequest', () => {
  it('a request someone typed, not a slash command or a queued notification', () => {
    expect(isTypedRequest('ajusta o teste')).toBe(true);
    expect(isTypedRequest('  /clear')).toBe(false);
    expect(isTypedRequest('<task-notification>x</task-notification>')).toBe(false);
    expect(isTypedRequest('   ')).toBe(false);
    expect(isTypedRequest(undefined)).toBe(false);
  });
});

describe('reopenedRunNote', () => {
  it('tells the agent its run, branch and how to report, with the title as quoted data', () => {
    const note = reopenedRunNote({ id: 'run1', branch: 'TER-1-card' }, { ref: 'TER-1', title: 'Card «x»\nnova linha' });
    expect(note).toMatch(/^termhub automatic work note: this message reopened automatic work on card TER-1 \(«Card x nova linha»\), run run1, on branch TER-1-card\./);
    expect(note).toContain('call report_card');
    expect(note).not.toContain('\n');
  });
});
