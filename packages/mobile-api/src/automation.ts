import { z } from 'zod';

/**
 * Agentic board automation on the phone (spec 2026-10-04): the project's "Trabalho automático" block of
 * the Setup and the queue of tagged cards. The server's `automationSchema` (setup/schema.ts) is the
 * judge of what is saved; here the block is kept loose (`passthrough`) so a field a newer server adds
 * round-trips through an older app untouched.
 */
export const AUTOMATION_AUTONOMY = ['pr', 'merge', 'deploy', 'release'] as const;
export type AutomationAutonomy = (typeof AUTOMATION_AUTONOMY)[number];

export const automationSetup = z
  .object({
    enabled: z.boolean(),
    types: z.array(z.enum(['story', 'task', 'bug', 'spike'])).min(1),
    autonomy: z.enum(AUTOMATION_AUTONOMY),
  })
  .passthrough();
export type AutomationSetup = z.infer<typeof automationSetup>;

export const automationSetupResponse = z.object({ automation: automationSetup });
export type AutomationSetupResponse = z.infer<typeof automationSetupResponse>;

/**
 * `PUT projects/:id/setup/automation`. Turning automation on, or raising the level to `deploy` or
 * `release`, needs a fresh PIN proof over a decision challenge for `automationSetupActionId(project)`,
 * signed with the word `automation_setup`; without one the server answers `401 PIN_REQUIRED`. Lowering
 * the level or turning it off never asks.
 */
export const automationSetupBody = z.object({
  automation: automationSetup,
  challenge: z.string().min(1).max(128).optional(),
  pin_proof: z.string().min(1).max(128).optional(),
  /** The phone's IANA zone (TER-974): the daily summary (`summary_hour`) runs on the person's own clock, so
   *  the app sends it with an hour set, as the web does. Optional: an older app does not send it, an older
   *  server ignores it. A zone the server does not know is ignored, never a failed save. */
  time_zone: z.string().min(1).max(64).optional(),
});
export type AutomationSetupBody = z.infer<typeof automationSetupBody>;

/** The action id the decision challenge is bound to: one per project. Within the 64 characters a challenge accepts. */
export const automationSetupActionId = (projectId: string) => `automation-setup:${projectId}`;

const LEVEL_ORDER: readonly AutomationAutonomy[] = AUTOMATION_AUTONOMY;

/** Turning it on, or raising the level to Deploy or Publicação, asks (a confirmation, then the PIN).
 * The server enforces it, the app uses the same rule to know whether to confirm. */
export function automationNeedsConfirm(from: { enabled: boolean; autonomy: AutomationAutonomy }, to: { enabled: boolean; autonomy: AutomationAutonomy }): boolean {
  if (!to.enabled) return false;
  if (!from.enabled) return true;
  const raised = LEVEL_ORDER.indexOf(to.autonomy) > LEVEL_ORDER.indexOf(from.autonomy);
  return raised && (to.autonomy === 'deploy' || to.autonomy === 'release');
}

/** `PUT tasks/:id/auto`: tag a card (or an epic, which carries its cards) for automatic work, or untag it. */
export const cardAutoBody = z.object({ auto: z.boolean() });
export type CardAutoBody = z.infer<typeof cardAutoBody>;
export const cardAutoResponse = z.object({ id: z.string(), auto: z.boolean() });
export type CardAutoResponse = z.infer<typeof cardAutoResponse>;

/** One tagged card of the queue (`GET /api/projects/:id/automation/queue`, in priority order). */
export const automationQueueItem = z.object({
  task_id: z.string(),
  ref: z.string(),
  title: z.string(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  reason_text: z.string().nullable(),
});
export type AutomationQueueItem = z.infer<typeof automationQueueItem>;

/** The pause switch (`GET automation/state`): the person's "Pausar tudo" and the projects paused on their own.
 * `paused_at` is null when nothing is paused globally. */
export const pauseState = z.object({
  paused_at: z.string().nullable(),
  projects: z.array(z.object({ id: z.string(), paused_at: z.string() })),
  /** The person has a project with automatic work on: otherwise the app hides the switch. */
  has_automation: z.boolean(),
  /** The person may pause and resume (`projects:update`). */
  can_update: z.boolean(),
});
export type PauseState = z.infer<typeof pauseState>;

/** `POST automation/pause`: `scope` is `all` ("Pausar tudo") or a project id. `interrupt` asks to also stop the tabs running now. */
export const pauseBody = z.object({ scope: z.string().min(1).max(64), interrupt: z.boolean().optional() });
export type PauseBody = z.infer<typeof pauseBody>;
export const pauseResponse = z.object({ paused_at: z.string() });
export type PauseResponse = z.infer<typeof pauseResponse>;
/** `POST automation/resume` answers 204. */
export const resumeBody = z.object({ scope: z.string().min(1).max(64) });
export type ResumeBody = z.infer<typeof resumeBody>;

/** What the automatic work did (`automation_events`): ids, URLs, counts and reasons only. `kind` stays a
 * string so a kind a newer server adds still parses on an older app. */
export const automationEventSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  task_id: z.string().nullable(),
  run_id: z.string().nullable(),
  kind: z.string(),
  payload: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  created_at: z.string(),
});
export type AutomationEventView = z.infer<typeof automationEventSchema>;
