import { AUTONOMY_LEVELS, type AutonomyLevel, type ProjectAutomation } from '../setup/schema.js';

/**
 * Which change to the automatic-work Setup is a brake and which widens it (TER-975). Pure, so the gate can
 * classify a call without loading the repositories.
 */

/** The Setup fields `set_automation_policy` changes; the rest of the block stays as the screen saved it. */
export const AUTOMATION_PATCH_FIELDS = ['enabled', 'autonomy', 'release_paths', 'store_paths', 'release_workflows', 'required_checks', 'max_parallel'] as const;
export type AutomationPatchField = (typeof AUTOMATION_PATCH_FIELDS)[number];
export type AutomationPatch = Partial<Pick<ProjectAutomation, AutomationPatchField>>;

/** The patch fields present in a call's arguments (undefined = left out = unchanged). */
export function automationPatchOf(args: Record<string, unknown>): AutomationPatch {
  const out: Record<string, unknown> = {};
  for (const f of AUTOMATION_PATCH_FIELDS) if (args[f] !== undefined) out[f] = args[f];
  return out as AutomationPatch;
}

export const hasAutomationPatch = (args: Record<string, unknown>): boolean => AUTOMATION_PATCH_FIELDS.some((f) => args[f] !== undefined);

const level = (a: AutonomyLevel) => AUTONOMY_LEVELS.indexOf(a);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
/** null is "no cap": the widest value. */
const parallelRank = (n: number | null) => (n === null ? Number.POSITIVE_INFINITY : n);

/** Which patch fields actually differ between two Setups. */
export function changedFields(from: ProjectAutomation, to: ProjectAutomation): AutomationPatchField[] {
  return AUTOMATION_PATCH_FIELDS.filter((f) => {
    const a = from[f];
    const b = to[f];
    return Array.isArray(a) && Array.isArray(b) ? !sameSet(a, b) : a !== b;
  });
}

/**
 * Whether going from `from` to `to` needs the person's confirmation on the concierge's token. Asks for:
 * turning it on, raising the level (any raise, also while off), changing release/store paths, release
 * workflows or required checks, and raising `max_parallel` (or lifting the cap). Never asks for a brake:
 * turning off, lowering the level, lowering `max_parallel`, or nothing changing.
 */
export function automationChangeWidens(from: ProjectAutomation, to: ProjectAutomation): boolean {
  return changedFields(from, to).some((f) => {
    switch (f) {
      case 'enabled':
        return to.enabled;
      case 'autonomy':
        return level(to.autonomy) > level(from.autonomy);
      case 'max_parallel':
        return parallelRank(to.max_parallel) > parallelRank(from.max_parallel);
      default:
        return true;
    }
  });
}
