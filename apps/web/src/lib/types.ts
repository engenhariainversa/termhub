export type MachineType = 'local' | 'ssh' | 'agent';
export type ProjectStatus = 'active' | 'paused' | 'archived';

export interface RoleInfo {
  id: string;
  name: string;
  label: string;
  is_admin: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  /** legacy flag; use role_info */
  role: 'owner' | 'member';
  role_info: RoleInfo | null;
  /** "resource:action" grants (admins get the whole catalog) */
  permissions: string[];
  has_password: boolean;
  has_google: boolean;
  /** set when the user was created by an invite */
  invited_at: string | null;
  /** last successful sign-in; null = never (invite pending) */
  last_login_at: string | null;
  /** the address of this user's public city (`/city/@<nickname>`); null until claimed */
  nickname: string | null;
  /** store-review mode: while in the future, this account's mobile device requests auto-approve */
  review_enabled_until: string | null;
  /** the admin who last set review_enabled_until; only the user-admin routes (/api/users) send it */
  review_enabled_by?: string | null;
}

/** Side effects of an invite (the user row is created regardless). */
export interface InviteResult {
  user: User;
  access: { configured: boolean; synced: boolean; error?: string };
  mail: { sent: boolean; error?: string };
}

/** Cloudflare Access allowlist as the server sees it. */
export interface AccessStatus {
  configured: boolean;
  domain?: string;
  policy?: string;
  emails: string[];
  error?: string;
}

export interface Role extends RoleInfo {
  description: string | null;
  is_system: boolean;
  created_at: string;
  users?: number;
}

export type PermissionAction = 'create' | 'read' | 'update' | 'delete';
export interface ResourcePermissions {
  resource: string;
  label: string;
  create: boolean;
  read: boolean;
  update: boolean;
  delete: boolean;
}

export interface Machine {
  id: string;
  name: string;
  /** optional line under the name ("MacBook do escritório"); private: the public city never carries it */
  subtitle: string | null;
  host: string | null;
  ssh_user: string | null;
  ssh_port: number;
  type: MachineType;
  os: string | null;
  capabilities: string[];
  checked_at: string | null;
  /** null when never reported (SSH/local machines, or an agent that never connected) */
  agent_version: string | null;
  /** last time the agent machine was seen online */
  agent_last_seen_at: string | null;
  /** newer agent versions are installed automatically while the machine has no open terminal */
  agent_auto_update: boolean;
  /** a tab whose Claude hits a usage limit resumes on another Claude account of this machine, on its own */
  claude_auto_swap: boolean;
  /** server-computed: the connected agent is older than the latest on npm (absent for offline/non-agent) */
  update_available?: boolean;
  /** the user's own computer: shown only in the browser that added it (see lib/local-machines) */
  is_local: boolean;
  /** null = orphan (visible only to admins viewing "all") */
  owner_id: string | null;
  owner_name: string | null;
  created_at: string;
  /** monitor hooks installed on the machine; null = never installed (nothing reports state) */
  hooks_installed_at?: string | null;
  /** terminal tabs on the machine, and how many of them ever reported a state to the monitor */
  tabs?: number;
  tabs_reporting?: number;
}

/** Admin data-scope switch: null = own data, "all" = everything, or the impersonated user. */
export type ViewAs = null | 'all' | { id: string; name: string; email: string; avatar_url: string | null };

export interface FsRoot {
  kind: 'home' | 'disk';
  label: string;
  path: string;
  source?: string;
  size_kb?: number;
  avail_kb?: number;
}

export interface FsEntry {
  name: string;
  path: string;
}

/** Resposta de GET /machines/:id/fs */
export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  roots: FsRoot[];
}

/** One machine a project is linked to and its working directory there. */
export interface ProjectMachineLink {
  machine_id: string;
  cwd: string;
  position: number;
}

export interface Project {
  id: string;
  /** null = orphan (visible only to admins viewing "all") */
  owner_id: string | null;
  /** short key: URLs and card numbers (TERMHUB-42); unique, never changes */
  key: string;
  next_task_number: number;
  name: string;
  status: ProjectStatus;
  description: string | null;
  last_terminal_at: string | null;
  created_at: string;
  /** machines the project runs on; empty = board and notes only */
  machines: ProjectMachineLink[];
  /** whether this project is a building on its owner's public city (with its agents on the owner's own machines) */
  is_public: boolean;
  /** this project's building id on its owner's public city (one-way, from the server): the share link is built from it */
  public_id: string;
  /** column a card moves to when an agent starts on it; null = automatic (first "Fazendo"). The board reads it from the tasks list. */
  agent_column_id?: string | null;
  /** tasks em "todo" + "doing" (vem na listagem) */
  open_tasks?: number;
}

export interface ProjectGroup {
  id: string;
  name: string;
  kind: 'favorites' | 'custom';
  position: number;
  project_ids: string[];
}

/** Corpo de criação/edição. `machine_id` + `cwd` juntos criam o primeiro vínculo; `create_dir` cria a pasta na máquina. */
export interface ProjectInput {
  name?: string;
  key?: string;
  description?: string | null;
  status?: ProjectStatus;
  machine_id?: string;
  cwd?: string;
  create_dir?: boolean;
  /** edit only (a project is born private): publishes it on the owner's public city */
  is_public?: boolean;
}

export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'done';

/** Kind of card: epics group the work; stories, tasks, bugs and spikes are the work; subtasks are a checklist inside a story or task. */
export type TaskType = 'epic' | 'story' | 'task' | 'subtask' | 'bug' | 'spike';

/** What a board column means to the system (the backlog is not a column). */
export type ColumnCategory = 'todo' | 'doing' | 'done';

export interface Task {
  id: string;
  project_id: string;
  type: TaskType;
  /** sequential per project */
  number: number;
  /** "TER-12"; the card opens at /project/<ref> */
  ref: string;
  title: string;
  description: string | null;
  /** backlog, or the category of its column */
  status: TaskStatus;
  position: number;
  external_ref: ExternalRef | null;
  external_key: string | null;
  tab_id: string | null;
  /** Parent story/task for a subtask; null for every other card. */
  parent_id: string | null;
  /** the epic of a story/task/bug/spike; null on epics and subtasks */
  epic_id: string | null;
  /** board column; null in the backlog and on subtasks */
  column_id: string | null;
  /** Only on top-level cards from the list endpoint. */
  subtasks?: Task[];
  subtask_counts?: { done: number; total: number };
  created_at: string;
  updated_at: string;
}

