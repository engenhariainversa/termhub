// "Trabalho automático" (spec 2026-10-04): the project's automation block and the tag on a card. Mirrors
// the server's rule: turning it on, or raising the level to deploy/release, needs a PIN proof over a
// decision challenge for `automationSetupActionId(project)`, signed `automation_setup`.
import { automationNeedsConfirm, automationSetupActionId, automationSetupBody, cardAutoBody, pauseBody, resumeBody, type TAutomationSetup } from '../../contract';
import type { MockRouter } from '../router';
import { verifyAuth, WireError, type MockState } from '../state';
import { checkDecisionProof } from './chat';

const DEFAULT_AUTOMATION: TAutomationSetup = {
  enabled: false,
  types: ['story', 'task', 'bug'],
  autonomy: 'pr',
  release_paths: [],
  store_paths: [],
  release_workflows: [],
  epic_branch_pattern: 'epic/{ref}-{slug}',
  worktrees_dir: '~/.termhub/worktrees',
  allowed_tools: null,
  max_parallel: null,
  resume_max: 3,
  fix_attempts: 3,
  daily_budget_usd: null,
  card_budget_usd: null,
  summary_hour: null,
  prompts: { implementer: null, integrator: null, fixer: null },
};

export function registerAutomationRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/projects/:id/setup/automation', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const id = ctx.params.id!;
    if (!state.projects.has(id)) throw new WireError(404, 'NOT_FOUND', 'Projeto não encontrado');
    return { status: 200, body: { automation: state.automation.get(id) ?? DEFAULT_AUTOMATION } };
  });

  router.route('PUT', '/api/m/v1/projects/:id/setup/automation', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'PUT', htu: ctx.htu, now: ctx.now() });
    const id = ctx.params.id!;
    if (!state.projects.has(id)) throw new WireError(404, 'NOT_FOUND', 'Projeto não encontrado');
    const body = automationSetupBody.parse(ctx.body);
    const current = state.automation.get(id) ?? DEFAULT_AUTOMATION;
    if (automationNeedsConfirm(current, body.automation)) {
      if (body.challenge === undefined || body.pin_proof === undefined) throw new WireError(401, 'PIN_REQUIRED', 'Confirme com o PIN para ligar ou ampliar o trabalho automático.');
      checkDecisionProof(state, device, automationSetupActionId(id), 'automation_setup', { challenge: body.challenge, pin_proof: body.pin_proof }, ctx.now());
      device.pinFailures = 0;
    }
    state.automation.set(id, body.automation);
    return { status: 200, body: { automation: body.automation } };
  });

  router.route('PUT', '/api/m/v1/tasks/:id/auto', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'PUT', htu: ctx.htu, now: ctx.now() });
    const id = ctx.params.id!;
    const { auto } = cardAutoBody.parse(ctx.body);
    state.cardAuto.set(id, auto);
    return { status: 200, body: { id, auto } };
  });

  router.route('GET', '/api/m/v1/automation/state', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: { ...state.pause, has_automation: state.hasAutomation || [...state.automation.values()].some((a) => a.enabled), can_update: true } };
  });

  router.route('POST', '/api/m/v1/automation/pause', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const { scope } = pauseBody.parse(ctx.body);
    const at = new Date(ctx.now()).toISOString();
    if (scope === 'all') state.pause.paused_at ??= at;
    else if (!state.pause.projects.some((p) => p.id === scope)) state.pause.projects.push({ id: scope, paused_at: at });
    return { status: 200, body: { paused_at: scope === 'all' ? state.pause.paused_at : (state.pause.projects.find((p) => p.id === scope)?.paused_at ?? at) } };
  });

  router.route('POST', '/api/m/v1/automation/resume', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const { scope } = resumeBody.parse(ctx.body);
    if (scope === 'all') state.pause.paused_at = null;
    else state.pause.projects = state.pause.projects.filter((p) => p.id !== scope);
    return { status: 204, body: {} };
  });
}
