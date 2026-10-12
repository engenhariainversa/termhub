import { z } from 'zod';

/** Progress panel read model (spec 2026-09-26 progress-panel §4.4), shared by /api/progress and /api/m/v1/progress. */
export const progressScope = z.enum(['active', 'all']);
export const progressTabState = z.enum(['working', 'waiting_input', 'waiting_permission', 'idle', 'error']);
const taskStatus = z.enum(['backlog', 'todo', 'doing', 'done']);
const count = z.number().int().nonnegative();
const percent = z.number().int().min(0).max(100);

export const progressEstimate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  z.object({ kind: z.literal('none'), reason: z.enum(['not_started', 'few_samples']) }),
  z.object({ kind: z.literal('range'), low_s: count, high_s: count, basis: z.enum(['agent_time', 'wall_clock']), samples: z.number().int().positive() }),
]);

const ciState = z.enum(['none', 'running', 'passed', 'failed']);

/** A GitHub PR linked to a card, with its CI and deploy status (spec 2026-09-26 progress-panel §5.2). */
export const pullRequestBadge = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  ci_state: ciState,
  ci_summary: z.object({ total: count, passed: count, failed: count, running: count, failing: z.array(z.string()) }),
  deploy_state: ciState,
  deploy_url: z.string().nullable(),
  /** the project's release workflows on the merge commit (agentic board D22); absent from a server that predates it */
  release_runs: z.array(z.object({ workflow: z.string(), state: ciState, url: z.string().nullable(), version: z.string().nullable() })).optional(),
});

export const agentOnCard = z.object({
  tab_id: z.string(),
  tab_name: z.string(),
  machine_name: z.string(),
  /** the subtask this tab was started on; null = the card itself */
  subtask_ref: z.string().nullable(),
  /**
   * An agent that ended its turn while its own background work runs (the tab's `waiting_background`,
   * TER-644) is sent as `working` with `background: true`: an app that predates the flag keeps parsing the
   * state and shows it at work, never as waiting for the person. One that ended its turn with a report
   * and asks nothing (the tab's `finished`, TER-972) is sent as `idle` with `finished: true`, so an older
   * app shows it stopped, never as waiting for the person.
   */
  state: progressTabState.nullable(),
  state_at: z.string().nullable(),
  /** the agent waits on its own subagents, background shells or monitors (TER-644); only with `state: 'working'` */
  background: z.boolean().default(false),
  /** the agent finished its work with a report and asks nothing (TER-972); only with `state: 'idle'` */
  finished: z.boolean().default(false),
  needs_you: z.boolean(),
  activity: z.string().nullable(),
  activity_verb: z.string().nullable(),
  rate_limited: z.boolean(),
  /** the tab was started by an automatic run (agentic board): shown with the "automático" badge */
  automatic: z.boolean().default(false),
});

/**
 * Tokens of the automatic tabs and their API-equivalent cost estimate in US$ (agentic board, spec D23).
 * `cost_usd` null = nothing priced (an unknown model, a Codex tab): shown as "—".
 */
export const progressUsage = z.object({ cost_usd: z.number().nullable(), tokens: count });

export const cardProgress = z.object({
  id: z.string(),
  ref: z.string(),
  title: z.string(),
  type: z.string(),
  status: taskStatus,
  column_name: z.string().nullable(),
  units: z.object({ done: count, total: count }),
  percent,
  started_at: z.string().nullable(),
  done_at: z.string().nullable(),
  active_seconds: count,
  estimate: progressEstimate,
  /** null = the caller cannot read terminals */
  agents: z.array(agentOnCard).nullable(),
  pull_requests: z.array(pullRequestBadge).default([]),
  /** tagged for automatic work (spec 2026-10-04); false from a server that predates it */
  auto: z.boolean().default(false),
  /** what the card's automatic tabs cost; null when none was metered (or from a server that predates it) */
  usage: progressUsage.nullable().default(null),
});

export const epicProgress = z.object({
  id: z.string(),
  ref: z.string(),
  title: z.string(),
  project: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  units: z.object({ done: count, total: count, backlog_total: count }),
  percent,
  estimate: progressEstimate,
  cards_without_estimate: count,
  agents: z.object({ working: count, needs_you: count, idle: count }).nullable(),
  cards: z.array(cardProgress),
  /** distinct PR numbers across the epic's cards; null when none has a PR */
  ci: z.object({ open: count, failed: count, running: count, deployed: count }).nullable().default(null),
  ci_error: z.string().nullable().default(null),
  /** the epic's own automatic tabs (its integrator) plus its cards'; null when none was metered */
  usage: progressUsage.nullable().default(null),
});

/**
 * One line of the automatic work's feed (`automation_events`, newest first), resolved for display: the
 * clients write the sentence from `kind` and these facts. `kind` stays a string so a kind a newer server
 * adds still parses on an older app (the client skips what it has no line for).
 */
export const automationFeedEvent = z.object({
  id: z.string(),
  kind: z.string(),
  created_at: z.string(),
  project_id: z.string(),
  task_id: z.string().nullable(),
  run_id: z.string().nullable(),
  tab_id: z.string().nullable(),
  /** the card's reference ("TER-12") */
  ref: z.string().nullable(),
  /** the epic's title, for the deploy lines */
  epic: z.string().nullable(),
  machine: z.string().nullable(),
  account: z.string().nullable(),
  branch: z.string().nullable(),
  /** the release workflow (the package), and the version it published */
  workflow: z.string().nullable(),
  version: z.string().nullable(),
  pr: z.number().nullable(),
  url: z.string().nullable(),
  /** the account's limit ends / the work stays paused until (ISO) */
  until: z.string().nullable(),
  /** why a run needs the person, already in the reader's language */
  reason_text: z.string().nullable(),
  /** a failed deploy: the project's automatic work was paused by it (false when the pause could not be applied) */
  paused: z.boolean().nullable().default(null),
  /** the tool a permission_auto_approved / guard_blocked line names (TER-993) */
  tool: z.string().nullable().default(null),
  /** TER-1011: why an automatic answer or an escalation happened, already in the reader's language */
  why_text: z.string().nullable().default(null),
  /** TER-1011: the precedent (`decision:<id>`, `note:<id>`) or allow rule (`Bash(npm test:*)`) it rests on */
  rule_ref: z.string().nullable().default(null),
  /** TER-1011: the precedent's similarity, 0..1 */
  score: z.number().nullable().default(null),
});

export const progressResponse = z.object({
  epics: z.array(epicProgress),
  /** the last 50 automatic events of the caller's projects; empty for someone with no automatic work */
  feed: z.array(automationFeedEvent).default([]),
  generated_at: z.string(),
});

export type ProgressScope = z.infer<typeof progressScope>;
export type ProgressEstimate = z.infer<typeof progressEstimate>;
export type ProgressUsage = z.infer<typeof progressUsage>;
export type AgentOnCard = z.infer<typeof agentOnCard>;
export type PullRequestBadge = z.infer<typeof pullRequestBadge>;
export type AutomationFeedEvent = z.infer<typeof automationFeedEvent>;
export type CardProgress = z.infer<typeof cardProgress>;
export type EpicProgress = z.infer<typeof epicProgress>;
export type ProgressResponse = z.infer<typeof progressResponse>;
