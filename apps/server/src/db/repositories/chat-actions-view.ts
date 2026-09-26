import type { Repositories } from './index.js';
import type { ChatAction, ChatActionClass, ChatActionStatus } from './chat-actions.js';
import type { ChatGrant, ChatGrantWithConversation } from './chat-grants.js';
import type { Task } from './types.js';

/**
 * The trimmed, human-facing shape of a chat action: what the card needs to read like a sentence
 * about the real world ("digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook
 * m3"), never a tool name and three ids. Shared verbatim by `GET /api/chat`'s trail and the
 * `confirmation` bus event, so the browser never resolves a name or guesses a sentence itself.
 */
export interface ChatActionCard {
  id: string;
  tool: string;
  args: unknown;
  class: ChatActionClass;
  status: ChatActionStatus;
  machine_id: string | null;
  project_id: string | null;
  tab_id: string | null;
  grant_id: string | null;
  summary: string;
  created_at: string;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The `task_id` an action's args name, if any — the four task tools below all require one, but it
 * is never copied onto the row itself (unlike machine/project/tab_id, which the gate's `targetOf`
 * does store): the sentence has to read it straight from `args`. */
const taskIdOf = (action: ChatAction): string => asString((action.args as Record<string, unknown> | null)?.task_id);

/**
 * What the sentence says was proposed, before naming where. Unknown tools (the gate classifies
 * anything it does not recognise as irreversible rather than silently allowing it) still read as a
 * sentence, naming the tool rather than showing it bare.
 *
 * A task tool (`add_subtasks`/`update_task`/`move_task`/`delete_task`) names the task by its title —
 * never its bare id — resolved from `task`, which the caller has already looked up **within the
 * viewing user's own scope** (see `describeActions`). `delete_task` is in the irreversible class, so
 * this card is the only thing the user sees before authorising it: approving a deletion by id alone
 * would be approving blind. When the task does not resolve — deleted, or (before the fix below)
 * belonging to someone else entirely — that is said plainly rather than falling back to a bare id,
 * since the absence is itself useful information for deciding, and the two causes are deliberately
 * indistinguishable from here: this view must never confirm that a foreign id exists at all.
 */
/** A task as the sentence names it: its ref, then its title — `TER-12 "Corrigir o build"`. */
const named = (task: Task) => `${task.ref} "${task.title}"`;

/** The only tools whose row carries both a project_id and a machine_id where the machine is the key
 * fact being approved (which machine is being linked/re-pointed/unlinked) — for these three alone,
 * `describeActions` resolves and names both, rather than letting the project_id branch win the way it
 * does for every other project-scoped tool (open_tab, create_task, start_agent), where a project has
 * no single machine and naming one would be misleading. */
const MACHINE_LINK_TOOLS = new Set(['link_project_machine', 'set_project_machine_cwd', 'unlink_project_machine']);

function verbPhrase(action: ChatAction, task: Task | undefined): string {
  const args = (action.args ?? {}) as Record<string, unknown>;
  switch (action.tool) {
    case 'send_input':
      return `digitar \`${asString(args.text)}\``;
    case 'run_command':
      return `rodar o comando \`${asString(args.command)}\``;
    case 'send_key':
      return `enviar a tecla \`${asString(args.key)}\``;
    case 'open_tab':
      return 'abrir uma aba nova';
    case 'close_tab':
      return 'fechar a aba';
    case 'link_project_machine':
      return `vincular a pasta \`${asString(args.cwd)}\`${args.create_dir === true ? ' (criando a pasta)' : ''}`;
    case 'set_project_machine_cwd':
      return `trocar a pasta para \`${asString(args.cwd)}\`${args.create_dir === true ? ' (criando a pasta)' : ''}`;
    case 'unlink_project_machine':
      return args.confirm === true ? 'desvincular a máquina (fechando as abas do projeto nela, se houver)' : 'desvincular a máquina';
    case 'start_agent':
      return `iniciar um agente com o prompt "${asString(args.prompt)}"`;
    case 'create_task':
      return `criar a tarefa "${asString(args.title)}"`;
    case 'add_subtasks':
      return task ? `adicionar subtarefas à tarefa ${named(task)}` : 'adicionar subtarefas a uma tarefa que não existe mais';
    case 'update_task':
      return task ? `atualizar a tarefa ${named(task)}` : 'atualizar uma tarefa que não existe mais';
    case 'move_task':
      return task ? `mover a tarefa ${named(task)}` : 'mover uma tarefa que não existe mais';
    case 'delete_task':
      return task ? `apagar a tarefa ${named(task)}` : 'apagar uma tarefa que não existe mais';
    default:
      return `usar a ferramenta ${action.tool}`;
  }
}

/**
 * What the sentence resolved for "where" — everything already scoped to the viewing user. `missing`
 * names which *primary* reference (the one the action itself names — a tab, or a project when there
 * is no tab, or a machine when there is neither) failed to resolve inside that scope: not found and
 * "found but belongs to someone else" are deliberately the same case, exactly like `missing` for a
 * task above, so this view never confirms that a foreign id exists. `project`/`machine` derived
 * *from* a resolved primary reference (a tab's project, a tab's machine) are never flagged this
 * way if they happen to be absent — that can only be a benign, momentary inconsistency between two
 * reads of an owner-scoped chain that is otherwise guaranteed consistent, not a scope violation, and
 * it degrades to simply omitting that part of the sentence.
 */
interface Location {
  tab?: string;
  project?: string;
  machine?: string;
  missing?: 'tab' | 'project' | 'machine';
  /** close_tab only: who opened the tab being closed, in parentheses right after its name — set by
   * `describeActions` from the tab's `created_by_token_id`, never resolved here (see there for why:
   * it takes an owner-scoped `apiTokens.listByUser` lookup that `describeActions` has a repos handle
   * for and this — `targetPhrase`, building `Location` — does not). */
  tabOrigin?: string;
}

/** Where the sentence says it happens, from the resolved names — never from raw ids. Reads
 * "na aba X do projeto Y, no Z" when all three are known, degrading gracefully as fewer are; says so
 * plainly, in pt-BR, when the one reference the action actually named did not resolve. */
function targetPhrase(loc: Location): string {
  if (loc.missing === 'tab') return 'numa aba que não existe mais';
  if (loc.missing === 'project') return 'num projeto que não existe mais';
  if (loc.missing === 'machine') return 'numa máquina que não existe mais';
  const parts: string[] = [];
  // close_tab's own verb already says "fechar a aba" — the tab's own origin (only ever set for
  // close_tab) is appended right after its bare name, not after another "na aba", or the sentence
  // would say "aba" twice ("fechar a aba na aba X"). Every other tool keeps "na aba X".
  if (loc.tab) parts.push(loc.tabOrigin ? `${loc.tab} (${loc.tabOrigin})` : `na aba ${loc.tab}`);
  if (loc.project) parts.push(`${loc.tab ? 'do' : 'no'} projeto ${loc.project}`);
  const place = parts.join(' ');
  if (!loc.machine) return place;
  return place ? `${place}, no ${loc.machine}` : `no ${loc.machine}`;
}

function summarize(action: ChatAction, task: Task | undefined, loc: Location): string {
  const verb = verbPhrase(action, task);
  const where = targetPhrase(loc);
  return where ? `${verb} ${where}` : verb;
}

const toCard = (action: ChatAction, summary: string): ChatActionCard => ({
  id: action.id,
  tool: action.tool,
  args: action.args,
  class: action.class,
  status: action.status,
  machine_id: action.machine_id,
  project_id: action.project_id,
  tab_id: action.tab_id,
  grant_id: action.grant_id,
  summary,
  created_at: action.created_at,
});

/**
 * Enriches a batch of chat actions with the sentence their card shows, resolving task/machine/project/
 * tab names in four batched lookups total — never one lookup per action, and never one per id chain
 * either.
 *
 * Every one of those lookups is scoped to `ownerId`, which is why it is a required parameter rather
 * than optional: this function renders a card **for one specific user**, and must only ever resolve
 * names that user can see. Without the scope, a proposed action carrying another user's task/tab/
 * project/machine id would have named their title/name on this user's screen before the action ever
 * executed and failed — a live cross-tenant disclosure, since the row is recorded (and this view runs)
 * before the tool call that would eventually 404 on it. `findByIdsForOwner` on each repository makes
 * "no owner filter" impossible to write here by accident: another owner's row is simply absent from
 * the batch, exactly like a row that does not exist at all (`targetPhrase`'s `missing` case).
 *
 * A row that only carries a tab_id (most terminal tools) still gets its project's and machine's
 * names: the tab is looked up first, and its project_id and its own machine_id feed the next two
 * batches — themselves also owner-scoped, though by this point that is redundant with the tab's own
 * scoping (a tab that resolved under `ownerId` can only belong to a project and machine that also
 * belong to `ownerId`, by construction of the join). A task tool (whose args carry a task_id the gate
 * never copies onto the row) is resolved the same way: the task is looked up alongside the tabs, and
 * its project_id feeds the same project batch a tab's would — but a task/project has no single
 * machine any more (a project can link to 0–N), so only a tab's action names one.
 */
export async function describeActions(repos: Repositories, actions: ChatAction[], ownerId: string): Promise<ChatActionCard[]> {
  const tabIds = [...new Set(actions.map((a) => a.tab_id).filter((v): v is string => v !== null))];
  const taskIds = [...new Set(actions.map(taskIdOf).filter((v) => v.length > 0))];
  const [tabs, tasks] = await Promise.all([
    tabIds.length ? repos.tabs.findByIdsForOwner(tabIds, ownerId) : [],
    taskIds.length ? repos.tasks.findByIdsForOwner(taskIds, ownerId) : [],
  ]);
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const projectIds = new Set<string>();
  for (const a of actions) if (a.project_id) projectIds.add(a.project_id);
  for (const t of tabs) projectIds.add(t.project_id);
  for (const t of tasks) projectIds.add(t.project_id);
  const projects = projectIds.size ? await repos.projects.findByIdsForOwner([...projectIds], ownerId) : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const machineIds = new Set<string>();
  for (const a of actions) if (a.machine_id) machineIds.add(a.machine_id);
  for (const t of tabs) machineIds.add(t.machine_id);
  const machines = machineIds.size ? await repos.machines.findByIdsForOwner([...machineIds], ownerId) : [];
  const machineById = new Map(machines.map((m) => [m.id, m]));

  // close_tab only: who opened the tab decides what the card says (TER-184), so the one confirmation
  // the gate now asks for (a gated token may close any of the user's tabs after this single "yes") is
  // informed. This is the only extra lookup in this function, and only when a close_tab card's tab
  // actually resolved *and* named a token — never for a browser-opened tab (`created_by_token_id`
  // null needs no lookup to say "aberta por você") and never at all when no close_tab card qualifies,
  // so every other caller (send_input, run_command, the task tools, ...) never touches `apiTokens`.
  // Tokens are revoked, never deleted, so an old concierge token still resolves here.
  const needsTokenLookup = actions.some((a) => a.tool === 'close_tab' && a.tab_id && tabById.get(a.tab_id)?.created_by_token_id != null);
  let chatTokenIds: Set<string> | undefined;
  if (needsTokenLookup) {
    const tokens = await repos.apiTokens.listByUser(ownerId);
    chatTokenIds = new Set(tokens.filter((t) => t.gated).map((t) => t.id));
  }

  return actions.map((action) => {
    const taskId = taskIdOf(action);
    const task = taskId ? taskById.get(taskId) : undefined;

    // Exactly one of these is ever populated for a real gated call (see the tool schemas): a tab_id
    // for terminal tools, a task_id for the four task tools, a project_id for open_tab/create_task/
    // start_agent (and, for the three MACHINE_LINK_TOOLS below, alongside a machine_id too). Each is
    // the *primary* reference this specific action names, and its own resolution decides the whole
    // "where" — a project derived from a resolved tab or task (and a machine, only from a resolved
    // tab — a project has no single machine any more) is a secondary, best-effort addition, never
    // itself a reason to say something is missing.
    let loc: Location;
    if (action.tab_id) {
      const tab = tabById.get(action.tab_id);
      if (!tab) loc = { missing: 'tab' };
      else {
        const project = projectById.get(tab.project_id);
        loc = { tab: tab.name, project: project?.name, machine: machineById.get(tab.machine_id)?.name };
        if (action.tool === 'close_tab') {
          loc.tabOrigin =
            tab.created_by_token_id === null
              ? 'aberta por você, não pelo chat'
              : chatTokenIds?.has(tab.created_by_token_id)
                ? 'aberta pelo chat'
                : 'aberta por um token de API seu, não pelo chat';
        }
      }
    } else if (taskId) {
      // A missing task is already said in full by `verbPhrase` ("...que não existe mais"); no
      // location is appended to it. A found task still gets its project named here.
      if (!task) loc = {};
      else {
        const project = projectById.get(task.project_id);
        loc = { project: project?.name };
      }
    } else if (action.project_id && action.machine_id && MACHINE_LINK_TOOLS.has(action.tool)) {
      // Link/re-point/unlink: unlike open_tab/create_task/start_agent, the machine here is the key
      // fact the user is approving, not an incidental detail — name both, through the same
      // owner-scoped batched lookups every other branch uses (machineById already holds every
      // action's machine_id, so this is no extra query).
      const project = projectById.get(action.project_id);
      if (!project) loc = { missing: 'project' };
      else {
        const machine = machineById.get(action.machine_id);
        loc = machine ? { project: project.name, machine: machine.name } : { missing: 'machine' };
      }
    } else if (action.project_id) {
      const project = projectById.get(action.project_id);
      loc = project ? { project: project.name } : { missing: 'project' };
    } else if (action.machine_id) {
      const machine = machineById.get(action.machine_id);
      loc = machine ? { machine: machine.name } : { missing: 'machine' };
    } else {
      loc = {};
    }

    const summary = summarize(action, task, loc);
    return toCard(action, summary);
  });
}

/** A grant as the chat shows it: the tab by name (owner-scoped, like the cards), no user ids. */
export interface ChatGrantView {
  id: string;
  tab_id: string;
  tool: string;
  source_action_id: string | null;
  created_at: string;
  expires_at: string;
  /** Null when the tab is gone (or not this user's): the strip then says "uma aba que não existe mais". */
  tab_name: string | null;
}

/** Enriches a batch of tab grants with the tab's name, exactly like `describeActions` — one batched,
 * owner-scoped lookup, never one per grant, and another user's tab is indistinguishable from a gone one. */
export async function describeGrants(repos: Repositories, grants: ChatGrant[], ownerId: string): Promise<ChatGrantView[]> {
  const tabIds = [...new Set(grants.map((g) => g.tab_id))];
  const tabs = tabIds.length ? await repos.tabs.findByIdsForOwner(tabIds, ownerId) : [];
  const nameById = new Map(tabs.map((t) => [t.id, t.name]));
  return grants.map((g) => ({
    id: g.id,
    tab_id: g.tab_id,
    tool: g.tool,
    source_action_id: g.source_action_id,
    created_at: g.created_at,
    expires_at: g.expires_at,
    tab_name: nameById.get(g.tab_id) ?? null,
  }));
}

/** How a grant stands (spec 2026-09-26 §3.2). A reset or a re-grant revokes every unrevoked row, expired
 * ones included, so a revocation that came after the expiry is not what ended it: that grant expired. */
export type ChatGrantState = 'active' | 'expired' | 'revoked' | 'ended';

export function grantState(g: Pick<ChatGrant, 'expires_at' | 'revoked_at' | 'revoked_by'>, now = new Date()): ChatGrantState {
  const expiresAt = Date.parse(g.expires_at);
  if (g.revoked_at !== null && Date.parse(g.revoked_at) < expiresAt) return g.revoked_by ? 'revoked' : 'ended';
  return expiresAt > now.getTime() && g.revoked_at === null ? 'active' : 'expired';
}

/** A grant as "Abas confiáveis" lists it: the chat's view plus the tab's project, the conversation that
 * granted it and how it stands. No user ids. */
export interface ChatGrantListItem extends ChatGrantView {
  project_id: string | null;
  project_name: string | null;
  conversation_id: string;
  /** Null = the account-wide chat ("Chat geral"). */
  conversation_project_name: string | null;
  conversation_archived: boolean;
  state: ChatGrantState;
  /** When it stopped counting: the revocation, or the expiry; null while active. */
  ended_at: string | null;
}

/** Enriches a page of grants like `describeGrants`: one owner-scoped lookup for the tabs and one for the
 * projects (the tabs' and the conversations'), never one per grant. */
export async function describeGrantList(repos: Repositories, grants: ChatGrantWithConversation[], ownerId: string, now = new Date()): Promise<ChatGrantListItem[]> {
  const tabIds = [...new Set(grants.map((g) => g.tab_id))];
  const tabs = tabIds.length ? await repos.tabs.findByIdsForOwner(tabIds, ownerId) : [];
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const projectIds = [...new Set([...tabs.map((t) => t.project_id), ...grants.flatMap((g) => (g.conversation_project_id ? [g.conversation_project_id] : []))])];
  const projects = projectIds.length ? await repos.projects.findByIdsForOwner(projectIds, ownerId) : [];
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  return grants.map((g) => {
    const tab = tabById.get(g.tab_id);
    const state = grantState(g, now);
    const projectId = tab?.project_id ?? null;
    return {
      id: g.id,
      tab_id: g.tab_id,
      tool: g.tool,
      source_action_id: g.source_action_id,
      created_at: g.created_at,
      expires_at: g.expires_at,
      tab_name: tab?.name ?? null,
      project_id: projectId,
      project_name: projectId ? (projectName.get(projectId) ?? null) : null,
      conversation_id: g.conversation_id,
      conversation_project_name: g.conversation_project_id ? (projectName.get(g.conversation_project_id) ?? null) : null,
      conversation_archived: g.conversation_archived,
      state,
      ended_at: state === 'active' ? null : state === 'expired' ? g.expires_at : g.revoked_at,
    };
  });
}
