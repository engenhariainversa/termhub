import type {
  User as PrismaUser,
  Session as PrismaSession,
  Machine as PrismaMachine,
  Project as PrismaProject,
  ProjectMachine as PrismaProjectMachine,
  Tab as PrismaTab,
  TabEvent as PrismaTabEvent,
  Task as PrismaTask,
  TaskColumn as PrismaTaskColumn,
  Note as PrismaNote,
  Ticket as PrismaTicket,
} from '../../generated/prisma/client.js';
import { publicId } from '../../public/public-id.js';

export type UserRole = 'owner' | 'member';
export type MachineType = 'local' | 'ssh' | 'agent';
export type ProjectStatus = 'active' | 'paused' | 'archived';
export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'done';
/** Kind of card (spec 2026-09-24 §3): epics group work, subtasks are a checklist inside a story or task. */
export type TaskType = 'epic' | 'story' | 'task' | 'subtask' | 'bug' | 'spike';
/** What a board column means to the system; the backlog is not a column. */
export type ColumnCategory = Exclude<TaskStatus, 'backlog'>;
export type TabKind = 'terminal' | 'simulator';
/** Monitor state of the tool running in a tab (see monitor/state.ts). */
export type TabState = 'working' | 'waiting_input' | 'waiting_permission' | 'idle' | 'error';
/** What a working agent is doing, from the tool it is about to call (monitor/activity.ts). */
export type TabActivity = 'coding' | 'reading' | 'researching' | 'planning' | 'terminal' | 'working';
export const TAB_ACTIVITIES: readonly TabActivity[] = ['coding', 'reading', 'researching', 'planning', 'terminal', 'working'];

/**
 * Tipos expostos pela camada de dados (snake_case, datas em ISO string).
 * O restante do app nunca importa o Prisma diretamente.
 */
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  /** the address of this person's public city (/city/@nickname); null = no city */
  nickname: string | null;
  /** the short link termhub created for the city through TypeToAccess; null = none yet */
  city_short_url_partner: string | null;
  /** a short link the person pasted instead; the effective one is custom ?? partner */
  city_short_url_custom: string | null;
  password_hash: string | null;
  google_id: string | null;
  /** DEPRECATED legacy flag; use role_id */
  role: UserRole;
  role_id: string | null;
  /** set when the user was created by an invite */
  invited_at: string | null;
  /** last successful sign-in; null = never signed in */
  last_login_at: string | null;
  /** store-review mode: while in the future, this account's device requests are auto-approved */
  review_enabled_until: string | null;
  /** the admin who last set review_enabled_until */
  review_enabled_by: string | null;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export interface Machine {
  id: string;
  name: string;
  /** optional line under the name, trimmed, ≤ 80 chars; private: the public city never carries it */
  subtitle: string | null;
  host: string | null;
  ssh_user: string | null;
  ssh_port: number;
  type: MachineType;
  os: string | null;
  capabilities: string[];
  checked_at: string | null;
  /** last agent version reported on hello (null for local/ssh, or an agent that never connected) */
  agent_version: string | null;
  /** last time the agent connected/heartbeat (null for local/ssh) */
  agent_last_seen_at: string | null;
  /** newer agent versions are installed automatically while the machine has no open terminal */
  agent_auto_update: boolean;
  /** swap a tab's Claude to another account of this machine by itself on a usage limit (opt-in) */
  claude_auto_swap: boolean;
  /** the user's own computer: the web app shows it only in the browser that added it */
  is_local: boolean;
  /** null = orphan (only visible to admins viewing "all") */
  owner_id: string | null;
  /** owner's display name (list/detail convenience for the "all" view) */
  owner_name: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  /** null = orphan (owner deleted), visible only to admins viewing "all" */
  owner_id: string | null;
  /** short key used in URLs and card numbers (TERMHUB); unique, immutable */
  key: string;
  next_task_number: number;
  name: string;
  status: ProjectStatus;
  description: string | null;
  /** published: this project is a building on its owner's public city (/city/@nickname) */
  is_public: boolean;
  /**
   * The project's building id on its owner's public city (`publicId('project', id)`): one-way, so
   * carrying it to the person who already reads the real id costs nothing, and the share button
   * builds the building's link from it. Never part of the public payload (public/city.ts).
   */
  public_id: string;
  /** column a card moves to when an agent starts on it; null = automatic (first `doing` column) */
  agent_column_id: string | null;
  last_terminal_at: string | null;
  created_at: string;
}

/** A project's link to one machine: where its terminals run there. */
export interface ProjectMachine {
  id: string;
  project_id: string;
  machine_id: string;
  cwd: string;
  position: number;
  created_at: string;
}

