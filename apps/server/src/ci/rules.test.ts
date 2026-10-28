import { describe, expect, it } from 'vitest';
import { ciOf, deployOf, linkedRefsIn, refsIn, type WorkflowRun } from './rules.js';

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

describe('linkedRefsIn', () => {
  it('takes refs after a dependency or closing word, lists included', () => {
    expect(linkedRefsIn(['Depende de: TER-12, TER-13 e TER-14'], 'TER')).toEqual([12, 13, 14]);
    expect(linkedRefsIn(['**Depends on:** TER-5\nCloses ter-6', 'Fecha TER-7; bloqueado por TER-8 and TER-9'], 'TER')).toEqual([5, 6, 7, 8, 9]);
  });
  it('leaves a passing mention out', () => {
    expect(linkedRefsIn(['Tela mínima no cms (o visual final vem do TER-3)', 'Segue o padrão do TER-952; ver TER-1011'], 'TER')).toEqual([]);
    expect(linkedRefsIn(['Closes the gap; TER-4 does the rest', 'prefixed TER-5'], 'TER')).toEqual([]);
  });
  it('does not read a link word inside another word', () => {
    expect(linkedRefsIn(['unfixed TER-1', 'enclosed TER-2', 'fecharam TER-3'], 'TER')).toEqual([]);
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