/** A board column of a project: the user's name, the system's category. */
export interface TaskColumn {
  id: string;
  project_id: string;
  name: string;
  category: ColumnCategory;
  position: number;
  created_at: string;
}

/** GET /projects/:id/tasks */
export interface BoardData {
  tasks: Task[];
  columns: TaskColumn[];
  agent_column_id: string | null;
}

export interface TaskCreateInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  type?: TaskType;
  epic_id?: string | null;
  column_id?: string | null;
  parent_id?: string | null;
}

export interface TaskPatchInput {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  type?: TaskType;
  epic_id?: string | null;
}

/** Where a move sends a card: a column, or a status (backlog, or the first column of a category). */
export type MoveTarget = { column_id: string } | { status: TaskStatus };

/** Progress panel (spec 2026-09-26 progress-panel §4.4); same shape as `@termhub/mobile-api` progress.ts. */
export type ProgressScope = 'active' | 'all';
export type ProgressEstimate =
  | { kind: 'done' }
  | { kind: 'none'; reason: 'not_started' | 'few_samples' }
  | { kind: 'range'; low_s: number; high_s: number; basis: 'agent_time' | 'wall_clock'; samples: number };
export interface AgentOnCard {
  tab_id: string;
  tab_name: string;
  machine_name: string;
  subtask_ref: string | null;
  /** the server sends `waiting_background` as `working` with `background: true` (the contract predates it, TER-644) */
  state: TabState | null;
  state_at: string | null;
  background: boolean;
  needs_you: boolean;
  activity: string | null;
  activity_verb: string | null;
  rate_limited: boolean;
}
/** A GitHub PR linked to a card, with its CI and deploy status (spec 2026-09-26 progress-panel §5.2). */
export interface PullRequestBadge {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  ci_state: 'none' | 'running' | 'passed' | 'failed';
  ci_summary: { total: number; passed: number; failed: number; running: number; failing: string[] };
  deploy_state: 'none' | 'running' | 'passed' | 'failed';
  deploy_url: string | null;
}
export interface CardProgress {
  id: string;
  ref: string;
  title: string;
  type: string;
  status: 'backlog' | 'todo' | 'doing' | 'done';
  column_name: string | null;
  units: { done: number; total: number };
  percent: number;
  started_at: string | null;
  done_at: string | null;
  active_seconds: number;
  estimate: ProgressEstimate;
  agents: AgentOnCard[] | null;
  pull_requests: PullRequestBadge[];
}
export interface EpicProgress {
  id: string;
  ref: string;
  title: string;
  project: { id: string; key: string; name: string };
  units: { done: number; total: number; backlog_total: number };
  percent: number;
  estimate: ProgressEstimate;
  cards_without_estimate: number;
  agents: { working: number; needs_you: number; idle: number } | null;
  cards: CardProgress[];
  /** distinct PR numbers across the epic's cards; null when none has a PR */
  ci: { open: number; failed: number; running: number; deployed: number } | null;
  ci_error: string | null;
}
export interface ProgressResponse {
  epics: EpicProgress[];
  generated_at: string;
}

export interface Ticket {
  id: string;
  project_id: string;
  integration_id: string;
  provider: IntegrationProvider;
  sync_key: string;
  key: string;
  scope: string | null;
  title: string;
  description: string | null;
  url: string;
  state: string;
  status: TaskStatus;
  meta: Record<string, unknown> & { labels?: string[]; assignee?: string | null; priority?: unknown; updated_at?: string };
  task_id: string | null;
  synced_at: string;
  created_at: string;
}

/** One ticket source of a project's setup: identity is (integration_id, scope). Open tickets only. */
export interface TicketSource {
  provider: IntegrationProvider;
  integration_id: string;
  scope: string;
  filter: string | null;
  sync_minutes: number;
}

/** One source's outcome of POST /projects/:id/tickets/sync; absent counters/flags mean "not applicable". */
export interface SourceSync {
  provider: IntegrationProvider;
  integration_id: string;
  scope: string;
  fetched?: number;
  created?: number;
  updated?: number;
  removed?: number;
  truncated?: boolean;
  error?: string;
}

export interface ExternalRef {
  provider: IntegrationProvider;
  id: string;
  identifier: string;
  url: string;
  state: string;
  status: TaskStatus;
  scope?: string;
  pushed_at?: string;
  updated_at?: string;
  priority?: unknown;
  assignee?: string | null;
  labels?: string[];
  /** New links carry the ticket key directly; legacy GitHub links rebuild it from `identifier` + `scope`. */
  key?: string;
  provider_id?: string;
  integration_id?: string;
}

export type IntegrationProvider = 'github' | 'linear' | 'jira';