export interface Tab {
  id: string;
  project_id: string;
  /** the machine this tab's tmux session runs on */
  machine_id: string;
  name: string;
  kind: TabKind;
  tmux_session: string | null;
  simulator_udid: string | null;
  /** API token that opened this tab through /mcp (null: opened in the browser). */
  created_by_token_id: string | null;
  position: number;
  /** monitor: last reported state; null = never reported */
  state: TabState | null;
  /** the tool's pending question / notification (never terminal content) */
  state_text: string | null;
  state_tool: string | null;
  state_at: string | null;
  /** when the tab was last looked at while needing you; null or before state_at = still needs you */
  state_seen_at: string | null;
  /** monitor: what a working agent is doing; null = not working or never reported */
  activity: TabActivity | null;
  /** Claude Code's spinner verb that came with `activity` ("Moonwalking"); cleared with it */
  activity_verb: string | null;
  /** Claude Code session last reported by a hook of this tab (uuid); used to resume it under
   *  another account (spec 2026-09-26 account swap). null = never reported. */
  agent_session_id: string | null;
  /** the session's transcript on the machine, alongside agent_session_id */
  agent_transcript_path: string | null;
  /** the AI account termhub started this tab's agent with (start_agent or a swap); null = unknown */
  ai_account_id: string | null;
  /** when the tab's Claude stopped on a usage limit (StopFailure rate_limit); cleared when it runs again */
  rate_limited_at: string | null;
  created_at: string;
}

