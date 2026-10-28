import { z } from 'zod';
import { MODEL_RE } from '@termhub/mobile-api';
import { unsafeAllowedTool } from '../control/automation-tools.js';
import { tk } from '../i18n/index.js';

/**
 * Setup do projeto (ProjectSetup.data). Versionado: ao mudar o formato, incremente
 * SETUP_VERSION e trate a migração em normalizeSetup().
 */
export const SETUP_VERSION = 2;

const providerEnum = z.enum(['github', 'linear', 'jira']);

export const repoSchema = z.object({
  integration_id: z.string().min(1).nullable().default(null),
  /** owner/repo */
  full_name: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'use owner/repo').nullable().default(null),
  base_branch: z.string().trim().min(1).max(100).default('main'),
  /** placeholders: {ticket} (the external ticket's key, else the card's ref), {ticket_lower}, {ref}, {slug} */
  branch_pattern: z.string().trim().min(1).max(100).default('{ticket}-{slug}'),
  /** TER-1110: automatic work only on cards with an external ticket (or an explicit branch), and never the termhub ref on GitHub */
  require_ticket: z.boolean().default(false),
  draft_pr: z.boolean().default(true),
  /** GitHub Actions workflow whose run on the merge commit is "the deploy" (file name or display name); null = not tracked */
  deploy_workflow: z.string().trim().min(1).max(200).nullable().default(null),
});

/** One ticket source of a project. Identity: (integration_id, scope). Open tickets only. */
export const ticketSourceSchema = z.object({
  provider: providerEnum,
  integration_id: z.string().min(1),
  /** Linear: team key; Jira: project key; GitHub: owner/repo */
  scope: z.string().trim().min(1).max(200),
  /** Linear: state names; Jira: extra JQL; GitHub: labels */
  filter: z.string().trim().max(500).nullable().default(null),
  /** sync automatically every N minutes (0 = manual) */
  sync_minutes: z.number().int().min(0).max(1440).default(0),
});
export type TicketSource = z.infer<typeof ticketSourceSchema>;

/** The single source of setup v1. Kept as a mirror of ticket_sources[0] for the previous release. */
export const ticketsSchema = ticketSourceSchema.extend({ include_done: z.boolean().default(false) });

export const sourceIdentity = (s: { integration_id: string; scope: string }) => `${s.integration_id}\u0000${s.scope.trim()}`;

export const runnerSchema = z.object({
  /** máquina onde a automação roda (null = a máquina do projeto) */
  machine_id: z.string().min(1).nullable().default(null),
  /** diretório de trabalho no runner (null = cwd do projeto) */
  cwd: z.string().trim().max(1024).nullable().default(null),
  /** comando rodado antes de cada run (ex.: pnpm install) */
  setup_command: z.string().trim().max(2000).nullable().default(null),
  /** usar git worktree por run (isola branches) */
  worktree: z.boolean().default(true),
});

export const agentSchema = z.object({
  command: z.string().trim().min(1).max(200).default('claude'),
  plugins: z.array(z.string().trim().min(1).max(100)).default(['superpowers']),
  model: z.string().trim().max(100).nullable().default(null),
  extra_args: z.string().trim().max(1000).nullable().default(null),
  /** TER-1117: the server answers the agent CLI's folder trust dialog in the project's linked folder (Claude Code, Codex, Cursor, Gemini: TER-1122) */
  trust_project_folder: z.boolean().default(true),
});

export const verifySchema = z.object({
  type: z.enum(['none', 'ios-simulator', 'web-screenshot', 'command']).default('none'),
  /** command: comando que gera evidência; web-screenshot: URL; ios-simulator: nome do simulador */
  target: z.string().trim().max(2000).nullable().default(null),
  build_command: z.string().trim().max(2000).nullable().default(null),
});

export const decisionMode = z.enum(['ask', 'auto']);
export const approvalsSchema = z.object({
  spec: decisionMode.default('ask'),
  plan: decisionMode.default('ask'),
  pr: decisionMode.default('ask'),
  merge: decisionMode.default('ask'),
  tool_permissions: decisionMode.default('ask'),
  questions: decisionMode.default('ask'),
});

/**
 * A model id as the CLI takes it after `--model`/`-m` (TER-589): an alias (`opus`, `sonnet[1m]`) or a full
 * id (`claude-opus-5-5`, `gpt-5-codex`). The rule itself is shared with the web and the app
 * (`@termhub/mobile-api` models.ts, TER-1097); re-exported here for the routes that validate a model.
 */
export { MODEL_RE };
const modelSchema = z.string().trim().regex(MODEL_RE, 'Modelo inválido').nullable().default(null);

