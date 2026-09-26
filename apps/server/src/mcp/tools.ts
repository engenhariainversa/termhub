import { z, type ZodRawShape } from 'zod';
import { TMUX_KEYS, tmuxKey } from '@termhub/agent-protocol';
import type { Action, Resource } from '../auth/permissions.js';
import type { ApiTokenScope } from '../auth/api-tokens.js';
import type { ControlContext } from '../control/context.js';
import { find, listAiAccounts, listMachines, listProjects, listTabs } from '../control/inventory.js';
import { readScreen, SCREEN_MAX_LINES, WAIT_MAX_SECONDS, waitForState } from '../control/screen.js';
import { closeTab, INPUT_MAX_CHARS, openTab, runCommand, RUN_MAX_SECONDS, sendInput, sendKey } from '../control/terminals.js';
import { linkProjectMachine, PROJECT_CWD, setProjectMachineCwd, unlinkProjectMachine } from '../control/project-links.js';
import { addSubtasks, createTask, deleteTask, listTasks, moveTask, TASK_DESCRIPTION_MAX, TASK_POSITION_MAX, TASK_TITLE_MAX, updateTask, type CreatableType, type WorkType } from '../control/tasks.js';
import { PROMPT_MAX_CHARS, startAgent } from '../control/agents.js';
import { MAX_SUBTASKS_PER_CALL } from '../db/repositories/tasks.js';
import type { TaskStatus, TaskType } from '../db/repositories/types.js';

