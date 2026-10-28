import { describe, expect, it } from 'vitest';
import { setupSchema, type ProjectSetupData } from '../setup/schema.js';
import { deliveryOf, epicMayDie, epicPhaseOf, epicPullsOf, type LifecyclePr } from './epic-phase.js';

const BRANCH = 'epic/TER-1-identidade';
const setup = (repo: Record<string, unknown> = {}, automation: Record<string, unknown> = {}): ProjectSetupData =>
  setupSchema.parse({ repo: { integration_id: 'i1', full_name: 'o/r', base_branch: 'main', deploy_workflow: 'deploy.yml', ...repo }, automation: { enabled: true, autonomy: 'release', ...automation } });
const pr = (over: Partial<LifecyclePr> = {}): LifecyclePr => ({
  number: 50, state: 'open', head_ref: BRANCH, ci_state: 'passed', deploy_state: 'none', release_runs: [], changed_level: 'deploy', mention_only: false, ...over,
});
const story = (status: 'backlog' | 'todo' | 'doing' | 'done') => ({ type: 'story' as const, status });
const phase = (i: Partial<Parameters<typeof epicPhaseOf>[0]>) => epicPhaseOf({ status: 'doing', cards: [], epicPrs: [], setup: setup(), ...i });

describe('epicPhaseOf (TER-1150)', () => {
  it('born: no card started is not started; the epic in Fazendo or a card started is in progress', () => {
    expect(phase({ status: 'backlog', cards: [story('todo'), story('backlog')] }).phase).toBe('not_started');
    expect(phase({ status: 'doing', cards: [story('todo')] }).phase).toBe('in_progress');
    expect(phase({ status: 'todo', cards: [story('done'), story('todo')] }).phase).toBe('in_progress');
  });

  it('every story done is integrating, with or without the epic PR yet, never done', () => {
    expect(phase({ cards: [story('done'), story('done')] })).toEqual({ phase: 'integrating', failure: null, pr: null });
    const open = pr();
    expect(phase({ cards: [story('done')], epicPrs: [open] })).toEqual({ phase: 'integrating', failure: null, pr: open });
  });

  it('the epic PR red or held by the conflict cap is failed, saying which', () => {
    expect(phase({ cards: [story('done')], epicPrs: [pr({ ci_state: 'failed' })] })).toMatchObject({ phase: 'failed', failure: 'ci' });
    expect(phase({ cards: [story('done')], epicPrs: [pr()], wait: 'merge_conflict_cap' })).toMatchObject({ phase: 'failed', failure: 'conflict' });
    expect(phase({ cards: [story('done')], epicPrs: [pr()], wait: 'merge_ci_cap' })).toMatchObject({ phase: 'failed', failure: 'ci' });
  });

  it('merged with a deploy running is delivering; a failed deploy or release is failed', () => {
    expect(phase({ cards: [story('done')], epicPrs: [pr({ state: 'merged', deploy_state: 'running' })] }).phase).toBe('delivering');
    expect(phase({ cards: [story('done')], epicPrs: [pr({ state: 'merged', deploy_state: 'failed' })] })).toMatchObject({ phase: 'failed', failure: 'deploy' });
    const release = pr({ state: 'merged', deploy_state: 'passed', release_runs: [{ workflow: 'publish', state: 'failed', url: null, version: null }] });
    expect(phase({ cards: [story('done')], epicPrs: [release] })).toMatchObject({ phase: 'failed', failure: 'release' });
  });

  it('a closed PR does not count; an epic in Feito is done', () => {
    expect(phase({ cards: [story('doing')], epicPrs: [pr({ state: 'closed' })] }).phase).toBe('in_progress');
    expect(phase({ status: 'done', cards: [story('done')], epicPrs: [pr({ state: 'merged' })] }).phase).toBe('done');
  });

  it('multi-repo: one PR still open keeps it integrating; every repo merged is delivering', () => {
    const a = pr({ number: 1, state: 'merged', deploy_state: 'passed' });
    expect(phase({ cards: [story('done')], epicPrs: [a, pr({ number: 2 })] }).phase).toBe('integrating');
    expect(phase({ cards: [story('done')], epicPrs: [a, pr({ number: 2, state: 'merged', deploy_state: 'running' })] }).phase).toBe('delivering');
  });
});

describe('epicPullsOf', () => {
  it('only PRs from the epic branch, never one that only cites the epic', () => {
    const own = pr();
    expect(epicPullsOf([own, pr({ head_ref: 'TER-2-x' }), pr({ mention_only: true })], BRANCH)).toEqual([own]);
  });
});

describe('deliveryOf', () => {
  it('without a deploy workflow nor a release path the merge is delivered at once', () => {
    expect(deliveryOf(setup({ deploy_workflow: null }), pr({ state: 'merged' }))).toEqual({ state: 'ok', failure: null });
    expect(deliveryOf(setup(), pr({ state: 'merged' })).state).toBe('pending');
    expect(deliveryOf(setup(), pr({ state: 'merged', deploy_state: 'passed' })).state).toBe('ok');
  });
});

describe('epicMayDie (TER-1150)', () => {
  const merged = pr({ state: 'merged', deploy_state: 'passed' });
  it('every story done, no open card PR, the epic PR merged and delivered', () => {
    expect(epicMayDie({ cards: [story('done')], cardPrs: [pr({ state: 'merged' })], epicPrs: [merged], setup: setup() })).toBe(true);
  });
  it('never with a story out of Feito, an open PR, no epic PR or a delivery pending or failed', () => {
    expect(epicMayDie({ cards: [story('done'), story('doing')], cardPrs: [], epicPrs: [merged], setup: setup() })).toBe(false);
    expect(epicMayDie({ cards: [story('done')], cardPrs: [pr({ head_ref: 'x' })], epicPrs: [merged], setup: setup() })).toBe(false);
    expect(epicMayDie({ cards: [story('done')], cardPrs: [], epicPrs: [], setup: setup() })).toBe(false);
    expect(epicMayDie({ cards: [story('done')], cardPrs: [], epicPrs: [pr({ state: 'merged', deploy_state: 'running' })], setup: setup() })).toBe(false);
    expect(epicMayDie({ cards: [story('done')], cardPrs: [], epicPrs: [pr({ state: 'merged', deploy_state: 'failed' })], setup: setup() })).toBe(false);
    expect(epicMayDie({ cards: [], cardPrs: [], epicPrs: [merged], setup: setup() })).toBe(false);
  });
});