/**
 * The project's AI accounts and default models (spec 2026-09-30 project AI accounts §3). `accounts` are
 * `ai_accounts` ids in priority order; an id whose account is gone is skipped when read, never rewritten.
 * Empty = not configured: every path behaves as before this block existed.
 */
export const aiSchema = z
  .object({
    accounts: z.array(z.string().min(1).max(64)).max(20).default([]),
    models: z.object({ claude: modelSchema, chatgpt: modelSchema }).default({}),
  })
  .superRefine((d, ctx) => {
    if (new Set(d.accounts).size !== d.accounts.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accounts'], message: 'Conta repetida' });
  });
export type ProjectAi = z.infer<typeof aiSchema>;

export const AUTONOMY_LEVELS = ['pr', 'merge', 'deploy', 'release'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
const glob = z.string().trim().min(1).max(200);
// 1200, not more: the implementer template with a custom middle must stay under 4000 characters
const promptText = z.string().trim().min(1).max(1200).nullable().default(null);

/** Agentic board automation (spec 2026-10-04). Off by default: nothing runs until `enabled`. */
export const automationSchema = z.object({
  enabled: z.boolean().default(false),
  types: z.array(z.enum(['story', 'task', 'bug', 'spike'])).min(1).default(['story', 'task', 'bug']),
  // maintainer 2026-10-04: pr for everyone (spec §15.1 alternative)
  autonomy: z.enum(AUTONOMY_LEVELS).default('pr'),
  release_paths: z.array(glob).max(50).default([]),
  store_paths: z.array(glob).max(50).default([]),
  release_workflows: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  // spike R1 (TER-964): workflows (name or file) that must pass on the PR head before termhub merges; [] = every run
  required_checks: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  epic_branch_pattern: z.string().trim().min(1).max(100).refine((p) => p.includes('{ref}'), 'use {ref}').default('epic/{ref}-{slug}'),
  worktrees_dir: z.string().trim().min(1).max(512).default('~/.termhub/worktrees'),
  allowed_tools: z.array(z.string().trim().min(1).max(200)).max(100).nullable().default(null),
  max_parallel: z.number().int().min(1).max(100).nullable().default(null),
  resume_max: z.number().int().min(0).max(10).default(3),
  // TER-1043: off = the agent decides by itself (its recommendation, or the person's precedent) and records
  // it; on = a run that stops on a decision waits for the person ("Parar em decisões de produto")
  stop_on_decisions: z.boolean().default(false),
  fix_attempts: z.number().int().min(0).max(10).default(3),
  // TER-1025: a deploy that failed on GitHub's side (no job, no failed step, an Actions incident) is run again
  // this many times (5, 15, 30 min apart) before the project is paused; 0 = pause at once, as before
  deploy_retries: z.number().int().min(0).max(10).default(3),
  // TER-1025: a run that reported a GitHub error (push or PR) is resumed this many times, once GitHub works
  // again, before it goes to the person
  github_retries: z.number().int().min(0).max(10).default(3),
  daily_budget_usd: z.number().positive().max(100000).nullable().default(null),
  // spike R8 (TER-971): a card whose estimate passes this is escalated and not resumed; null = off
  card_budget_usd: z.number().positive().max(100000).nullable().default(null),
  summary_hour: z.number().int().min(0).max(23).nullable().default(null),
  prompts: z.object({ implementer: promptText, integrator: promptText, fixer: promptText }).default({}),
});
export type ProjectAutomation = z.infer<typeof automationSchema>;

/** ai-memory (TER-1019). `publish_rules`: write the current rules as pinned pages on the project's machines
 *  that already use ai-memory for the checkout. `use_in_runs` (TER-1020): the agents termhub starts get the
 *  machine's ai-memory MCP (and, in an automatic run's worktree, its Claude Code hooks) on machines that
 *  opted in too. Both off by default. */
export const aiMemorySchema = z.object({
  publish_rules: z.boolean().default(false),
  use_in_runs: z.boolean().default(false),
});
export type ProjectAiMemory = z.infer<typeof aiMemorySchema>;

/** TER-1121: the health watcher's signs of stalled work, and the minutes each waits before it counts. */
export const HEALTH_SIGNALS = ['pr_ready', 'base_red', 'queue_stalled', 'tab_stuck', 'tab_waiting', 'card_orphan', 'run_blocked', 'machine_offline', 'delivery_failed', 'agent_outdated'] as const;
export type HealthSignal = (typeof HEALTH_SIGNALS)[number];
export const HEALTH_DEFAULT_MINUTES: Record<HealthSignal, number> = {
  pr_ready: 120,
  base_red: 30,
  queue_stalled: 60,
  tab_stuck: 30,
  tab_waiting: 10,
  card_orphan: 120,
  run_blocked: 60,
  machine_offline: 15,
  delivery_failed: 30,
  agent_outdated: 60,
};
const healthSignalSchema = (minutes: number) =>
  z.object({ enabled: z.boolean().default(true), minutes: z.number().int().min(5).max(7 * 24 * 60).default(minutes) }).default({});

/**
 * The project's health watcher (TER-1121): on by default. The tab and machine signs run on every project; the
 * others only while the project's automatic work is on. Quiet hours and push levels are the person's own
 * notice rules (TER-1101), not repeated here.
 */
export const healthSchema = z.object({
  enabled: z.boolean().default(true),
  signals: z
    .object({
      pr_ready: healthSignalSchema(HEALTH_DEFAULT_MINUTES.pr_ready),
      base_red: healthSignalSchema(HEALTH_DEFAULT_MINUTES.base_red),
      queue_stalled: healthSignalSchema(HEALTH_DEFAULT_MINUTES.queue_stalled),
      tab_stuck: healthSignalSchema(HEALTH_DEFAULT_MINUTES.tab_stuck),
      tab_waiting: healthSignalSchema(HEALTH_DEFAULT_MINUTES.tab_waiting),
      card_orphan: healthSignalSchema(HEALTH_DEFAULT_MINUTES.card_orphan),
      run_blocked: healthSignalSchema(HEALTH_DEFAULT_MINUTES.run_blocked),
      machine_offline: healthSignalSchema(HEALTH_DEFAULT_MINUTES.machine_offline),
      delivery_failed: healthSignalSchema(HEALTH_DEFAULT_MINUTES.delivery_failed),
      agent_outdated: healthSignalSchema(HEALTH_DEFAULT_MINUTES.agent_outdated),
    })
    .default({}),
});
export type ProjectHealth = z.infer<typeof healthSchema>;

/** Why a saved allow rule is refused (TER-968): shown to the person on the field. */
export const UNSAFE_ALLOWED_TOOL = tk('Regra ampla demais para uma aba automática: alcançaria git push, merge, publicação ou outro comando bloqueado. Use uma regra específica, como Bash(npm test:*).');

/**
 * Flags each `allowed_tools` entry too broad for an automatic tab (`unsafeAllowedTool`). Checked when the
 * person saves, not when a stored setup is read: a stored list is filtered at launch instead, so a rule
 * saved before this check never resets the whole automation section to its defaults.
 */
function checkAllowedTools(tools: string[] | null, ctx: z.RefinementCtx, path: (string | number)[]): void {
  tools?.forEach((t, i) => {
    if (unsafeAllowedTool(t)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, i], message: UNSAFE_ALLOWED_TOOL });
  });
}

