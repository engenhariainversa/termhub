import { z } from 'zod';

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
  /** placeholders: {ticket} {slug} */
  branch_pattern: z.string().trim().min(1).max(100).default('{ticket}-{slug}'),
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
 * id (`claude-opus-5-5`, `gpt-5-codex`). Nothing the shell could read is allowed, even though the line
 * quotes it anyway; nor a leading `-`, which the CLI would read as another option.
 *
 * Every `[`, `]` and `-` inside the class is escaped (TER-626): this pattern reaches the start_agent
 * tool's JSON schema, and a validator whose regex engine nests classes (the Claude API's) read the bare
 * `[` as a class that never closes, refused the schema, and every session loading the MCP died with it.
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]\-]{0,99}$/;
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
  fix_attempts: z.number().int().min(0).max(10).default(3),
  daily_budget_usd: z.number().positive().max(100000).nullable().default(null),
  // spike R8 (TER-971): a card whose estimate passes this is escalated and not resumed; null = off
  card_budget_usd: z.number().positive().max(100000).nullable().default(null),
  summary_hour: z.number().int().min(0).max(23).nullable().default(null),
  prompts: z.object({ implementer: promptText, integrator: promptText, fixer: promptText }).default({}),
});
export type ProjectAutomation = z.infer<typeof automationSchema>;

export const setupSchema = z.object({
  repo: repoSchema.nullable().default(null),
  tickets: ticketsSchema.nullable().default(null),
  ticket_sources: z.array(ticketSourceSchema).max(20).default([]),
  runner: runnerSchema.default({}),
  agent: agentSchema.default({}),
  verify: verifySchema.default({}),
  approvals: approvalsSchema.default({}),
  ai: aiSchema.default({}),
  automation: automationSchema.default({}),
});

export type ProjectSetupData = z.infer<typeof setupSchema>;

/** What PUT /setup accepts: the same shape, and no source twice. */
export const setupInputSchema = setupSchema.superRefine((d, ctx) => {
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