export interface ToolDef {
  name: string;
  description: string;
  /** token scope that unlocks it */
  scope: ApiTokenScope;
  /** the user's grant it also needs */
  resource: Resource;
  action: Action;
  /** replaces the single resource:action check when the tool can work with any of several grants */
  allowedIf?(ctx: ControlContext): Promise<boolean>;
  /** how the refusal names the grant when `allowedIf` is set (after "da permissão ") */
  grantText?: string;
  input: ZodRawShape;
  run(ctx: ControlContext, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

const id = z.string().min(1).max(64);

const taskStatus = z.enum(['backlog', 'todo', 'doing', 'done']);
const taskType = z.enum(['epic', 'story', 'task', 'subtask', 'bug', 'spike']);
const creatableType = z.enum(['epic', 'story', 'task', 'bug', 'spike']);
const workType = z.enum(['story', 'task', 'bug', 'spike']);
const taskTitle = z.string().trim().min(1).max(TASK_TITLE_MAX);
const taskDescription = z.string().trim().max(TASK_DESCRIPTION_MAX).nullable();
const subtaskItems = z.array(z.object({ title: taskTitle, description: taskDescription.optional() })).min(1).max(MAX_SUBTASKS_PER_CALL);

/**
 * One place that turns raw tool arguments into validated ones — used by the route pre-check and by the SDK.
 * Only `undefined` (arguments omitted entirely) is treated as empty; `null` is a distinct, invalid value —
 * zod's object schema rejects it on its own, exactly as it would reject any other non-object.
 */
export function parseArgs(tool: ToolDef, args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const parsed = z.object(tool.input).safeParse(args === undefined ? {} : args);
  return parsed.success ? { ok: true, value: parsed.data as Record<string, unknown> } : { ok: false };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_machines',
    description: 'List your machines: id, name, subtitle (your own note about the machine, e.g. "MacBook do escritório"; null if none), type (agent/local/ssh), OS, whether it is online now, and installed tools (claude, codex, tmux, …).',
    scope: 'read', resource: 'machines', action: 'read', input: {},
    run: (ctx) => listMachines(ctx),
  },
  {
    name: 'list_projects',
    description: 'List projects: id, key (used in card numbers and URLs), name, status and the machines each one is linked to with the working directory on each. Archived ones are hidden unless include_archived; machine_id keeps only projects linked to that machine.',
    scope: 'read', resource: 'projects', action: 'read',
    input: { machine_id: id.optional(), include_archived: z.boolean().optional() },
    run: (ctx, a) => listProjects(ctx, a as { machine_id?: string; include_archived?: boolean }),
  },
  {
    name: 'list_tabs',
    description: 'List the tabs of a project (or of every project of a machine): whether the tmux session is alive, what the tool in it is doing (working, waiting_input, waiting_permission, idle, error), its pending question, and the task linked to it.',
    scope: 'read', resource: 'terminals', action: 'read',
    input: { project_id: id.optional(), machine_id: id.optional() },
    run: (ctx, a) => listTabs(ctx, a as { project_id?: string; machine_id?: string }),
  },
  {
    name: 'list_ai_accounts',
    description: 'List the AI CLI accounts (Claude, Codex, Gemini, Antigravity) logged in on your machines: id, provider, label, machine.',
    scope: 'read', resource: 'ai_accounts', action: 'read',
    input: { machine_id: id.optional() },
    run: (ctx, a) => listAiAccounts(ctx, a as { machine_id?: string }),
  },
  {
    name: 'find',
    description: 'Resolve names to ids in one call — e.g. "MacBook Pro M4", "Hub Community", "pedrogoiania", "TER-12" — across machines, projects (name or key), AI accounts and cards (exact ref only) (case- and accent-insensitive, best matches first).',
    // find narrows the kinds it searches to what the user can read, so any one of them is enough
    scope: 'read', resource: 'projects', action: 'read',
    allowedIf: async (ctx) => (await Promise.all([ctx.can('machines', 'read'), ctx.can('projects', 'read'), ctx.can('tasks', 'read'), ctx.can('ai_accounts', 'read')])).some(Boolean),
    grantText: 'de leitura de máquinas, projetos, tarefas ou contas de IA',
    input: { query: z.string().min(1).max(200), kinds: z.array(z.enum(['machine', 'project', 'ai_account', 'task'])).optional() },
    run: (ctx, a) => find(ctx, a as { query: string; kinds?: ('machine' | 'project' | 'ai_account' | 'task')[] }),
  },
  {
    name: 'read_screen',
    description: `Read the last lines of a terminal tab (default 200, max ${SCREEN_MAX_LINES}). Text between ⟦ and ⟧ is dimmed on screen — usually Claude Code's suggested next prompt: nobody typed it, so never report it as an unsent message and never press Enter because of it (you may offer to send it). styled: false means the machine's agent is too old to mark dimmed text, so text after ❯ may be a suggestion too.`,
    scope: 'read', resource: 'terminals', action: 'read',
    input: { tab_id: id, lines: z.number().int().min(1).max(SCREEN_MAX_LINES).optional() },
    run: (ctx, a) => readScreen(ctx, a as { tab_id: string; lines?: number }),
  },
  {
    name: 'wait_for_state',
    description: `Wait until the tool in a tab stops working (it finished, asks something, or needs a permission), up to timeout_seconds (default 60, max ${WAIT_MAX_SECONDS}). A timeout is not an error: call again to keep waiting.`,
    scope: 'read', resource: 'terminals', action: 'read',
    input: { tab_id: id, timeout_seconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional() },
    run: (ctx, a, signal) => waitForState(ctx, a as { tab_id: string; timeout_seconds?: number }, signal),
  },
  {
    name: 'open_tab',
    description: 'Open a terminal tab in a project and start its tmux session detached, so it keeps running with no browser attached. machine_id picks which linked machine; it is required when the project is linked to more than one (list_projects shows them).',
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { project_id: id, machine_id: id.optional(), name: z.string().trim().min(1).max(60).optional() },
    run: (ctx, a) => openTab(ctx, a as { project_id: string; machine_id?: string; name?: string }),
  },
  {
    name: 'send_input',
    description: `Type text into a terminal tab (max ${INPUT_MAX_CHARS} chars) and press Enter unless enter is false. A tab waiting for a permission needs answering_permission: true.`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, text: z.string().max(INPUT_MAX_CHARS), enter: z.boolean().optional(), answering_permission: z.boolean().optional() },
    run: (ctx, a) => sendInput(ctx, a as { tab_id: string; text: string; enter?: boolean; answering_permission?: boolean }),
  },
  {
    name: 'send_key',
    description: `Press one key in a terminal tab: ${TMUX_KEYS.join(', ')}.`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, key: tmuxKey },
    run: (ctx, a) => sendKey(ctx, a as { tab_id: string; key: (typeof TMUX_KEYS)[number] }),
  },
  {
    name: 'run_command',
    description: `Type a command in a terminal tab, press Enter, wait for the tab to settle (default 30 s, max ${RUN_MAX_SECONDS}) and return the screen. There is no exit code: it is an interactive session. A aba não pode estar esperando uma permissão (waiting_permission) — responda com send_input ou send_key antes de rodar um comando.`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, command: z.string().min(1).max(INPUT_MAX_CHARS), timeout_seconds: z.number().int().min(1).max(RUN_MAX_SECONDS).optional(), lines: z.number().int().min(1).max(SCREEN_MAX_LINES).optional() },
    run: (ctx, a, signal) => runCommand(ctx, a as { tab_id: string; command: string; timeout_seconds?: number; lines?: number }, signal),
  },
  {
    name: 'close_tab',
    description:
      'Kill a terminal tab’s tmux session and remove the tab. A personal token closes only the tabs it opened, unless force is true; in the chat, the user’s confirmation covers any of their tabs (no force needed).',
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { tab_id: id, force: z.boolean().optional() },
    run: (ctx, a) => closeTab(ctx, a as { tab_id: string; force?: boolean }),
  },
  {
    name: 'link_project_machine',
    description:
      'Link a project to one more of your machines, with the working directory its terminals open in there (cwd: absolute path, ~ allowed). The directory is checked on the machine (create_dir: true creates it empty) and the resolved path is stored; git_repo says whether it holds a .git folder. Fails if the machine is already linked (use set_project_machine_cwd). list_projects shows the link at once.',
    scope: 'terminals', resource: 'projects', action: 'create',
    input: { project_id: id, machine_id: id, cwd: PROJECT_CWD, create_dir: z.boolean().optional() },
    run: (ctx, a) => linkProjectMachine(ctx, a as { project_id: string; machine_id: string; cwd: string; create_dir?: boolean }),
  },
  {
    name: 'set_project_machine_cwd',
    description:
      "Change the working directory of an existing project ↔ machine link (same checks as link_project_machine). Tabs already running keep their directory; a tab started or restarted after this opens in the new one.",
    scope: 'terminals', resource: 'projects', action: 'update',
    input: { project_id: id, machine_id: id, cwd: PROJECT_CWD, create_dir: z.boolean().optional() },
    run: (ctx, a) => setProjectMachineCwd(ctx, a as { project_id: string; machine_id: string; cwd: string; create_dir?: boolean }),
  },
  {
    name: 'unlink_project_machine',
    description:
      "Remove a machine from a project. If the project has tabs open on that machine they are closed (tmux sessions killed), which needs confirm: true; without it the answer says which tabs would close and nothing happens.",
    scope: 'terminals', resource: 'projects', action: 'delete',
    input: { project_id: id, machine_id: id, confirm: z.boolean().optional() },
    run: (ctx, a) => unlinkProjectMachine(ctx, a as { project_id: string; machine_id: string; confirm?: boolean }),
  },
  {
    name: 'start_agent',
    description: `Open a tab in a project and start Claude Code (account provider claude) or Codex (chatgpt) there under the chosen account, with prompt (max ${PROMPT_MAX_CHARS} chars) as its first message; the session stays interactive and visible in the app. With task_id (needs the tasks:update permission) the task is linked to the tab and moved to the project's agent column (a project setting; default the first doing column) unless it already sits in a doing column; a subtask is marked doing. The prompt cannot start with "-" or contain control characters other than newlines. Then use wait_for_state / read_screen / send_input to follow and answer it. Gemini and Antigravity accounts are not supported yet. machine_id picks the linked machine (required when the project has several).`,
    scope: 'terminals', resource: 'terminals', action: 'write',
    input: { project_id: id, machine_id: id.optional(), account_id: id, prompt: z.string().min(1).max(PROMPT_MAX_CHARS), task_id: id.optional(), tab_name: z.string().trim().min(1).max(60).optional() },
    run: (ctx, a) => startAgent(ctx, a as { project_id: string; machine_id?: string; account_id: string; prompt: string; task_id?: string; tab_name?: string }),
  },
  {
    name: 'list_tasks',
    description:
      "List a project's cards as the board and backlog show them. Epics group the work; stories, tasks, bugs and spikes are the work; subtasks come nested as a checklist. Each card has a type, a ref (TER-12), its url, its epic_id and its board column ({ id, name, category } — the board shows columns by the user's names, the category todo/doing/done is what they mean; backlog cards have no column). The result also lists the project's columns in order. status, type and epic_id filter the top-level cards.",
    scope: 'tasks', resource: 'tasks', action: 'read',
    input: { project_id: id, status: taskStatus.optional(), type: taskType.optional(), epic_id: id.optional() },
    run: (ctx, a) => listTasks(ctx, a as { project_id: string; status?: TaskStatus; type?: TaskType; epic_id?: string }),
  },
  {
    name: 'create_task',
    description: `Create a card at the top of a column (default the first todo column; an epic defaults to the backlog), optionally with its subtasks (max ${MAX_SUBTASKS_PER_CALL}) in one transaction. type: epic, story, task (default), bug or spike — only stories and tasks take subtasks. epic_id: the epic it belongs to (default: the project's default epic). Returns the card with its ref and url, and the board URL.`,
    scope: 'tasks', resource: 'tasks', action: 'create',
    input: { project_id: id, title: taskTitle, description: taskDescription.optional(), status: taskStatus.optional(), type: creatableType.optional(), epic_id: id.optional(), subtasks: subtaskItems.optional() },
    run: (ctx, a) =>
      createTask(ctx, a as { project_id: string; title: string; description?: string | null; status?: TaskStatus; type?: CreatableType; epic_id?: string; subtasks?: { title: string; description?: string | null }[] }),
  },
  {
    name: 'add_subtasks',
    description: `Append subtasks (max ${MAX_SUBTASKS_PER_CALL} per call) to a top-level task. One level only: a subtask cannot have subtasks.`,
    scope: 'tasks', resource: 'tasks', action: 'create',
    input: { task_id: id, subtasks: subtaskItems },
    run: (ctx, a) => addSubtasks(ctx, a as { task_id: string; subtasks: { title: string; description?: string | null }[] }),
  },
  {
    name: 'update_task',
    description:
      'Change the title, description (null clears it), status, type (story, task, bug or spike; a card with subtasks stays a story or task) or epic_id of a card, or the title/description/status of a subtask. Changing the status of a top-level card moves it to the top of the first column of that category (backlog: of its epic backlog).',
    scope: 'tasks', resource: 'tasks', action: 'update',
    input: { task_id: id, title: taskTitle.optional(), description: taskDescription.optional(), status: taskStatus.optional(), type: workType.optional(), epic_id: id.optional() },
    run: (ctx, a) => updateTask(ctx, a as { task_id: string; title?: string; description?: string | null; status?: TaskStatus; type?: WorkType; epic_id?: string }),
  },
  {
    name: 'move_task',
    description: `Move a top-level card to a board column (column_id, from list_tasks) or to a status (backlog, or the first column of todo/doing/done) — exactly one of the two — at a position (0 = top, default; max ${TASK_POSITION_MAX}, clamped). Subtasks have no column: change their status with update_task.`,
    scope: 'tasks', resource: 'tasks', action: 'update',
    input: { task_id: id, column_id: id.optional(), status: taskStatus.optional(), position: z.number().int().min(0).max(TASK_POSITION_MAX).optional() },
    run: (ctx, a) => moveTask(ctx, a as { task_id: string; column_id?: string; status?: TaskStatus; position?: number }),
  },
  {
    name: 'delete_task',
    description: 'Delete a task and all its subtasks (or one subtask). Requires confirm: true; without it the answer says what would be deleted and nothing happens.',
    scope: 'tasks', resource: 'tasks', action: 'delete',
    input: { task_id: id, confirm: z.boolean().optional() },
    run: (ctx, a) => deleteTask(ctx, a as { task_id: string; confirm?: boolean }),
  },
];

/** Tools this token may call: its scope includes the tool's, and the user holds the tool's grant. */
export async function allowedTools(ctx: ControlContext, scopes: readonly ApiTokenScope[]): Promise<ToolDef[]> {
  const out: ToolDef[] = [];
  for (const t of TOOLS) if (scopes.includes(t.scope) && (await (t.allowedIf ? t.allowedIf(ctx) : ctx.can(t.resource, t.action)))) out.push(t);
  return out;
}

/** pt-BR answer for a tools/call this token may not make (spec §6: a tool error, not a JSON-RPC error). */
export function refusalMessage(name: string): string {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `Ferramenta desconhecida: ${name.slice(0, 64)}`;
  return `Este token não pode usar a ferramenta ${name}: ela precisa do escopo \`${tool.scope}\` e da permissão ${tool.grantText ?? `${tool.resource}:${tool.action}`} na sua role`;
}