export interface Integration {
  id: string;
  provider: IntegrationProvider;
  name: string;
  config: Record<string, unknown>;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionInfo {
  ok: boolean;
  account?: string;
  options?: Record<string, { id: string; name: string }[]>;
  error?: string;
}

export type DecisionMode = 'ask' | 'auto';

/** The project's AI accounts (priority order) and default model per CLI (TER-589); mirrors `@termhub/mobile-api` project-ai.ts. */
export interface ProjectAi {
  accounts: string[];
  models: { claude: string | null; chatgpt: string | null };
}
export interface ProjectAiOption {
  id: string;
  label: string;
  provider: 'claude' | 'chatgpt';
  machine_id: string;
  machine_name: string;
  /** the machine's own login (no config dir override) */
  default: boolean;
}
export interface ProjectAiView {
  ai: ProjectAi;
  available: ProjectAiOption[];
}

/** A usage-limit card in a project's chat (TER-589): a tab stuck on its account's limit. */
export interface TabLimit {
  id: string;
  tab_id: string;
  tab_name: string | null;
  payload: {
    account: { id: string; label: string } | null;
    machine: { id: string; name: string };
    resets_at: string | null;
    candidates: { id: string; label: string }[];
  };
  status: 'open' | 'swapped' | 'dismissed' | 'expired' | 'failed';
  result: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface ProjectSetupData {
  repo: {
    integration_id: string | null;
    full_name: string | null;
    base_branch: string;
    branch_pattern: string;
    draft_pr: boolean;
    deploy_workflow: string | null;
  } | null;
  /** server-owned mirror of ticket_sources[0] (with include_done: false), or null; send it back as received */
  tickets: {
    provider: IntegrationProvider;
    integration_id: string;
    scope: string;
    filter: string | null;
    include_done: boolean;
    sync_minutes: number;
  } | null;
  ticket_sources: TicketSource[];
  runner: { machine_id: string | null; cwd: string | null; setup_command: string | null; worktree: boolean };
  agent: { command: string; plugins: string[]; model: string | null; extra_args: string | null };
  verify: { type: 'none' | 'ios-simulator' | 'web-screenshot' | 'command'; target: string | null; build_command: string | null };
  approvals: Record<'spec' | 'plan' | 'pr' | 'merge' | 'tool_permissions' | 'questions', DecisionMode>;
}

export interface ProjectSetup {
  project_id: string;
  version: number;
  data: ProjectSetupData;
  updated_at: string | null;
}

export const PROVIDER_LABEL: Record<IntegrationProvider, string> = { github: 'GitHub', linear: 'Linear', jira: 'Jira' };

export const APPROVAL_LABEL: Record<keyof ProjectSetupData['approvals'], { label: string; hint: string }> = {
  spec: { label: 'Aprovar a spec', hint: 'antes de o agente planejar' },
  plan: { label: 'Aprovar o plano', hint: 'antes de implementar' },
  pr: { label: 'Aprovar o PR', hint: 'com o screenshot/evidência' },
  merge: { label: 'Fazer o merge', hint: 'após o PR aprovado' },
  tool_permissions: { label: 'Permissões de ferramentas', hint: 'pedidos do Claude para rodar comandos/editar' },
  questions: { label: 'Perguntas do agente', hint: 'dúvidas em aberto durante a run' },
};

export interface Note {
  id: string;
  project_id: string;
  content: string;
  updated_at: string;
}

export interface DashboardItem {
  project: Project;
  machines: Machine[];
  doing: Task[];
  open_tasks: number;
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'A fazer',
  doing: 'Fazendo',
  done: 'Feito',
};

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  epic: 'Épico',
  story: 'História',
  task: 'Tarefa',
  subtask: 'Subtarefa',
  bug: 'Bug',
  spike: 'Spike',
};

export const COLUMN_CATEGORY_LABEL: Record<ColumnCategory, string> = {
  todo: 'A fazer',
  doing: 'Fazendo',
  done: 'Feito',
};

export type TabKind = 'terminal' | 'simulator';

export interface Tab {
  id: string;
  project_id: string;
  machine_id: string;
  name: string;
  kind: TabKind;
  tmux_session: string | null;
  simulator_udid: string | null;
  position: number;
  /** monitor: what the tool in the tab is doing (from its hooks); null = never reported */
  state: TabState | null;
  /** the tool's pending question / notification */
  state_text: string | null;
  state_tool: string | null;
  state_at: string | null;
  /** when the tab was last looked at while needing you; null or before state_at = still needs you */
  state_seen_at: string | null;
  /** which tool the working tab is about to call, mapped to a category; null off `working`, or an agent too old to report it */
  activity: TabActivity | null;
  /** Claude Code's spinner verb that came with `activity` ("Moonwalking"); null without one */
  activity_verb: string | null;
  created_at: string;
  alive: boolean;
  /** the Claude account this tab's session last ran under; null = unknown (the agent was started by hand, not by termhub) */
  ai_account_id: string | null;
  /** set while its Claude is stuck on a usage limit; null once it resumes */
  rate_limited_at: string | null;
}

/** `waiting_background`: the agent ended its turn while its own subagents, shells or monitors still run (TER-644). */
export type TabState = 'working' | 'waiting_input' | 'waiting_permission' | 'idle' | 'error' | 'waiting_background';

export type TabActivity = 'coding' | 'reading' | 'researching' | 'planning' | 'terminal' | 'working';

export const TAB_STATE_LABEL: Record<TabState, string> = {
  working: 'trabalhando',
  waiting_input: 'esperando resposta',
  waiting_permission: 'pedindo permissão',
  idle: 'terminou',
  error: 'erro',
  waiting_background: 'aguardando segundo plano',
};

/** States in which the tool is waiting for the person. */
export const NEEDS_YOU: readonly TabState[] = ['waiting_input', 'waiting_permission'];

export interface TabEvent {
  id: string;
  tab_id: string;
  kind: TabState;
  tool: string;
  text: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

/** Monitor hooks on a machine (GET /machines/:id/hooks). */
export interface MachineHooks {
  installed_at: string | null;
  hooks_url: string;
}

export interface MonitorItem {
  tab: Tab;
  project: Project;
  machine: Machine;
}

/** Board columns that count as a project's work in the office: todo, doing, done (not the backlog). */
export interface OfficeTaskCounts {
  todo: number;
  doing: number;
  done: number;
}

/** The board task bound to a tab, if any (a tab's own `doing` task with subtasks). */
export interface OfficeTabProgress {
  task_id: string;
  title: string;
  done: number;
  total: number;
}

export interface OfficeTab extends Tab {
  progress: OfficeTabProgress | null;
}

/** One building of the office (GET /office): a project and every desk (tab) it has, whatever machine each runs on. */
export interface OfficeBuilding {
  project: Project;
  /** the building's id on the owner's public city (the same as `project.public_id`) */
  public_id: string;
  tabs: OfficeTab[];
  /** null when the board could not be read (no `tasks:read`); a project with no tasks sends zeros */
  tasks: OfficeTaskCounts | null;
}

/** A machine one of the city's desks runs on: a detail of the desk, never a building. */
export interface OfficeMachine {
  id: string;
  name: string;
  subtitle: string | null;
  type: MachineType;
  online: boolean;
  /** the tmux probe: false = it could not ask the machine; null = not probed (no terminal desk on it) */
  reachable: boolean | null;
}

/** GET /office: the whole city — one building per non-archived project of the scope, and the machines its desks run on. */
export interface OfficeCity {
  projects: OfficeBuilding[];
  machines: OfficeMachine[];
}

/**
 * The public city, mirrored field for field from apps/server/src/public/city.ts — the only shape a
 * visitor with no account ever sees. A building is a published project; nothing about a machine is
 * in it. The ids are derived from the real ones by the server and are what the public surfaces join on.
 */
export interface PublicRobot {
  id: string;
  name: string;
  kind: TabKind;
  state: TabState | null;
  state_at: string | null;
  activity: TabActivity | null;
  /** Claude Code's spinner verb, only when it is one of its defaults (the server drops custom verbs) */
  activity_verb: string | null;
  alive: boolean;
  /** the board task bound to the tab, without its title: a bar, never what it says */
  progress: { done: number; total: number } | null;
}

export interface PublicBuilding {
  id: string;
  name: string;
  robots: PublicRobot[];
}

export interface PublicCity {
  nickname: string;
  owner_name: string;
  /** the owner's short link (77a.it/…), or null: use the long /city/@nickname address */
  short_url: string | null;
  buildings: PublicBuilding[];
}

/** GET/PUT /api/auth/me/city-link: the signed-in person's city address and its short link. */
export interface CityLink {
  /** the instance has a TypeToAccess key: partner links are created and a custom one can be set */
  enabled: boolean;
  /** the long address, null until the person has a nickname */
  city_url: string | null;
  /** the link to hand out: the custom one, else the partner one; null = use city_url */
  short_url: string | null;
  source: 'custom' | 'partner' | null;
  partner_url: string | null;
}

/** Settings → Arquivos: one file in ~/.cache/termhub/paste/ on a machine, with who pasted it when known. */
export interface UploadEntry {
  machine_id: string;
  name: string;
  bytes: number;
  modified_at: string;
  /** false = the machine could not be listed; the entry comes from the DB and the file may be gone */
  on_disk: boolean;
  upload: {
    id: string;
    user_id: string | null;
    user_name: string | null;
    user_email: string | null;
    mime: string;
    project_id: string | null;
    created_at: string;
  } | null;
}

export interface UploadMachineStatus {
  id: string;
  name: string;
  /** files with no upload record are attributed to the owner (only they can paste into the machine) */
  owner_id: string | null;
  owner_name: string | null;
  ok: boolean;
  error?: string;
}

export interface Transcription {
  id: string;
  status: 'pending' | 'done' | 'error';
  text?: string;
  /** audio length in seconds */
  duration?: number;
  error?: string;
  /** pending only: estimated seconds until the text is ready */
  eta_seconds?: number;
  /** pending only: 0..1 share of the estimated time already elapsed */
  progress?: number;
}

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
}

export interface WdaSetupState {
  state: 'idle' | 'running' | 'ok' | 'failed';
  tail: string[];
  version: string | null;
}

export interface Screen {
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
}

export interface AuthConfig {
  modes: ('app' | 'cloudflare' | 'disabled')[];
  google: boolean;
  password: boolean;
  email_code: boolean;
  /** where this instance's public cities live, e.g. https://termhub.dev/city — share links are built from it */
  public_city_url: string;
}

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Ativo',
  paused: 'Pausado',
  archived: 'Arquivado',
};

