import { tk } from '../i18n/index.js';
import { isEnabled } from '../features/flags.js';
import { runTabGc, type GcItem, type GcMode } from '../monitor/tab-gc/sweep.js';
import { ControlError, type ControlContext } from './context.js';

/*
 * TER-1171: the tab GC on demand, for the chat and MCP clients — what it would close and why
 * (`list_gc_candidates`), and one pass now (`run_gc`, dry run by default). Behind the `tab_gc` flag; a real
 * pass also needs `tab_gc_live`. Ids, names, states and reasons only.
 */

export const GC_OFF = tk('O coletor de abas está desligado para você (recurso em teste tab_gc)');
export const GC_NOT_LIVE = tk('O coletor de abas está em teste: só roda com dry_run (recurso tab_gc_live desligado)');

/** On demand the answer is the report; every real step is recorded as an automation event anyway. */
const SILENT = { info: () => {}, warn: () => {} };

async function scopeOf(ctx: ControlContext, input: { project_id?: string; machine_id?: string }) {
  const userId = ctx.scope.user.id;
  if (!(await isEnabled('tab_gc', { repos: ctx.repos, userId }))) throw new ControlError('TAB_GC_OFF', GC_OFF);
  if (input.project_id) await ctx.scoped.project(input.project_id);
  if (input.machine_id) await ctx.scoped.machine(input.machine_id);
  return { ownerId: ctx.scope.ownerId ?? userId, projectId: input.project_id, machineId: input.machine_id };
}

const view = (i: GcItem) => ({
  tab_id: i.tab_id,
  tab: i.tab,
  project_id: i.project_id,
  machine: i.machine,
  state: i.state,
  tool: i.tool,
  task_id: i.task_id,
  action: i.step,
  reason: i.reason,
  rest_hours: i.rest_hours,
  closes_at: i.closes_at,
});

/** Every agent tab in scope with what the GC would do now; `keep` rows only with `all`. Writes nothing. */
export async function listGcCandidates(ctx: ControlContext, input: { project_id?: string; machine_id?: string; all?: boolean }) {
  const scope = await scopeOf(ctx, input);
  const r = await runTabGc(ctx.repos, SILENT, { mode: 'plan', scope });
  const live = await isEnabled('tab_gc_live', { repos: ctx.repos, userId: ctx.scope.user.id });
  const items = r.items.filter((i) => input.all || i.step !== 'keep').map(view);
  return { live, candidates: items, kept: r.items.filter((i) => i.step === 'keep').length };
}

/**
 * One pass now over the scope. `dry_run` (default true) answers what the pass would do and writes nothing (no
 * mark, no event, no clock reset), so asking never changes what the scheduled pass does.
 */
export async function runGc(ctx: ControlContext, input: { project_id?: string; machine_id?: string; dry_run?: boolean }) {
  const scope = await scopeOf(ctx, input);
  const dry = input.dry_run !== false;
  if (!dry && !(await isEnabled('tab_gc_live', { repos: ctx.repos, userId: ctx.scope.user.id }))) throw new ControlError('TAB_GC_NOT_LIVE', GC_NOT_LIVE);
  const mode: GcMode = dry ? 'plan' : 'live';
  const r = await runTabGc(ctx.repos, SILENT, { mode, scope });
  return {
    dry_run: dry,
    warned: r.warned,
    collected: r.collected,
    removed: r.removed,
    acted: r.items.filter((i) => i.step !== 'keep').map(view),
  };
}