export interface TabEvent {
  id: string;
  tab_id: string;
  kind: TabState;
  tool: string;
  text: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  /** epic, story, task, subtask, bug or spike (spec 2026-09-24 §3) */
  type: TaskType;
  /** sequential per project, set by the database trigger; never reused */
  number: number;
  /** "TER-12": project key + number; the card opens at /project/<ref> */
  ref: string;
  title: string;
  description: string | null;
  /** backlog = in the backlog; otherwise the category of its column */
  status: TaskStatus;
  position: number;
  /** Ticket externo: { provider, id, identifier, url, state, meta } */
  external_ref: unknown | null;
  external_key: string | null;
  tab_id: string | null;
  /** Parent story/task for a subtask; null for every other card. */
  parent_id: string | null;
  /** The epic of a story/task/bug/spike; null on epics and subtasks. */
  epic_id: string | null;
  /** Board column; null in the backlog and on subtasks. */
  column_id: string | null;
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

/** A top-level task as the list endpoint returns it. */
export interface TaskWithSubtasks extends Task {
  subtasks: Task[];
  subtask_counts: { done: number; total: number };
}

/** Board columns that count as "the project's work" on the office floor; the backlog does not. */
export interface OfficeTaskCounts {
  todo: number;
  doing: number;
  done: number;
}

/** The `doing` task bound to a tab. `total = 0` means it has no subtasks: a title, no bar. */
export interface OfficeTabProgress {
  task_id: string;
  title: string;
  done: number;
  total: number;
}

export interface OfficeProgress {
  /** by project id; a project with no todo/doing/done task has no entry */
  counts: Record<string, OfficeTaskCounts>;
  /** by tab id */
  byTab: Record<string, OfficeTabProgress>;
}

export interface Ticket {
  id: string;
  project_id: string;
  integration_id: string;
  provider: 'github' | 'linear' | 'jira';
  external_key: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: string;
  status: TaskStatus;
  meta: Record<string, unknown>;
  task_id: string | null;
  synced_at: string;
  created_at: string;
}

export interface Note {
  id: string;
  project_id: string;
  content: string;
  updated_at: string;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const mapUser = (u: PrismaUser): User => ({
  id: u.id,
  email: u.email,
  name: u.name,
  avatar_url: u.avatarUrl,
  nickname: u.nickname,
  city_short_url_partner: u.cityShortUrlPartner,
  city_short_url_custom: u.cityShortUrlCustom,
  password_hash: u.passwordHash,
  google_id: u.googleId,
  role: u.role,
  role_id: u.roleId,
  invited_at: u.invitedAt?.toISOString() ?? null,
  last_login_at: u.lastLoginAt?.toISOString() ?? null,
  review_enabled_until: u.reviewEnabledUntil?.toISOString() ?? null,
  review_enabled_by: u.reviewEnabledBy,
  created_at: u.createdAt.toISOString(),
});

export const mapSession = (s: PrismaSession): Session => ({
  id: s.id,
  user_id: s.userId,
  token_hash: s.tokenHash,
  expires_at: s.expiresAt.toISOString(),
  created_at: s.createdAt.toISOString(),
});

export const mapMachine = (m: PrismaMachine & { owner?: { name: string } | null }): Machine => ({
  id: m.id,
  name: m.name,
  subtitle: m.subtitle ?? null,
  host: m.host,
  ssh_user: m.sshUser,
  ssh_port: m.sshPort,
  type: m.type,
  os: m.os,
  capabilities: Array.isArray(m.capabilities) ? (m.capabilities as string[]) : [],
  checked_at: iso(m.checkedAt),
  agent_version: m.agentVersion ?? null,
  agent_last_seen_at: m.agentLastSeenAt?.toISOString() ?? null,
  agent_auto_update: m.agentAutoUpdate,
  claude_auto_swap: m.claudeAutoSwap,
  is_local: m.isLocal,
  owner_id: m.ownerId,
  owner_name: m.owner?.name ?? null,
  created_at: m.createdAt.toISOString(),
});

export const mapProject = (p: PrismaProject): Project => ({
  id: p.id,
  owner_id: p.ownerId,
  key: p.key,
  next_task_number: p.nextTaskNumber,
  name: p.name,
  status: p.status,
  description: p.description,
  is_public: p.isPublic,
  public_id: publicId('project', p.id),
  agent_column_id: p.agentColumnId,
  last_terminal_at: iso(p.lastTerminalAt),
  created_at: p.createdAt.toISOString(),
});

export const mapProjectMachine = (l: PrismaProjectMachine): ProjectMachine => ({
  id: l.id,
  project_id: l.projectId,
  machine_id: l.machineId,
  cwd: l.cwd,
  position: l.position,
  created_at: l.createdAt.toISOString(),
});

export const mapTab = (t: PrismaTab): Tab => ({
  id: t.id,
  project_id: t.projectId,
  machine_id: t.machineId,
  name: t.name,
  kind: t.kind,
  tmux_session: t.tmuxSession,
  simulator_udid: t.simulatorUdid,
  created_by_token_id: t.createdByTokenId,
  position: t.position,
  state: t.state,
  state_text: t.stateText,
  state_tool: t.stateTool,
  state_at: iso(t.stateAt),
  state_seen_at: iso(t.stateSeenAt),
  activity: t.activity,
  activity_verb: t.activityVerb,
  agent_session_id: t.agentSessionId,
  agent_transcript_path: t.agentTranscriptPath,
  ai_account_id: t.aiAccountId,
  rate_limited_at: iso(t.rateLimitedAt),
  created_at: t.createdAt.toISOString(),
});

export const mapTabEvent = (e: PrismaTabEvent): TabEvent => ({
  id: e.id,
  tab_id: e.tabId,
  kind: e.kind,
  tool: e.tool,
  text: e.text,
  meta: (e.meta ?? {}) as Record<string, unknown>,
  created_at: e.createdAt.toISOString(),
});

/** `key`: the project's key, for `ref` (TasksRepository loads it with every task). */
export const mapTask = (t: PrismaTask, key: string): Task => ({
  id: t.id,
  project_id: t.projectId,
  type: t.type,
  number: t.number,
  ref: `${key}-${t.number}`,
  title: t.title,
  description: t.description,
  status: t.status,
  position: t.position,
  external_ref: t.externalRef ?? null,
  external_key: t.externalKey,
  tab_id: t.tabId,
  parent_id: t.parentId,
  epic_id: t.epicId,
  column_id: t.columnId,
  created_at: t.createdAt.toISOString(),
  updated_at: t.updatedAt.toISOString(),
});

export const mapTaskColumn = (c: PrismaTaskColumn): TaskColumn => ({
  id: c.id,
  project_id: c.projectId,
  name: c.name,
  category: c.category as ColumnCategory,
  position: c.position,
  created_at: c.createdAt.toISOString(),
});

export const mapTicket = (t: PrismaTicket): Ticket => ({
  id: t.id,
  project_id: t.projectId,
  integration_id: t.integrationId,
  provider: t.provider,
  external_key: t.externalKey,
  identifier: t.identifier,
  title: t.title,
  description: t.description,
  url: t.url,
  state: t.state,
  status: t.status,
  meta: (t.meta ?? {}) as Record<string, unknown>,
  task_id: t.taskId,
  synced_at: t.syncedAt.toISOString(),
  created_at: t.createdAt.toISOString(),
});

export const mapNote = (n: PrismaNote): Note => ({
  id: n.id,
  project_id: n.projectId,
  content: n.content,
  updated_at: n.updatedAt.toISOString(),
});

/** Remove campos sensíveis antes de enviar ao cliente. */
export type PublicUser = Omit<User, 'password_hash' | 'google_id' | 'city_short_url_partner' | 'city_short_url_custom' | 'review_enabled_by'> & { has_password: boolean; has_google: boolean };

export function toPublicUser(u: User): PublicUser {
  // the city short links are served by /auth/me/city-link and the public snapshot, not the account payload;
  // who switched store-review mode on is admin information, added back only by the user-admin routes
  const { password_hash, google_id, city_short_url_partner, city_short_url_custom, review_enabled_by, ...rest } = u;
  return { ...rest, has_password: !!password_hash, has_google: !!google_id };
}

export type AiProvider = 'claude' | 'chatgpt' | 'gemini' | 'antigravity';

export interface AiAccount {
  id: string;
  provider: AiProvider;
  label: string;
  machine_id: string;
  config_dir: string | null;
  created_at: string;
}

export function mapAiAccount(a: { id: string; provider: AiProvider; label: string; machineId: string; configDir: string | null; createdAt: Date }): AiAccount {
  return { id: a.id, provider: a.provider, label: a.label, machine_id: a.machineId, config_dir: a.configDir, created_at: a.createdAt.toISOString() };
}
