import { readTicketLink } from '../../integrations/ticket-link.js';
import { autoDecisionOfArgs, describeAutoDecisions, type AutoDecisionView } from './auto-decision-view.js';
import type { Repositories } from './index.js';
import type { ChatAction, ChatActionClass, ChatActionStatus } from './chat-actions.js';
import type { ChatGrant, ChatGrantWithConversation } from './chat-grants.js';
import type { ChatProjectGrant, ChatProjectGrantWithConversation, ProjectGrantScope } from './chat-project-grants.js';
import type { ChatStandingGrant, ChatStandingGrantWithConversation, StandingGrantKind } from './chat-standing-grants.js';
import type { Task, Ticket } from './types.js';

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
  /** The subagent (`chat_subagents`, spec 2026-09-26 §4) whose turn proposed this action, resolved
   * from `ChatAction.subagent_id` and scoped to this same conversation exactly like every other
   * reference this card names — a subagent row from another conversation is indistinguishable from
   * none at all. Null for an action the top-level run proposed directly. */
  subagent: { id: string; description: string } | null;
  created_at: string;
  /** Why a `failed` row ended (`TAB_GONE`, `WAITING_PERMISSION`…): the card says it (TER-477). Null otherwise. */
  error_code: string | null;
  /** When the card was last brought back to the end of the chat (TER-477): screens order by it, else `created_at`. */
  surfaced_at: string | null;
  /** TER-641: a `send_input`/`send_key` the concierge sent on a precedent from memory (its optional
   * `sources`, and `reason`), with the cited decisions resolved owner-scoped. Null when it cited none.
   * Screens show "Decisão automática" only when the call also ran without a click (`grant_id`). */
  auto_decision: AutoDecisionView | null;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The `task_id` an action's args name, if any — the four task tools below all require one, but it
 * is never copied onto the row itself (unlike machine/project/tab_id, which the gate's `targetOf`
 * does store): the sentence has to read it straight from `args`. */
const taskIdOf = (action: ChatAction): string => asString((action.args as Record<string, unknown> | null)?.task_id);

/** The `ticket_ids` an import_tickets action names, if any — same idea as `taskIdOf`: never copied
 * onto the row, so the sentence has to read it straight from `args`. */
const ticketIdsOf = (action: ChatAction): string[] => {
  const raw = (action.args as Record<string, unknown> | null)?.ticket_ids;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
};

/** The machine a create_integration action reads the gh login from — nested in `secret_from`, so the
 * gate's `targetOf` never copies it onto the row: read straight from `args`, like `taskIdOf`. */
const secretMachineIdOf = (action: ChatAction): string => {
  if (action.tool !== 'create_integration') return '';
  const from = (action.args as Record<string, unknown> | null)?.secret_from;
  const id = from && typeof from === 'object' ? asString((from as Record<string, unknown>).machine_id) : '';
  return id.length <= 64 ? id : '';
};

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

const PROVIDER_NAME = { github: 'GitHub', linear: 'Linear', jira: 'Jira' } as const;

/** The card status push_ticket_status carries over, as the board names it. */
const STATUS_LABEL = { backlog: 'Backlog', todo: 'A fazer', doing: 'Fazendo', done: 'Feito' } as const;

/** At most 10 keys named, then "e mais N" for the rest — never a wall of keys in one sentence. */
function formatKeys(keys: string[]): string {
  return keys.length <= 10 ? keys.join(', ') : `${keys.slice(0, 10).join(', ')} e mais ${keys.length - 10}`;
}

/** The only tools whose row carries both a project_id and a machine_id where the machine is the key
 * fact being approved (which machine is being linked/re-pointed/unlinked) — for these three alone,
 * `describeActions` resolves and names both, rather than letting the project_id branch win the way it
 * does for every other project-scoped tool (open_tab, create_task, start_agent), where a project has
 * no single machine and naming one would be misleading. */
const MACHINE_LINK_TOOLS = new Set(['link_project_machine', 'set_project_machine_cwd', 'unlink_project_machine']);