export type AiProvider = 'claude' | 'chatgpt' | 'gemini' | 'antigravity';

export interface AiAccount {
  id: string;
  provider: AiProvider;
  label: string;
  machine_id: string;
  config_dir: string | null;
  created_at: string;
}

export interface AiUsageWindow {
  key: string;
  label: string;
  /** 0..100 */
  utilization: number;
  resets_at: string | null;
}

export interface AiAccountUsage {
  account_id: string;
  fetched_at: string;
  ok: boolean;
  plan: string | null;
  windows: AiUsageWindow[];
  error: string | null;
  hint: string | null;
  /** last good reading, shown because the provider is rate-limiting the usage query */
  stale?: boolean;
}

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', antigravity: 'Antigravity' };

/** GET /machines/:id/hardware */
export interface HardwareSnapshot {
  os: string | null;
  hostname: string | null;
  cpu_model: string | null;
  ncpu: number | null;
  uptime_s: number | null;
  load: [number, number, number] | null;
  cpu_pct: number | null;
  mem_total_kb: number | null;
  mem_used_kb: number | null;
  swap_total_kb: number | null;
  swap_used_kb: number | null;
  disks: { mount: string; source: string; size_kb: number; used_kb: number; avail_kb: number }[];
  temps: { label: string; c: number }[];
  gpus: { name: string; utilization: number | null; mem_used_mb: number | null; mem_total_mb: number | null; temp_c: number | null }[];
  processes: { cpu: number; mem: number; command: string }[];
  collected_at: string;
}

/** GET /chat: the account-wide conversation (no project) or one project's own. */
export interface ChatConversation {
  id: string;
  title: string | null;
  model: string | null;
  review_mode: boolean;
  /** The host machine this conversation runs on; null = not chosen yet (see `ChatHostState`). */
  machine_id?: string | null;
  /** The Claude account on that host; null = the machine's own default login. */
  ai_account_id?: string | null;
  /** null = the account-wide chat; a project id = that project's own chat. */
  project_id: string | null;
  /** When this conversation was archived by a "Nova conversa" reset; null while it is the active one. */
  archived_at: string | null;
  /** How many tokens the session's context holds, after the last answer or compaction (TER-315); null
   *  until an answer reports it. Absent from an older server. */
  context_tokens?: number | null;
  /** The model's context window; null when the CLI did not report it. */
  context_window?: number | null;
  last_message_at: string | null;
}

/**
 * Why an answer stopped. Every label a runner can end a run with becomes one of these server-side
 * (`ChatErrorCode` in `apps/server/src/chat/service.ts`), and each one means something different to
 * the person reading it: a machine with no `claude` installed is not "the answer did not finish", it
 * is one install away from working. `ChatTurn` has the sentence for each.
 */
export type ChatErrorCode =
  /** the stream ended with nothing said about why */
  | 'RUNNER_FAILED'
  /** the server could not even mint the concierge's credential */
  | 'TOKEN_FAILED'
  /** no `claude` on the host machine */
  | 'CLI_MISSING'
  /** the CLI refused our own flags */
  | 'CLI_REJECTED'
  /** the CLI session this conversation was resuming is gone from that machine */
  | 'MISSING_SESSION'
  /** the run started and died */
  | 'RUN_FAILED'
  /** the process was killed (a deadline, an abandoned request, an agent shutting down) */
  | 'KILLED'
  /** the host machine went away mid-run — a laptop that closed, most often */
  | 'HOST_GONE'
  /** the host's agent does not know how to run a chat */
  | 'AGENT_TOO_OLD'
  /** the host machine is up and healthy, with every channel taken: the run could not start */
  | 'HOST_BUSY'
  /** the Claude account hit its usage limit (the message's `notice` says when it resets) */
  | 'USAGE_LIMIT'
  /** the CLI does not know the model the chat asked for */
  | 'MODEL_UNAVAILABLE'
  /** the Claude account is not logged in on the host machine */
  | 'AUTH_FAILED';

/**
 * Mirrors `ChatNotice` in `apps/server/src/db/repositories/chat.ts` (TER-588): what an answer says besides
 * its text. Account labels are null for the machine's default login.
 */
