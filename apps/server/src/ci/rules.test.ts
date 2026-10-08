import { describe, expect, it } from 'vitest';
import { ciOf, deployOf, refsIn, type WorkflowRun } from './rules.js';

const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: 1, name: 'CI e Deploy', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success',
  html_url: 'https://github.com/acme/app/actions/runs/1', created_at: '2026-09-27T12:00:00Z', ...over,
});

describe('refsIn', () => {
  it('finds refs of the project key in branch, title and body, once each', () => {
    expect(refsIn(['TER-183-progress-panel', 'Painel (TER-183, ter-184)', 'Closes TER-183'], 'TER')).toEqual([183, 184]);
  });
  it('does not match a longer number, another key or a ref glued to letters', () => {
    expect(refsIn(['TER-1830 XTER-18 TERM-18', null], 'TER')).toEqual([1830]);
    expect(refsIn(['TER-18'], 'TER')).not.toContain(183);
  });
});

describe('ciOf', () => {
  it('is none without runs', () => {
    expect(ciOf([]).state).toBe('none');
  });
  it('is running while any run is not completed', () => {
    expect(ciOf([run({ id: 1 }), run({ id: 2, path: 'b.yml', name: 'lint', status: 'in_progress', conclusion: null })]).state).toBe('running');
  });
  it('is failed with the failing workflow names', () => {
    const r = ciOf([run({ id: 1 }), run({ id: 2, path: 'b.yml', name: 'lint', conclusion: 'failure' })]);
    expect(r).toEqual({ state: 'failed', summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['lint'] } });
  });
  it('lets the latest run of a workflow win (a green re-run after a failure)', () => {
    const r = ciOf([run({ id: 1, conclusion: 'failure', created_at: '2026-09-27T12:00:00Z' }), run({ id: 2, conclusion: 'success', created_at: '2026-09-27T12:10:00Z' })]);
    expect(r.state).toBe('passed');
    expect(r.summary.total).toBe(1);
  });
  it('treats skipped and neutral as passed, cancelled and timed_out as failed', () => {
    expect(ciOf([run({ conclusion: 'skipped' }), run({ id: 2, path: 'n.yml', conclusion: 'neutral' })]).state).toBe('passed');
    expect(ciOf([run({ conclusion: 'cancelled' })]).state).toBe('failed');
    expect(ciOf([run({ conclusion: 'timed_out' })]).state).toBe('failed');
  });
});

describe('deployOf', () => {
  const runs = [run({ id: 1, name: 'CI e Deploy', path: '.github/workflows/deploy.yml', status: 'in_progress', conclusion: null }), run({ id: 2, name: 'Publish', path: '.github/workflows/publish.yml' })];
  it('is none without a configured workflow or a matching run', () => {
    expect(deployOf(runs, null)).toEqual({ state: 'none', url: null, run: null });
    expect(deployOf(runs, 'release.yml')).toEqual({ state: 'none', url: null, run: null });
  });
  it('matches by file name or display name', () => {
    expect(deployOf(runs, 'deploy.yml')).toEqual({ state: 'running', url: runs[0].html_url, run: runs[0] });
    expect(deployOf(runs, 'Publish').state).toBe('passed');
  });
  it('treats a cancelled deploy as superseded (none), while CI keeps cancelled as failed', () => {
    const cancelled = [run({ id: 3, status: 'completed', conclusion: 'cancelled' })];
    expect(deployOf(cancelled, 'deploy.yml')).toEqual({ state: 'none', url: null, run: null });
    expect(ciOf(cancelled).state).toBe('failed');
  });
});