/** Why an `automation_merge` card asks: the level the PR needs, by name as the Setup shows it. */
const MERGE_NEED: Record<string, string> = {
  merge: 'precisa do nível Merge com CI verde',
  deploy: 'precisa do nível Deploy',
  release: 'precisa do nível Publicação',
  store: 'precisa de build nas lojas',
  files_incomplete: 'a lista de arquivos do PR veio incompleta',
};

/** The level names as the Setup shows them ("Até onde os agentes vão sozinhos"). */
const AUTONOMY_LABEL: Record<string, string> = { pr: 'Só código e PR', merge: 'Merge com CI verde', deploy: 'Deploy', release: 'Publicação (npm, OTA)' };

const listOf = (v: unknown): string => {
  const items = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return items.length ? items.map((x) => `\`${x}\``).join(', ') : 'nenhum';
};

/** What a `set_automation_policy` card changes (TER-975), field by field, in the order of the Setup screen. */
function automationPolicyPhrase(args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (args.enabled === true) parts.push('ligar o trabalho automático do projeto');
  if (args.enabled === false) parts.push('desligar o trabalho automático do projeto');
  if (typeof args.autonomy === 'string') parts.push(`nível "${AUTONOMY_LABEL[args.autonomy] ?? args.autonomy}"`);
  if (args.release_paths !== undefined) parts.push(`caminhos de release: ${listOf(args.release_paths)}`);
  if (args.store_paths !== undefined) parts.push(`caminhos das lojas: ${listOf(args.store_paths)}`);
  if (args.release_workflows !== undefined) parts.push(`workflows de release: ${listOf(args.release_workflows)}`);
  if (args.required_checks !== undefined) parts.push(`checks obrigatórios: ${listOf(args.required_checks)}`);
  if (args.max_parallel !== undefined) parts.push(`máximo em paralelo: ${typeof args.max_parallel === 'number' ? args.max_parallel : 'sem limite'}`);
  const what = parts.join('; ');
  return args.enabled === undefined ? `mudar o Setup do trabalho automático (${what})` : what;
}

