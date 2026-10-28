import { CLAUDE_MODEL_ALIASES, type ClaudeModelAlias } from '@termhub/mobile-api';

/**
 * "Modelos do concierge" (TER-1145): the person may keep the concierge off some Claude model families —
 * the ready-made option is "Nunca usar Fable", whose weekly allowance is a window of its own. Only the
 * chat obeys it: the tabs' agents keep the project's model.
 */

/** The families offered, in the order the screens show them. */
export const CONCIERGE_MODEL_FAMILIES = CLAUDE_MODEL_ALIASES;

/** Where the concierge goes when its model is ruled out: the first family the person still allows. */
const FALLBACK_ORDER: readonly ClaudeModelAlias[] = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * The family a model id or alias belongs to: `fable`, `fable[1m]` and `claude-fable-5-1` are all
 * `fable`. Null for anything else (`opusplan`, a Codex model, an id no family names).
 */
export function modelFamily(model: string): ClaudeModelAlias | null {
  const m = model.trim().toLowerCase();
  return CLAUDE_MODEL_ALIASES.find((f) => new RegExp(`(^|-)${f}(\\[|-|$)`).test(m)) ?? null;
}

export interface ConciergeModel {
  /** What the run passes as `--model`; null = no flag, the CLI's own default. */
  model: string | null;
  /** The setting replaced the model the run would otherwise have used (a blocked one, or the CLI's
   *  default, which may be a blocked family since termhub cannot know it before the run). */
  steered: boolean;
}

/**
 * The model the concierge runs on, from the one it would use (the conversation's, else the project's
 * default; null = the CLI's default) and the families the person blocked. Nothing blocked keeps today's
 * behaviour. A blocked model, or no model at all, becomes the first allowed family: the CLI's default
 * could be the very model the person ruled out. With every family blocked (the route refuses that) the
 * model is kept, so the chat still answers.
 */
export function conciergeModel(configured: string | null, blocked: readonly string[]): ConciergeModel {
  if (blocked.length === 0) return { model: configured, steered: false };
  if (configured !== null) {
    const family = modelFamily(configured);
    if (family === null || !blocked.includes(family)) return { model: configured, steered: false };
  }
  const next = FALLBACK_ORDER.find((f) => !blocked.includes(f));
  return next === undefined ? { model: configured, steered: false } : { model: next, steered: true };
}
