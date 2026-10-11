import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { ciLabel, epicCiLine, formatDuration, formatEstimate, stateLabel } from './progress';
import type { PullRequestBadge } from './types';

beforeEach(() => {
  void i18n.changeLanguage('en');
});
afterEach(() => {
  void i18n.changeLanguage('pt-BR');
});

describe('progress copy in English', () => {
  it('writes durations and estimates in English', () => {
    expect(formatDuration(9000)).toBe('2.5 h');
    expect(formatEstimate({ kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 2 })).toBe('~20–45 min of work');
    expect(formatEstimate({ kind: 'none', reason: 'few_samples' })).toBe('estimate after 2 subtasks');
    expect(stateLabel('working', true)).toBe('waiting on background work');
    expect(stateLabel(null)).toBe('no signal');
  });

  it('describes PRs and the epic CI line in English', () => {
    const pr = { number: 7, url: 'u', title: 't', state: 'open', draft: false, ci_state: 'failed', ci_summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['lint'] }, deploy_state: 'none', deploy_url: null } as PullRequestBadge;
    expect(ciLabel(pr)).toBe('CI failed: lint');
    expect(ciLabel({ ...pr, state: 'merged', deploy_state: 'passed' })).toBe('deploy ok');
    expect(epicCiLine({ open: 1, failed: 0, running: 2, deployed: 0 })).toBe('PRs: 1 open · 2 running');
  });
});
