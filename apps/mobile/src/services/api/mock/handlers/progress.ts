// The Progresso tab's route: one epic with a card whose agent waits for the user, so the screen
// and the store have every state to show against the mock transport (spec 2026-09-26
// progress-panel D10).
import type { TProgressResponse } from '../../contract';
import type { MockRouter } from '../router';
import { type MockState, verifyAuth } from '../state';

export function mockProgress(now: number): TProgressResponse {
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
  return {
    generated_at: new Date(now).toISOString(),
    epics: [
      {
        id: 'e-182', ref: 'TER-182', title: 'Visão gerencial', project: { id: 'p-termhub', key: 'TER', name: 'termhub' },
        units: { done: 3, total: 6, backlog_total: 1 }, percent: 50,
        estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 3 },
        cards_without_estimate: 0, agents: { working: 0, needs_you: 1, idle: 0 },
        cards: [
          {
            id: 'c-183', ref: 'TER-183', title: 'Painel de progresso', type: 'story', status: 'doing', column_name: 'Fazendo',
            units: { done: 3, total: 5 }, percent: 60, started_at: minutesAgo(90), done_at: null, active_seconds: 1800,
            estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 3 },
            agents: [{ tab_id: 't-api', tab_name: 'api', machine_name: 'jarvis', subtask_ref: null, state: 'waiting_input', state_at: minutesAgo(12), background: false, needs_you: true, activity: null, activity_verb: null, rate_limited: false }],
            pull_requests: [
              {
                number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Painel', state: 'open', draft: false,
                ci_state: 'failed', ci_summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['lint'] },
                deploy_state: 'none', deploy_url: null,
              },
            ],
          },
        ],
        ci: { open: 1, failed: 1, running: 0, deployed: 0 },
        ci_error: null,
      },
    ],
  };
}

export function registerProgressRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/progress', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: mockProgress(ctx.now()) };
  });
}