function verbPhrase(action: ChatAction, task: Task | undefined, ticketById: Map<string, Ticket>, integrationById: Map<string, { name: string }>): string {
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
    case 'link_tab_task':
      return task ? `ligar a tarefa ${named(task)}` : 'ligar uma tarefa que não existe mais';
    case 'pause_automation':
      return `pausar o trabalho automático${args.project_id ? ' do projeto' : ' de todos os projetos'}${args.interrupt === true ? ' e interromper as abas que estão nele agora' : ''}`;
    case 'resume_automation':
      return `retomar o trabalho automático${args.project_id ? ' do projeto' : ' de todos os projetos'}`;
    case 'set_automation_policy':
      return automationPolicyPhrase(args);
    case 'set_machine_automation':
      return args.accept === true ? 'fazer a máquina aceitar trabalho automático' : 'fazer a máquina recusar trabalho automático';
    case 'install_machine_hooks': {
      const tools = Array.isArray(args.tools) ? args.tools.filter((x): x is string => typeof x === 'string') : [];
      return `instalar ou atualizar os hooks do termhub (${tools.length ? tools.join(', ') : 'Claude Code, Codex e Cursor que estiverem lá'}), mexendo nos arquivos de configuração deles`;
    }
    case 'resume_automation_run':
      return 'retomar o trabalho automático de um card';
    case 'automation_merge': {
      // The merge executor's own card (agentic board D7): args are the server's, never the concierge's.
      const n = typeof args.number === 'number' ? `#${args.number}` : 'um PR';
      const title = asString(args.title);
      return `mesclar o PR ${n}${title ? ` "${title}"` : ''} de \`${asString(args.repo)}\` (${MERGE_NEED[asString(args.needed)] ?? 'acima do nível do projeto'})`;
    }
    case 'sync_tickets':
      return 'sincronizar os tickets de todas as fontes';
    case 'import_tickets': {
      const keys = Array.isArray(args.keys) ? args.keys.filter((k): k is string => typeof k === 'string') : [];
      const ids = ticketIdsOf(action);
      // keys named directly are used as-is; ticket_ids are resolved through the owner-scoped batch —
      // a foreign or gone id simply does not resolve (never leaked), and the count still reflects
      // what was asked even when some keys stay unnamed.
      const resolvedKeys = keys.length ? keys : ids.map((id) => ticketById.get(id)?.key).filter((k): k is string => k !== undefined);
      const n = keys.length || ids.length;
      return `importar ${n} ${n === 1 ? 'ticket' : 'tickets'} para o backlog${resolvedKeys.length ? `: ${formatKeys(resolvedKeys)}` : ''}`;
    }
    case 'push_ticket_status': {
      const link = task ? readTicketLink(task.external_ref) : null;
      if (!task) return 'atualizar o ticket de uma tarefa que não existe mais';
      return link
        ? `mudar o ${link.key} no ${PROVIDER_NAME[link.provider]} para "${STATUS_LABEL[task.status] ?? task.status}" (como a tarefa ${named(task)})`
        : `atualizar o ticket da tarefa ${named(task)}`;
    }
    case 'create_integration':
      return `criar a integração do GitHub "${asString(args.name)}" com o login do gh (\`gh auth token\`)`;
    case 'set_project_repo': {
      // The integration is named from the owner-scoped list `describeActions` read: another owner's
      // id reads exactly like one that does not exist.
      const integration = integrationById.get(asString(args.integration_id));
      const deploy =
        typeof args.deploy_workflow === 'string' ? `, com o deploy no workflow \`${args.deploy_workflow}\`` : args.deploy_workflow === null ? ', sem workflow de deploy' : '';
      const base = typeof args.base_branch === 'string' ? `, branch base \`${args.base_branch}\`` : '';
      return `usar o repositório \`${asString(args.full_name)}\` ${integration ? `pela integração "${integration.name}"` : 'por uma integração que não existe mais'}${deploy}${base}`;
    }
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
  /** A gone tab's name as the row kept it when it was asked (TER-1024): the card names it rather than
   * saying "uma aba que não existe mais". Only ever set alongside `missing: 'tab'`. */
  goneTab?: string;
  /** The action closes that tab itself: "fechar a aba «X»", not "fechar a aba na aba «X», já fechada". */
  closesTab?: boolean;
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
  if (loc.missing === 'tab' && loc.goneTab) {
    const tab = loc.closesTab ? `«${loc.goneTab}»` : `na aba «${loc.goneTab}», já fechada,`;
    return loc.project ? `${tab} do projeto ${loc.project}` : tab.replace(/,$/, '');
  }
  if (loc.missing === 'tab') return loc.project ? `numa aba que não existe mais do projeto ${loc.project}` : 'numa aba que não existe mais';
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

function summarize(action: ChatAction, task: Task | undefined, loc: Location, ticketById: Map<string, Ticket>, integrationById: Map<string, { name: string }>): string {
  const verb = verbPhrase(action, task, ticketById, integrationById);
  const where = targetPhrase(loc);
  return where ? `${verb} ${where}` : verb;
}

const toCard = (action: ChatAction, summary: string, subagent: { id: string; description: string } | null, autoDecision: AutoDecisionView | null): ChatActionCard => ({
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
  subagent,
  created_at: action.created_at,
  error_code: action.error_code,
  surfaced_at: action.surfaced_at ?? null,
  auto_decision: autoDecision,
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
 * machine any more (a project can link to 0–N), so only a tab's action names one. `import_tickets`
 * with `ticket_ids` (no `keys`) is resolved the same way too, in the same batch: without it the card
 * would say "importar N tickets" with nothing naming which ones, and approving that is approving
 * blind — exactly the gap `delete_task` above is careful never to leave for a task.
 */
export async function describeActions(repos: Repositories, actions: ChatAction[], ownerId: string): Promise<ChatActionCard[]> {
  const tabIds = [...new Set(actions.map((a) => a.tab_id).filter((v): v is string => v !== null))];
  const taskIds = [...new Set(actions.map(taskIdOf).filter((v) => v.length > 0))];
  const ticketIds = [...new Set(actions.flatMap(ticketIdsOf))];
  const [tabs, tasks, tickets] = await Promise.all([
    tabIds.length ? repos.tabs.findByIdsForOwner(tabIds, ownerId) : [],
    taskIds.length ? repos.tasks.findByIdsForOwner(taskIds, ownerId) : [],
    ticketIds.length ? repos.tickets.findByIdsForOwner(ticketIds, ownerId) : [],
  ]);
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const projectIds = new Set<string>();
  for (const a of actions) if (a.project_id) projectIds.add(a.project_id);
  for (const t of tabs) projectIds.add(t.project_id);
  for (const t of tasks) projectIds.add(t.project_id);
  const projects = projectIds.size ? await repos.projects.findByIdsForOwner([...projectIds], ownerId) : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const machineIds = new Set<string>();
  for (const a of actions) if (a.machine_id) machineIds.add(a.machine_id);
  for (const a of actions) if (secretMachineIdOf(a)) machineIds.add(secretMachineIdOf(a));
  for (const t of tabs) machineIds.add(t.machine_id);
  const machines = machineIds.size ? await repos.machines.findByIdsForOwner([...machineIds], ownerId) : [];
  const machineById = new Map(machines.map((m) => [m.id, m]));

  // set_project_repo only: the integration it points the project at, from the owner's own list (one
  // lookup, and none at all when no such card is in the batch).
  const integrations = actions.some((a) => a.tool === 'set_project_repo') ? await repos.integrations.list(ownerId) : [];
  const integrationById = new Map(integrations.map((i) => [i.id, i]));

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

  // Which subagent proposed an action (spec 2026-09-26 §4), resolved the same batched way as every
  // other reference this card names. Scoped to the action's own conversation, not `ownerId`: a
  // subagent row belongs to a conversation, not a user, and `chatSubagents.listByIds` carries no
  // owner filter of its own — the conversation check right below is what keeps a subagent row from
  // a foreign conversation (which could only reach here via a stale or forged `subagent_id`) from
  // ever being named on this card.
  const subIds = [...new Set(actions.map((a) => a.subagent_id).filter((x): x is string => !!x))];
  const subs = subIds.length ? await repos.chatSubagents.listByIds(subIds) : [];
  const subById = new Map(subs.map((s) => [s.id, s]));

  // TER-641: the precedents a send cited, in one owner-scoped read (none when no card cites a decision).
  const autoDecisions = await describeAutoDecisions(repos, actions.map((a) => autoDecisionOfArgs(a.tool, a.args)), ownerId);

  return actions.map((action, index) => {
    const taskId = taskIdOf(action);
    const task = taskId ? taskById.get(taskId) : undefined;

    // Exactly one of these is ever populated for a real gated call (see the tool schemas): a tab_id
    // for terminal tools, a task_id for the four task tools, a project_id for open_tab/create_task/
    // start_agent (and, for the three MACHINE_LINK_TOOLS below, alongside a machine_id too). The one
    // exception is link_tab_task, which names a tab and a task: the tab is its "where" and the verb
    // already names the task. Each is
    // the *primary* reference this specific action names, and its own resolution decides the whole
    // "where" — a project derived from a resolved tab or task (and a machine, only from a resolved
    // tab — a project has no single machine any more) is a secondary, best-effort addition, never
    // itself a reason to say something is missing.
    let loc: Location;
    if (action.tab_id) {
      const tab = tabById.get(action.tab_id);
      // A gone tab's card still names its project when the row kept it (TER-986: stored when asked).
      // And its name (TER-1024), so a closed tab's card still says which tab it was.
      if (!tab) {
        loc = { missing: 'tab', project: action.project_id ? projectById.get(action.project_id)?.name : undefined };
        if (action.tab_name) {
          loc.goneTab = action.tab_name;
          loc.closesTab = action.tool === 'close_tab';
        }
      }
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
    } else if (secretMachineIdOf(action)) {
      const machine = machineById.get(secretMachineIdOf(action));
      loc = machine ? { machine: machine.name } : { missing: 'machine' };
    } else if (action.machine_id) {
      const machine = machineById.get(action.machine_id);
      loc = machine ? { machine: machine.name } : { missing: 'machine' };
    } else {
      loc = {};
    }

    const summary = summarize(action, task, loc, ticketById, integrationById);
    const sa = action.subagent_id ? subById.get(action.subagent_id) : undefined;
    const subagent = sa && sa.conversation_id === action.conversation_id ? { id: sa.id, description: sa.description } : null;
    return toCard(action, summary, subagent, autoDecisions[index] ?? null);
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

/** A grant as "Abas confiáveis" lists it, any kind: the chat's view (tab grant), a project grant (spec
 * 2026-09-26 project grant §5) or a standing grant (spec 2026-09-28 TER-386) — `tab_id`/`tool`/`tab_name`
 * are null for the latter two, since they carry no tab. Plus the project, the conversation that granted
 * it and how it stands. No user ids. */
export interface ChatGrantListItem {
  kind: 'tab' | 'project' | 'standing';
  id: string;
  tab_id: string | null;
  tool: string | null;
  source_action_id: string | null;
  created_at: string;
  /** Null only for a standing grant, which never expires. */
  expires_at: string | null;
  /** Null when the tab is gone (or not this user's) — or, for a project or standing grant, always. */
  tab_name: string | null;
  project_id: string | null;
  project_name: string | null;
  /** Null only for a standing grant whose granting conversation is gone (it outlives it). */
  conversation_id: string | null;
  /** Null = the account-wide chat ("Chat geral"). */
  conversation_project_name: string | null;
  conversation_archived: boolean;
  state: ChatGrantState;
  /** When it stopped counting: the revocation, or the expiry; null while active. */
  ended_at: string | null;
  /** A project grant's scope (TER-325); always null for a tab or standing grant. */
  scope: ProjectGrantScope | null;
  /** A standing grant's kind (TER-386); always null for a tab or project grant. */
  standing_kind: StandingGrantKind | null;
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
      kind: 'tab',
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
      scope: null,
      standing_kind: null,
    };
  });
}

/** "Permitir sempre neste projeto" as the chat shows it: the project by name (owner-scoped), no user ids. */
export interface ChatProjectGrantView {
  id: string;
  project_id: string;
  /** Null when the project is gone or not this user's. */
  project_name: string | null;
  source_action_id: string | null;
  created_at: string;
  expires_at: string;
  /** `board`: the board tools; `all`: those and the project's tabs' keys and typing (TER-325). */
  scope: ProjectGrantScope;
}

/** Enriches a batch of project grants with the project's name, exactly like `describeGrants` — one
 * batched, owner-scoped lookup, never one per grant. */
export async function describeProjectGrants(repos: Repositories, grants: ChatProjectGrant[], ownerId: string): Promise<ChatProjectGrantView[]> {
  const ids = [...new Set(grants.map((g) => g.project_id))];
  const projects = ids.length ? await repos.projects.findByIdsForOwner(ids, ownerId) : [];
  const name = new Map(projects.map((p) => [p.id, p.name]));
  return grants.map((g) => ({ id: g.id, project_id: g.project_id, project_name: name.get(g.project_id) ?? null, source_action_id: g.source_action_id, created_at: g.created_at, expires_at: g.expires_at, scope: g.scope }));
}

/** Enriches a page of project grants like `describeGrantList`, for `kinds=all` (spec 2026-09-26 project
 * grant §5): one owner-scoped lookup for the grant's own project and the conversation's, never one per
 * grant. Always `kind: 'project'`, with no tab of its own. */
export async function describeProjectGrantList(repos: Repositories, grants: ChatProjectGrantWithConversation[], ownerId: string, now = new Date()): Promise<ChatGrantListItem[]> {
  const ids = [...new Set(grants.flatMap((g) => [g.project_id, ...(g.conversation_project_id ? [g.conversation_project_id] : [])]))];
  const projects = ids.length ? await repos.projects.findByIdsForOwner(ids, ownerId) : [];
  const name = new Map(projects.map((p) => [p.id, p.name]));
  return grants.map((g) => {
    const state = grantState(g, now);
    return {
      kind: 'project',
      id: g.id,
      tab_id: null,
      tool: null,
      tab_name: null,
      source_action_id: g.source_action_id,
      created_at: g.created_at,
      expires_at: g.expires_at,
      project_id: g.project_id,
      project_name: name.get(g.project_id) ?? null,
      conversation_id: g.conversation_id,
      conversation_project_name: g.conversation_project_id ? (name.get(g.conversation_project_id) ?? null) : null,
      conversation_archived: g.conversation_archived,
      state,
      ended_at: state === 'active' ? null : state === 'expired' ? g.expires_at : g.revoked_at,
      scope: g.scope,
      standing_kind: null,
    };
  });
}

/** "Liberar sem prazo" as the chat shows it (spec 2026-09-28 TER-386): the project by name (owner-scoped)
 * and the kind of routine action it trusts. No expiry, no conversation, no user ids. */
export interface ChatStandingGrantView {
  id: string;
  project_id: string;
  /** Null when the project is gone or not this user's. */
  project_name: string | null;
  kind: StandingGrantKind;
  source_action_id: string | null;
  created_at: string;
}

/** Enriches a batch of standing grants with the project's name, exactly like `describeProjectGrants` —
 * one batched, owner-scoped lookup, never one per grant. */
export async function describeStandingGrants(repos: Repositories, grants: ChatStandingGrant[], ownerId: string): Promise<ChatStandingGrantView[]> {
  const ids = [...new Set(grants.map((g) => g.project_id))];
  const projects = ids.length ? await repos.projects.findByIdsForOwner(ids, ownerId) : [];
  const name = new Map(projects.map((p) => [p.id, p.name]));
  return grants.map((g) => ({ id: g.id, project_id: g.project_id, project_name: name.get(g.project_id) ?? null, kind: g.kind, source_action_id: g.source_action_id, created_at: g.created_at }));
}

/** Enriches a page of standing grants like `describeProjectGrantList`, for `kinds=all_standing`: one
 * owner-scoped lookup for the grant's own project and the conversation's. Always `kind: 'standing'`,
 * with no tab, no expiry and no scope; it is either in force or revoked. `conversation_id` stays null
 * when the granting conversation is gone — a standing grant outlives it. */
export async function describeStandingGrantList(repos: Repositories, grants: ChatStandingGrantWithConversation[], ownerId: string): Promise<ChatGrantListItem[]> {
  const ids = [...new Set(grants.flatMap((g) => [g.project_id, ...(g.conversation_project_id ? [g.conversation_project_id] : [])]))];
  const projects = ids.length ? await repos.projects.findByIdsForOwner(ids, ownerId) : [];
  const name = new Map(projects.map((p) => [p.id, p.name]));
  return grants.map((g) => ({
    kind: 'standing',
    id: g.id,
    tab_id: null,
    tool: null,
    tab_name: null,
    source_action_id: g.source_action_id,
    created_at: g.created_at,
    expires_at: null,
    project_id: g.project_id,
    project_name: name.get(g.project_id) ?? null,
    conversation_id: g.conversation_id,
    conversation_project_name: g.conversation_project_id ? (name.get(g.conversation_project_id) ?? null) : null,
    conversation_archived: g.conversation_archived,
    state: g.revoked_at === null ? 'active' : 'revoked',
    ended_at: g.revoked_at,
    scope: null,
    standing_kind: g.kind,
  }));
}