export type ChatNotice =
  | { kind: 'usage_limit'; account: string | null; resets_at: string | null; fallback: 'none_free' | 'no_other_account' | 'auto_swap_off' }
  | { kind: 'account_swap'; from: string | null; to: string; resets_at: string | null };

/** Mirrors `chatAttachment` in `packages/mobile-api/src/attachments.ts` (the web has no workspace deps). */
export type AttachmentKind = 'image' | 'pdf' | 'docx' | 'xlsx' | 'audio' | 'video' | 'text';
export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  bytes: number;
  status: 'pending' | 'ready' | 'failed';
  error_code: string | null;
  /** pages, duration_s, sheets, width, height, truncated */
  meta: Record<string, unknown> | null;
  created_at: string;
}

/** `error_code` set means the answer did not finish, and which of the ten ways it did not. */
export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  text: string;
  error_code: ChatErrorCode | null;
  /** A usage limit or an account that took over (TER-588); absent when there is none. */
  notice?: ChatNotice;
  created_at: string;
  /** The files sent with a user message; absent when none. */
  attachments?: ChatAttachment[];
  /** What this message answers (TER-447); absent when it is not a reply. */
  reply_to?: ChatReplyRef;
}

/** The thread's cards a message can answer instead of a message (TER-849). */
export type ReplyCardKind = 'action' | 'tab_question';

/** What a message answers (TER-447): a snapshot taken when it was sent; `id` is null once the original
 *  was deleted, and on a reply to a card (TER-849), which `card` names. */
export interface ChatReplyRef {
  id: string | null;
  role: 'user' | 'assistant';
  excerpt: string;
  card?: { kind: ReplyCardKind; id: string };
}

/** All the chat's host line ever needs of a machine; the payload carries whole `Machine` rows. */
export type ChatHostMachine = Pick<Machine, 'id' | 'name'>;

/** All the host picker needs of a Claude account of the host machine: which one, and what to call it. */
export type ChatHostAiAccount = Pick<AiAccount, 'id' | 'label'>;

/**
 * Which Claude login on the host runs the conversation. `lost` is an account the user chose that this
 * host cannot use (deleted, left on another machine by a host change, or not a Claude login): the run
 * degrades to the machine's default login, which is the right thing to run and the wrong thing to do
 * without saying so.
 */
/** `via: 'project'` (TER-589): the project's setup chose this account for the project chat, not the person. */
export type ChatHostAccount = { kind: 'chosen'; id: string; label: string; via?: 'project' } | { kind: 'default' } | { kind: 'lost' };

/**
 * `GET /api/chat`'s `host`: which machine and account run this conversation — the "terminal geral" of
 * the spec — or why none can. The server resolves it (`resolveHost`); `ChatHost` renders it and
 * nothing re-derives any part of it in the browser.
 */
export type ChatHostState =
  /**
   * `sessionAtStake` on a host that *can* run: this conversation already ran, and the machine holding
   * that CLI session is not the one about to answer — the only candidate left was picked for the person
   * (their other machine was unenrolled), so the transcript stays and the model's memory starts over.
   * The screen says that once, because nothing else will: the failed resume and the fresh session are
   * both invisible from the browser.
   */
  | { kind: 'ready'; machine: ChatHostMachine; configDir: string | null; account: ChatHostAccount; sessionAtStake: boolean }
  | { kind: 'no_machine' }
  /**
   * `sessionAtStake` is the server's answer to "is there a model memory to lose here": true when the
   * conversation already ran and the machine holding that CLI session is no longer the chosen one
   * (unenrolled, or never stored while there was only one machine). Picking any other machine starts
   * the session over, so that — and only that — is warned about before the pick.
   */
  | { kind: 'not_chosen'; machines: ChatHostMachine[]; sessionAtStake: boolean }
  | { kind: 'offline'; machine: ChatHostMachine }
  /** `version` is empty when the agent never said which one it is: the sentence then drops it. */
  | { kind: 'agent_too_old'; machine: ChatHostMachine; version: string };

export type ChatActionClass = 'read' | 'write' | 'irreversible';
export type ChatActionStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';

/**
 * A pending card's decision word, sent to `POST /api/chat/actions/:id/decision`: `approve`/`deny` decide
 * this one call; `approve_tab`/`approve_project` are the narrow standing grants (agent text on one tab /
 * board tools on one project); `approve_tab_terminal`/`approve_project_all` are the wider ones (keys and
 * shell typing on one tab / everything above plus that on every tab of the project) — spec 2026-09-27 §6.
 * `approve_project_always` is "Liberar sem prazo": this card's kind of action on its project, with no
 * expiry, until revoked (spec 2026-09-28 TER-386).
 */
export type ChatDecisionWord = 'approve' | 'deny' | 'approve_tab' | 'approve_project' | 'approve_tab_terminal' | 'approve_project_all' | 'approve_project_always';

/**
 * A write the concierge proposed on a gated token, as the server enriches it: `summary` is the
 * server-composed pt-BR sentence ("digitar `npm test` na aba Terminal 2 do projeto reactivando, no
 * macbook m3") — never a tool name and three ids. Never render it as HTML: it can carry a command a
 * model read off a real terminal screen.
 */
export interface ChatAction {
  id: string;
  tool: string;
  args: unknown;
  class: ChatActionClass;
  status: ChatActionStatus;
  machine_id: string | null;
  project_id: string | null;
  tab_id: string | null;
  summary: string;
  created_at: string;
  /** The grant this run happened under ("aba confiada"), if the server ran it without asking. */
  grant_id?: string | null;
  /** The subagent (spec 2026-09-26 §4) whose turn proposed this action; null for the top-level run. */
  subagent?: { id: string; description: string } | null;
  /** Why a `failed` row failed (`TAB_GONE`, `WAITING_PERMISSION`, `PROMPT_CHANGED`…); absent from an older server. */
  error_code?: string | null;
  /** When the card was last brought back to the end of the chat (TER-477): the thread orders it by
   * `surfaced_at ?? created_at`. Absent from an older server. */
  surfaced_at?: string | null;
  /** A send the concierge made on a precedent from memory (TER-641); null when it cited none, absent
   * from an older server. Shown as "Decisão automática" only when the call ran without a click. */
  auto_decision?: AutoDecision | null;
}

/** Mirrors the server's `AutoDecisionView` (auto-decision-view.ts, TER-641): what the concierge sent a
 * tab on its own from memory. A `decision:` ref of the person's own carries its recorded question and
 * answer; any other ref (a card, a note, a decision forgotten since) only `ref`. */
