import { ControlError, type ControlContext } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Task } from '../db/repositories/types.js';
import { msg } from '../i18n/index.js';
import { automationInputSchema, type ProjectAutomation } from '../setup/schema.js';
import { AUTOMATION_PATCH_FIELDS, automationChangeWidens, automationPatchOf, changedFields, type AutomationPatch, type AutomationPatchField } from './setup-patch.js';
import { dispatchTriggers, recordEvent } from './events.js';
import { policyText } from './policy.js';

/**
 * The automation Setup and the machine switch through MCP (TER-975): what the concierge can change, and
 * which change is a brake. A brake (turning off, lowering the level, lowering `max_parallel`) runs at once on
 * the concierge's token; anything else that widens what automatic work may do asks the person first.
 */

/** Where a change came from, for the event log: the chat's concierge, another MCP client, the web or the app. */
export type ChangeVia = 'chat' | 'mcp' | 'web' | 'app';
export const viaOf = (ctx: ControlContext): ChangeVia => (ctx.token?.gated ? 'chat' : ctx.token ? 'mcp' : 'web');

/**
 * For the gate (chat/gate-runtime.ts): whether this `set_automation_policy` call is a brake or changes
 * nothing, read against the project's current Setup. A project the person cannot see counts as a brake
 * here only so the tool itself answers "not found"; the tool checks the change again before saving.
 */
export async function automationCallIsBrake(ctx: ControlContext, args: Record<string, unknown>): Promise<boolean> {
  const projectId = args.project_id;
  if (typeof projectId !== 'string') return true;
  try {
    await ctx.scoped.project(projectId);
  } catch {
    return true;
  }
  const current = (await ctx.repos.projectSetup.get(projectId)).data.automation;
  return !automationChangeWidens(current, { ...current, ...automationPatchOf(args) });
}

const CONFIRM_REQUIRED = () =>
  new ControlError(
    'CONFIRMATION_REQUIRED',
    msg('Ligar o trabalho automático ou ampliar o que ele pode fazer precisa da confirmação da pessoa no chat. Nada foi alterado: proponha a chamada de novo.'),
  );

/**
 * Writes the events of a Setup change: `automation_on` / `automation_off` when `enabled` flips, otherwise
 * `setup_changed`. Nothing when no patch field changed. Ids, levels and field names only.
 */
export async function recordSetupChange(repos: Repositories, projectId: string, from: ProjectAutomation, to: ProjectAutomation, via: ChangeVia): Promise<AutomationPatchField[]> {
  const fields = changedFields(from, to);
  if (fields.length === 0) return fields;
  const kind = from.enabled === to.enabled ? 'setup_changed' : to.enabled ? 'automation_on' : 'automation_off';
  await recordEvent(repos, {
    project_id: projectId,
    kind,
    payload: { via, autonomy: to.autonomy, from_autonomy: from.autonomy, max_parallel: to.max_parallel, fields: fields.join(',') },
  });
  return fields;
}

/** The event of a tag change on a card (or an epic and its cards): only when something changed. */
export async function recordTagChange(repos: Repositories, task: Pick<Task, 'id' | 'project_id'>, auto: boolean, changed: number, via: ChangeVia): Promise<void> {
  if (changed === 0) return;
  await recordEvent(repos, { project_id: task.project_id, task_id: task.id, kind: auto ? 'tagged' : 'untagged', payload: { via, cards: changed } });
}

/** The machine switch's event, written on every project linked to the machine (events live per project). */
export async function recordMachineSwitch(repos: Repositories, machineId: string, allowed: boolean, via: ChangeVia): Promise<void> {
  const links = await repos.projectMachines.listByMachine(machineId);
  for (const projectId of new Set(links.map((l) => l.project_id))) {
    await recordEvent(repos, { project_id: projectId, kind: allowed ? 'machine_opt_in' : 'machine_opt_out', payload: { via, machine_id: machineId } });
  }
}

export interface AutomationPolicyOut {
  project_id: string;
  automation: Pick<ProjectAutomation, AutomationPatchField>;
  text: string;
  changed: AutomationPatchField[];
}

/**
 * `set_automation_policy`: reads the project's automatic-work Setup, or changes the fields given. On the
 * concierge's token a change that widens it runs only from a card the person approved (`ctx.approval`);
 * the gate asks for it, and this check stands even if the gate let a call through by mistake.
 */
export async function setAutomationPolicy(ctx: ControlContext, input: { project_id: string } & AutomationPatch): Promise<AutomationPolicyOut> {
  const { project } = await ctx.scoped.project(input.project_id);
  const setup = await ctx.repos.projectSetup.get(project.id);
  const current = setup.data.automation;
  const patch = automationPatchOf(input as unknown as Record<string, unknown>);
  const parsed = automationInputSchema.safeParse({ ...current, ...patch });
  if (!parsed.success) throw new ControlError('INVALID_SETUP', msg('Valor inválido no Setup do trabalho automático: {{issue}}', { issue: parsed.error.issues[0]?.message ?? '' }));
  const next = parsed.data;
  let changed: AutomationPatchField[] = [];
  let saved = current;
  if (changedFields(current, next).length > 0) {
    if (ctx.token?.gated && !ctx.approval && automationChangeWidens(current, next)) throw CONFIRM_REQUIRED();
    saved = (await ctx.repos.projectSetup.save(project.id, { ...setup.data, automation: next })).data.automation;
    changed = await recordSetupChange(ctx.repos, project.id, current, saved, viaOf(ctx));
    if (saved.enabled) dispatchTriggers.poke('setup_saved');
  }
  const automation = Object.fromEntries(AUTOMATION_PATCH_FIELDS.map((f) => [f, saved[f]])) as AutomationPolicyOut['automation'];
  return { project_id: project.id, automation, text: policyText(saved, setup.data.repo?.deploy_workflow ?? null), changed };
}

/**
 * `set_machine_automation`: the machine's "Aceita trabalho automático". Accepting asks the person on the
 * concierge's token (an approved card), refusing never does.
 */
export async function setMachineAutomation(ctx: ControlContext, input: { machine_id: string; accept: boolean }): Promise<{ machine_id: string; name: string; automation_allowed: boolean; changed: boolean }> {
  const machine = await ctx.scoped.machine(input.machine_id);
  const before = machine.automation_allowed !== false;
  if (before === input.accept) return { machine_id: machine.id, name: machine.name, automation_allowed: before, changed: false };
  if (input.accept && ctx.token?.gated && !ctx.approval) throw CONFIRM_REQUIRED();
  await ctx.repos.machines.setAutomationAllowed(machine.id, input.accept);
  await recordMachineSwitch(ctx.repos, machine.id, input.accept, viaOf(ctx));
  if (input.accept) dispatchTriggers.poke('machine_opt_in');
  return { machine_id: machine.id, name: machine.name, automation_allowed: input.accept, changed: true };
}