/** The automation section as the person saves it (the mobile route): `automationSchema` plus the allow-rule check. */
export const automationInputSchema = automationSchema.superRefine((a, ctx) => checkAllowedTools(a.allowed_tools, ctx, ['allowed_tools']));

/** Most per-repo overrides a setup holds (spec 2026-10-07 multi-repo §4). */
export const REPOS_MAX = 50;

/** `owner/repo` is compared without case, as GitHub does. */
export const sameRepo = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** What a repository found by discovery starts with (spec 2026-10-07 multi-repo R2, R6). */
export const repoDefaultsSchema = z.object({
  /** the GitHub integration discovered repos use */
  integration_id: z.string().min(1).nullable().default(null),
  /** how deep discovery looks under the project folder */
  scan_depth: z.number().int().min(1).max(3).default(1),
});
export type RepoDefaults = z.infer<typeof repoDefaultsSchema>;

/**
 * The person's override of one repository, keyed by `owner/repo` (spec 2026-10-07 multi-repo R1, R7). The
 * repository itself comes from discovery (`project_repositories`); an override may also name one that
 * discovery has not seen yet.
 */
export const repoOverrideSchema = z.object({
  full_name: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'use owner/repo'),
  /** false takes the repo out of the project's automatic work; it stays listed */
  enabled: z.boolean().default(true),
  /** null = repo_defaults.integration_id */
  integration_id: z.string().min(1).nullable().default(null),
  /** null = what discovery read */
  description: z.string().trim().min(1).max(200).nullable().default(null),
  /** null = the checkout's default branch */
  base_branch: z.string().trim().min(1).max(100).nullable().default(null),
  /** null = the project's */
  branch_pattern: z.string().trim().min(1).max(100).nullable().default(null),
  deploy_workflow: z.string().trim().min(1).max(200).nullable().default(null),
  /** never above automation.autonomy, which is the ceiling */
  autonomy: z.enum(AUTONOMY_LEVELS).default('pr'),
  required_checks: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  release_workflows: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  /** globs relative to the repo's root */
  release_paths: z.array(glob).max(50).default([]),
  store_paths: z.array(glob).max(50).default([]),
  /** a card's PRs merge lowest first */
  merge_order: z.number().int().min(0).max(999).default(0),
});
export type RepoOverride = z.infer<typeof repoOverrideSchema>;