export interface AutoDecision {
  reason: string | null;
  sources: { ref: string; question: string | null; answer: string | null }[];
}

/** Mirrors the server's `SubagentStatus` (apps/server/src/chat/stream.ts). */
export type SubagentStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted';

/** What the panel and the card need about one subagent — never its prompt or its turns' text
 * (spec 2026-09-26 §7). Mirrors the server's `SubagentView` (apps/server/src/chat/subagent-view.ts). */
export interface SubagentView {
  id: string;
  description: string;
  subagent_type: string | null;
  status: SubagentStatus;
  started_at: string;
  ended_at: string | null;
}

/**
 * A "Permitir sempre nesta aba" grant, as the server enriches it: `tab_name` is the tab's name at
 * read time, or null once the tab is gone — the card and the strip still name it plainly either way.
 */
export interface ChatGrant {
  id: string;
  tab_id: string;
  tool: string;
  source_action_id: string | null;
  created_at: string;
  expires_at: string;
  tab_name: string | null;
}

/**
 * A "Permitir sempre neste projeto" grant, as the server enriches it: it trusts the whole board of one
 * project rather than a single tab. `project_name` is null once the project is gone. `scope` is `'all'`
 * for "Liberar tudo neste projeto" (the board tools plus the terminal level on every tab of the
 * project); `'board'` (or absent, from an older server) is the narrower board-only grant.
 */
export interface ChatProjectGrant {
  id: string;
  project_id: string;
  project_name: string | null;
  source_action_id: string | null;
  created_at: string;
  expires_at: string;
  scope?: 'board' | 'all';
}

/** What a standing grant ("Liberar sem prazo") trusts on its project; mirrors the server's `StandingKind`. */
export type ChatStandingKind = 'open_tab' | 'close_tab' | 'start_agent' | 'board' | 'terminal';

/**
 * A "Liberar sem prazo" grant (spec 2026-09-28 TER-386): one user, one project, one kind of action,
 * no expiry — it lasts until revoked and is not bound to the conversation that created it.
 * `project_name` is null once the project is gone.
 */
export interface ChatStandingGrant {
  id: string;
  project_id: string;
  project_name: string | null;
  kind: ChatStandingKind;
  source_action_id: string | null;
  created_at: string;
}

/** How a listed grant stands: in force, run out, revoked by someone, or ended by "Nova conversa". */
export type ChatGrantState = 'active' | 'expired' | 'revoked' | 'ended';

/**
 * A row of "Permissões do chat" (`GET /api/chat/grants?kinds=all_standing`): a trusted tab, a trusted
 * project or a standing grant, told apart by `kind`. `tab_id`/`tool`/`tab_name` are set only for
 * `kind === 'tab'`; `project_id`/`project_name` are set for all three (a tab grant always belongs to a
 * project too). A standing row has no expiry and no conversation, and is only `active` or `revoked`.
 */
/** A default allowance of the chat (TER-627): something it does without asking unless restricted. The
 *  label is server-worded. */
export interface ChatDefault {
  kind: 'open_tab' | 'start_agent' | 'link_tab_task' | 'board' | 'terminal' | 'close_tab';
  label: string;
  allowed: boolean;
}

export interface ChatGrantListItem {
  kind: 'tab' | 'project' | 'standing';
  /** The standing grant's kind; null for a tab or project row. */
  standing_kind: ChatStandingKind | null;
  id: string;
  tab_id: string | null;
  tool: string | null;
  /** The tab's name at read time; null once the tab is gone, or for a `project` row. */
  tab_name: string | null;
  source_action_id: string | null;
  created_at: string;
  /** Null only on a standing row. */
  expires_at: string | null;
  project_id: string | null;
  project_name: string | null;
  /** `'board'`/`'all'` for a project row (`null`/absent from an older server means `'board'`); always
   * `null` for a tab row. */
  scope?: 'board' | 'all' | null;
  /** Null on a standing row (not bound to a conversation). */
  conversation_id: string | null;
  /** Null = the account-wide chat. */
  conversation_project_name: string | null;
  conversation_archived: boolean;
  state: ChatGrantState;
  ended_at: string | null;
}

/** One option of a tab's question; `recommended` came out of Claude Code's own "(Recommended)". */
export interface TabQuestionOption {
  label: string;
  description: string;
  recommended: boolean;
}
export interface TabQuestionItem {
  question: string;
  header: string;
  multi_select: boolean;
  options: TabQuestionOption[];
}
export type TabQuestionStatus = 'open' | 'answered' | 'answered_in_tab' | 'expired' | 'failed';
/** One entry per question: option indexes (0-based), or the typed text. */
export interface ChoiceAnswer {
  answers: { selected: number[]; text?: string }[];
}
export interface PermissionAnswer {
  allow: boolean;
  text?: string;
}
export type TabQuestionAnswer = ChoiceAnswer | PermissionAnswer;

/** One past decision offered as a pre-selected answer to a similar new question (spec 2026-09-26 chat
 * decision memory §4.2/§5.1). `selected` is already expressed in the *new* question's own option
 * indexes (the mapping is done server-side); `text` is set instead for a free-text past answer. */
export interface TabQuestionSuggestionItem {
  question_index: number;
  /** `""` on a concierge suggestion that cited no decision (spec 2026-09-26 concierge memory §3.2). */
  decision_id: string;
  similarity: number;
  selected: number[];
  text?: string;
  source: { question: string; project_name: string | null; answered_at: string };
  /** Set on a concierge call to `answer_tab_question` (mode "suggest"): its own line and reason replace
   *  the TER-57 "Sugestão da memória" one. Absent = the ordinary past-decision suggestion. */
  by?: 'concierge';
  reason?: string;
  /** The concierge's cited refs, `"kind:id"` each (spec 2026-09-26 concierge memory §5.4); never rendered. */
  sources?: string[];
}
export interface TabQuestionSuggestion {
  items: TabQuestionSuggestionItem[];
}

/** A countdown that sends `answer` by itself at `due_at` unless the person cancels it (spec 2026-09-26
 * concierge memory §6). `by: 'memory'` is a near-verbatim repeat, `'concierge'` the concierge's call. */
export interface TabQuestionAutoAnswer {
  answer: ChoiceAnswer;
  by: 'memory' | 'concierge';
  reason: string;
  sources: { kind: string; id: string }[];
  due_at: string;
  status: 'scheduled' | 'cancelled' | 'sent' | 'failed';
  error_code?: string;
  decided_by?: string;
  claimed_at?: string;
}

