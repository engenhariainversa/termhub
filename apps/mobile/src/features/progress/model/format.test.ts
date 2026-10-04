import type { TPullRequestBadge } from '@/services/api/contract';
import { ciLabel, epicCiLine, formatDuration, formatEstimate, stateLabel } from './format';

it('formats durations', () => {
  expect(formatDuration(1200)).toBe('20 min');
  expect(formatDuration(3600)).toBe('1 h');
  expect(formatDuration(9000)).toBe('2,5 h');
});
it('formats estimates', () => {
  expect(formatEstimate({ kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 2 })).toBe('~20–45 min de trabalho');
  expect(formatEstimate({ kind: 'range', low_s: 2700, high_s: 5400, basis: 'wall_clock', samples: 2 })).toBe('~45 min–1,5 h de trabalho');
  expect(formatEstimate({ kind: 'range', low_s: 300, high_s: 300, basis: 'wall_clock', samples: 2 })).toBe('~5 min de trabalho');
  expect(formatEstimate({ kind: 'none', reason: 'not_started' })).toBe('ainda não começou');
  expect(formatEstimate({ kind: 'none', reason: 'few_samples' })).toBe('estimativa após 2 subtarefas');
  expect(formatEstimate({ kind: 'done' })).toBe('concluído');
});
it('names states', () => {
  expect(stateLabel('waiting_input')).toBe('esperando você');
  expect(stateLabel(null)).toBe('sem sinal');
});

it('names an agent waiting on its own background work, never as waiting for you (TER-644)', () => {
  expect(stateLabel('working', true)).toBe('aguardando segundo plano');
  expect(stateLabel('working', false)).toBe('trabalhando');
  expect(stateLabel('working')).toBe('trabalhando');
});

const p = (over: Partial<TPullRequestBadge>): TPullRequestBadge => ({
  number: 7, url: 'u', title: 't', state: 'open', draft: false, ci_state: 'passed',
  ci_summary: { total: 2, passed: 2, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null, ...over,
});
it('describes an open PR by its CI', () => {
  expect(ciLabel(p({}))).toBe('CI verde');
  expect(ciLabel(p({ ci_state: 'running' }))).toBe('CI rodando');
  expect(ciLabel(p({ ci_state: 'failed', ci_summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['lint'] } }))).toBe('CI falhou: lint');
  expect(ciLabel(p({ ci_state: 'none' }))).toBe('sem CI');
});
it('describes a merged PR by its deploy, and a closed one as fechado', () => {
  expect(ciLabel(p({ state: 'merged', deploy_state: 'running' }))).toBe('deploy rodando');
  expect(ciLabel(p({ state: 'merged', deploy_state: 'passed' }))).toBe('deploy ok');
  expect(ciLabel(p({ state: 'merged', deploy_state: 'failed' }))).toBe('deploy falhou');
  expect(ciLabel(p({ state: 'merged', deploy_state: 'none' }))).toBe('mergeado');
  expect(ciLabel(p({ state: 'closed' }))).toBe('fechado');
});
it('summarises the epic PRs', () => {
  expect(epicCiLine({ open: 2, failed: 1, running: 1, deployed: 3 })).toBe('PRs: 2 abertos · 1 falhou · 1 rodando · 3 em produção');
  expect(epicCiLine({ open: 1, failed: 0, running: 0, deployed: 0 })).toBe('PRs: 1 aberto');
});