export const DUPLICATE_REPO = tk('Repositório repetido');
export const REPO_AUTONOMY_ABOVE_PROJECT = tk('A autonomia do repositório não pode passar a do projeto');
export const INVALID_REPO_GLOB = tk('Caminho inválido: use um caminho relativo à raiz do repositório');

const repoRelativeGlob = (g: string) => !g.startsWith('/') && !g.includes('\\') && !g.split('/').includes('..');

/**
 * The checks on per-repo overrides when the person saves: no repo twice, no level above the project's and
 * globs inside the repo. Like the allow rules, they are not applied to a stored setup, so a value that
 * fails a later rule never resets the block when read (the effective list clamps the level instead).
 */
function checkRepos(d: { repos: RepoOverride[]; automation: { autonomy: AutonomyLevel } }, ctx: z.RefinementCtx): void {
  const ceiling = AUTONOMY_LEVELS.indexOf(d.automation.autonomy);
  const seen = new Set<string>();
  d.repos.forEach((r, i) => {
    const name = r.full_name.toLowerCase();
    if (seen.has(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repos', i, 'full_name'], message: DUPLICATE_REPO });
    seen.add(name);
    if (AUTONOMY_LEVELS.indexOf(r.autonomy) > ceiling) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repos', i, 'autonomy'], message: REPO_AUTONOMY_ABOVE_PROJECT });
    for (const field of ['release_paths', 'store_paths'] as const) {
      r[field].forEach((g, j) => {
        if (!repoRelativeGlob(g)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repos', i, field, j], message: INVALID_REPO_GLOB });
      });
    }
  });
}

export const setupSchema = z.object({
  repo: repoSchema.nullable().default(null),
  repo_defaults: repoDefaultsSchema.default({}),
  repos: z.array(repoOverrideSchema).max(REPOS_MAX).default([]),
  tickets: ticketsSchema.nullable().default(null),
  ticket_sources: z.array(ticketSourceSchema).max(20).default([]),
  runner: runnerSchema.default({}),
  agent: agentSchema.default({}),
  verify: verifySchema.default({}),
  approvals: approvalsSchema.default({}),
  ai: aiSchema.default({}),
  automation: automationSchema.default({}),
  ai_memory: aiMemorySchema.default({}),
  health: healthSchema.default({}),
});

export type ProjectSetupData = z.infer<typeof setupSchema>;

/** What PUT /setup accepts: the same shape, no source twice, and per-repo overrides within the project's rules. */
export const setupInputSchema = setupSchema.superRefine((d, ctx) => {
  checkAllowedTools(d.automation.allowed_tools, ctx, ['automation', 'allowed_tools']);
  checkRepos(d, ctx);
  const seen = new Set<string>();
  d.ticket_sources.forEach((s, i) => {
    const id = sourceIdentity(s);
    if (seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticket_sources', i], message: 'Fonte de tickets repetida' });
    seen.add(id);
  });
});

/** `tickets` = the first source (include_done false) or null, so the previous release keeps syncing it. */
export function withLegacyMirror(data: ProjectSetupData): ProjectSetupData {
  const first = data.ticket_sources[0];
  return { ...data, tickets: first ? { ...first, include_done: false } : null };
}

/** Applies defaults/migrations to a saved JSON (may come from an earlier version or the previous release). */
export function normalizeSetup(raw: unknown, _version: number): ProjectSetupData {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const parsed = setupSchema.safeParse(obj);
  let data: ProjectSetupData;
  if (parsed.success) data = parsed.data;
  else {
    // unknown/corrupt format: back to defaults without losing what is valid field by field
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(setupSchema.shape) as (keyof typeof setupSchema.shape)[]) {
      const r = setupSchema.shape[key].safeParse(obj[key]);
      out[key] = r.success ? r.data : setupSchema.shape[key].parse(undefined);
    }
    data = out as ProjectSetupData;
  }
  return withLegacyMirror(withSourcesFromLegacy(obj, data));
}

/**
 * v1, saved by the previous release (its zod strips ticket_sources), or sent by a web app loaded
 * before the deploy: `raw` has `tickets` and no `ticket_sources` key. Rebuild the sources from
 * `tickets` (include_done dropped) instead of reading that as "no source".
 */
export function withSourcesFromLegacy(raw: unknown, data: ProjectSetupData): ProjectSetupData {
  const hasKey = !!raw && typeof raw === 'object' && 'ticket_sources' in raw;
  if (hasKey || !data.tickets) return data;
  const { include_done: _dropped, ...source } = data.tickets;
  return { ...data, ticket_sources: [source] };
}