interface TabQuestionBase {
  id: string;
  tab_id: string;
  /** The tab's name at read time; null once the tab is gone. */
  tab_name: string | null;
  status: TabQuestionStatus;
  error_code: string | null;
  created_at: string;
  /** When the card was last brought back to the end of the chat (TER-477); absent from an older server. */
  surfaced_at?: string | null;
  answered_at: string | null;
  closed_at: string | null;
  /** Only while the card is `open`; absent from a server that predates it, so treat undefined as null. */
  suggestion?: TabQuestionSuggestion | null;
  /** The countdown while the card is open (or once sent/failed); absent from an older server. */
  auto_answer?: TabQuestionAutoAnswer | null;
  /** `'auto'` when the countdown sent the answer; absent from an older server. */
  answered_via?: 'card' | 'auto' | null;
  /** "Decisão automática" (TER-641): set while the countdown runs, or on a card it answered. */
  auto_decision?: AutoDecision | null;
}
export type TabQuestionChoice = TabQuestionBase & { kind: 'choice'; payload: { questions: TabQuestionItem[]; agent?: 'codex' }; answer: ChoiceAnswer | null };
export type TabQuestionPermission = TabQuestionBase & { kind: 'permission'; payload: { tool_name: string; agent?: 'codex'; question?: string }; answer: PermissionAnswer | null };
/**
 * A question an agent in a tab asked (spec 2026-09-25): shown as a card in the project's chat and
 * answered from there. Plain text only — never render any of it as HTML: it is what an agent wrote.
 */
export type TabQuestion = TabQuestionChoice | TabQuestionPermission;

/** "Memória do chat" (spec 2026-09-26 §4.6/§5.2): one remembered decision, as the list shows it — never
 * the embedding, the owning user, the conversation or the tab question it came from. */
export interface ChatDecisionOption {
  label: string;
  description: string;
}
export interface ChatDecisionAnswer {
  labels: string[];
  text?: string;
}
export interface ChatDecision {
  id: string;
  project_id: string | null;
  project_name: string | null;
  header: string;
  question: string;
  options: ChatDecisionOption[];
  multi_select: boolean;
  answer: ChatDecisionAnswer;
  suggested_count: number;
  accepted_count: number;
  created_at: string;
}
/** `GET /chat/memory`: the suggestion switch, "Responder sozinho quando houver precedente" (spec D8),
 * whether embeddings are configured on this server at all (`available: false` hides both switches
 * rather than offering ones that can never do anything), how many decisions are remembered, and how
 * many concierge notes (spec D12) there are. */
export interface ChatMemory {
  enabled: boolean;
  autodecide: boolean;
  /** "Responder perguntas do Codex pelo chat": off by default; independent of embeddings. */
  codex_replies: boolean;
  available: boolean;
  count: number;
  notes: number;
}

/** "Anotações do concierge" (spec D12/§8): one `record_decision` note, as the list shows it —
 * `question` is the note's title; `decision`/`reason` are parsed server-side out of the stored text's
 * `Decisão:`/`Motivo:` lines. */
export interface ConciergeNote {
  id: string;
  project_id: string | null;
  project_name: string | null;
  question: string;
  decision: string;
  reason: string;
  created_at: string;
}

/** "Lições" (spec 2026-09-27 failure lessons §6/§8): one `lesson` item (chunk 0), as the "Lições"
 * list (and the verify/unverify routes, which answer the same shape) show it — never the embedding,
 * the owning user, `source_id` or the raw `meta`. `project` is `null` for an orphaned project; `path`,
 * `tab_id`, `card` and `pr` are `null` when the lesson (or its origin) has none. */
export interface LessonItem {
  id: string;
  project: { id: string; name: string } | null;
  title: string;
  excerpt: string;
  origin: 'file' | 'note';
  path: string | null;
  tab_id: string | null;
  card: string | null;
  pr: string | null;
  evidence: 'observed' | 'fixed' | 'confirmed';
  verified: boolean;
  verified_at: string | null;
  created_at: string;
}

export type TabSuggestionStatus = TabQuestionStatus | 'dismissed';
/**
 * Claude Code's dimmed next prompt in a tab (spec 2026-09-25 tab suggestions §6.4): a card with the text
 * editable, Enviar / Dispensar. `answer.text` is what was sent. Plain text only — never render it as HTML.
 */
export interface TabSuggestion {
  id: string;
  tab_id: string;
  /** The tab's name at read time; null once the tab is gone. */
  tab_name: string | null;
  kind: 'suggestion';
  /** `context`: the agent's message the suggestion answers (TER-96); null or absent when there is none. */
  /** `exited` (TER-643): the tab's agent exited without finishing its turn, `text` is the line that resumes it and
   *  `last_at` the tab's last state change before that. */
  payload: { text: string; context?: string | null; agent?: 'codex'; exited?: boolean; last_at?: string | null };
  status: TabSuggestionStatus;
  answer: { text: string } | null;
  error_code: string | null;
  created_at: string;
  /** When the card was last brought back to the end of the chat (TER-477); absent from an older server. */
  surfaced_at?: string | null;
  answered_at: string | null;
  closed_at: string | null;
}

/**
 * Pushed over /ws/chat for the signed-in user only; carries no history. The socket is per user, not
 * per conversation — it carries the account-wide chat and every project chat together — so every
 * member gains `conversation_id`, which is what a reader (`ChatPanel`) filters live events by.
 * Optional, not required: an older server that predates project chats never sends it, and every event
 * without one is treated as belonging to whichever conversation is open.
 */
export type ChatEvent =
  | { type: 'message'; message: ChatMessage; conversation_id?: string }
  | { type: 'delta'; message_id: string; delta: string; conversation_id?: string }
  | { type: 'action'; message_id: string; tool: string; tool_use_id: string; args: unknown; conversation_id?: string }
  | { type: 'action_result'; message_id: string; tool_use_id: string; ok: boolean; conversation_id?: string }
  /** the server retried the run on a fresh CLI session: drop whatever streamed for this message so far */
  | { type: 'reset'; message_id: string; conversation_id?: string }
  /** An answer row is open: a process has its turn, or the queue holds it. Sent again when a queued row is taken. */
  | { type: 'run_started'; message_id: string; conversation_id?: string }
  /** A run ended. With no `message_id` it could not even be attempted, and its answer row is gone. */
  | { type: 'run_finished'; message_id: string | null; ok: boolean; error_code: string | null; conversation_id?: string }
  /** An answer row was deleted on the server: drop it. */
  | { type: 'message_removed'; message_id: string; conversation_id?: string }
  /** A new pending action to show a card for, enriched exactly like `GET /api/chat`'s `actions` —
   * never resolve a name from this event, the server already did it. For an id already on screen,
   * `resurfaced: true` with a new `surfaced_at` is that card brought back to the end of the chat. */
  | ({ type: 'confirmation'; action_id: string; conversation_id?: string; resurfaced?: true } & Omit<ChatAction, 'id' | 'status'>)
  /** Someone answered a pending action (possibly in another tab): update the card by its id. */
  | { type: 'decision'; action_id: string; status: 'approved' | 'denied'; conversation_id?: string }
  /** The gate ran an action, or it failed or expired (TER-477): update the card's status by its id. */
  | { type: 'action_status'; user_id?: string; action_id: string; status: 'executed' | 'failed' | 'expired'; error_code: string | null; conversation_id?: string }
  /** A new (or renewed) trusted-tab grant, e.g. from "Permitir sempre nesta aba" in another tab. */
  | { type: 'grant'; grant: ChatGrant; conversation_id?: string }
  /** A grant was revoked (by this or another tab, or because it expired and a reset ended it). */
  | { type: 'grant_revoked'; grant_id: string; conversation_id?: string }
  /** A new (or renewed) "Permitir sempre neste projeto" grant, e.g. from "Permitir sempre neste projeto" in another tab. */
  | { type: 'project_grant'; grant: ChatProjectGrant; conversation_id?: string }
  /** A project grant was revoked (by this or another tab, or because it expired and a reset ended it). */
  | { type: 'project_grant_revoked'; grant_id: string; conversation_id?: string }
  /** A new (or renewed) "Liberar sem prazo" grant; `conversation_id` is where it was granted. */
  | { type: 'standing_grant'; grant: ChatStandingGrant; conversation_id?: string }
  /** A standing grant was revoked. Tagged with the conversation that created it, but it applies to
   * every panel that shows it: a standing grant is not bound to a conversation. */
  | { type: 'standing_grant_revoked'; grant_id: string; conversation_id?: string }
  /** An action the server ran straight away under a trusted tab or a trusted project, with no confirmation card first. */
  | { type: 'granted_action'; action: ChatAction; conversation_id?: string }
  /** A tab asked something, the chat answered it (or failed to), or it left the tab's screen: the whole card each time. */
  | { type: 'tab_question' | 'tab_question_answered' | 'tab_question_closed'; question: TabQuestion; conversation_id?: string; resurfaced?: true }
  /** A tab shows a suggestion, or it was sent, dismissed or left the screen: the whole card each time. */
  | { type: 'tab_suggestion' | 'tab_suggestion_closed'; suggestion: TabSuggestion; conversation_id?: string }
  /** A project tab stuck on a usage limit (TER-589): the card, or its closing. */
  | { type: 'tab_limit' | 'tab_limit_closed'; notice: TabLimit; conversation_id?: string }
  /** An attachment finished extracting or failed: update the chip by its id. */
  | { type: 'attachment_status'; attachment: ChatAttachment; conversation_id?: string }
  /** A subagent of the conversation started, changed status or was interrupted (spec 2026-09-26
   * panel §5): update the panel row by its id, or prepend a new one. */
  | { type: 'subagent'; subagent: SubagentView; conversation_id?: string }
  /** "Cancelar" timed out with no confirmation that the CLI actually stopped it (spec 2026-09-26
   * panel §5.4): the row keeps whatever status it already had, this just says the click failed. */
  | { type: 'subagent_cancel_failed'; subagent_id: string; conversation_id?: string }
  /** How full the session is now, after an answer or a compaction (TER-315). */
  | { type: 'context'; tokens: number; window: number | null; conversation_id?: string }
  /** "Compactar": started, done (sizes before and after, when known) or failed (with its code). */
  | { type: 'compact'; state: 'started' | 'done' | 'failed'; tokens_before: number | null; tokens: number | null; error_code: string | null; conversation_id?: string };

/** `GET /chat/projects`: which project chats have anything going on, for a sidebar badge. */
export interface ProjectChatStatus {
  project_id: string;
  busy: boolean;
  pending_confirmations: number;
}

/** Cloud waitlist sign-up (GET /waitlist) */
export interface WaitlistEntry {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_country: string;
  phone_area: string;
  phone_number: string;
  phone: string;
  linkedin: string | null;
  github: string | null;
  locale: string;
  source: string;
  created_at: string;
  /** when the alpha invite was (last) sent from the Waitlist tab; null = not invited yet */
  invited_at: string | null;
}

/** One entry's outcome of POST /users/invite-from-waitlist. */
export type WaitlistInviteResult =
  | { id: string; error: string }
  | { id: string; user_id: string; existing: boolean; access: InviteResult['access']; mail: InviteResult['mail'] };

/** Settings → Aparelhos: a phone's pending enrolment request, awaiting approve/deny. */
export interface DeviceRequestView {
  id: string;
  device_name: string;
  model: string;
  platform: string;
  os_version: string;
  country: string | null;
  city: string | null;
  ip: string;
  /** already formatted as 'XXX-XXX' */
  verification_code: string;
  created_at: string;
  expires_at: string;
}

export type DeviceStatus = 'active' | 'revoked';

/** An enrolled phone as Settings → Aparelhos shows it. */
export interface Device {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  model: string;
  os_version: string;
  app_version: string;
  status: DeviceStatus;
  revoked_at: string | null;
  /** 'user' | 'admin' | 'pin_bruteforce' | 'review' | null */
  revoked_reason: string | null;
  pin_locked_until: string | null;
  last_seen_at: string | null;
  created_at: string;
}

/** One row of the device trail (GET /devices/events), already carrying its pt-BR sentence. */
export interface DeviceEventView {
  id: string;
  kind: string;
  text: string;
  created_at: string;
}

/** GET /devices/summary: feeds the global banner without listing every request/device. */
export interface DevicesSummary {
  pending_requests: number;
  active_devices: number;
}

export type ApiTokenScope = 'read' | 'tasks' | 'terminals' | 'memory';

/** Personal API token as the server lists it (never the secret). */
export interface ApiToken {
  id: string;
  user_id: string;
  name: string;
  scopes: ApiTokenScope[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Create response: the only time the plain token is ever returned. */
export interface CreatedApiToken {
  api_token: ApiToken;
  token: string;
  mcp_url: string | null;
}
