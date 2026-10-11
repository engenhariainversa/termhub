import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import { belowMinimum, isOutdated, latestAgentVersion } from '../agent/latest-version.js';
import { MIN_AGENT_VERSION } from '../agent/min-version.js';
import type { Machine, MachineType, Tab, TabKind, TabState } from '../db/repositories/types.js';
import { listTmuxSessions } from '../terminal/machine-exec.js';
import { parseRef } from '../db/repositories/task-rules.js';
import { HttpError } from '../lib/errors.js';
import { ControlError, type ControlContext } from './context.js';
import { groupsOf, type GroupView } from './groups.js';
import { cardsOf, resolveTickets } from './tickets.js';

export interface MachineSummary {
  id: string;
  name: string;
  /** the owner's own note about the machine ("MacBook do escritório"); null when there is none */
  subtitle: string | null;
  type: MachineType;
  os: string | null;
  /** agent: connected now; local: always; ssh: null = not checked (probing is slow) */
  online: boolean | null;
  capabilities: string[];
  /** TER-1056, agent machines only: the connected agent's version (the last one seen when offline) */
  agent_version?: string | null;
  /** a newer verified release can be installed now (online agents only) */
  update_available?: boolean;
  /** older than the server's minimum: it is updated once idle, switch or not */
  below_min_version?: boolean;
}

function online(m: Machine): boolean | null {
  if (m.type === 'agent') return agents.isOnline(m.id);
  if (m.type === 'local') return true;
  return null;
}

function summary(m: Machine): MachineSummary {
  const base = { id: m.id, name: m.name, subtitle: m.subtitle, type: m.type, os: m.os, online: online(m), capabilities: m.capabilities };
  if (m.type !== 'agent') return base;
  const live = agents.info(m.id)?.agent_version;
  const agent_version = live ?? m.agent_version;
  return { ...base, agent_version, update_available: !!live && isOutdated(live, latestAgentVersion()), below_min_version: belowMinimum(agent_version) };
}

export async function listMachines(ctx: ControlContext): Promise<{ machines: MachineSummary[]; latest_agent_version: string | null; min_agent_version: string }> {
  const machines = await ctx.repos.machines.list(ctx.scope.ownerId);
  // A colour that just started has not met its agents yet (a deploy): the ones on their way get the time to attach.
  await Promise.all(machines.map((m) => agents.awaitHandover(m)));
  return { machines: machines.map(summary), latest_agent_version: latestAgentVersion(), min_agent_version: MIN_AGENT_VERSION };
}

async function machineNames(ctx: ControlContext): Promise<Map<string, string>> {
  return new Map((await ctx.repos.machines.list(ctx.scope.ownerId)).map((m) => [m.id, m.name]));
}

/** The label a failure is logged by: its code when it has one, else its class. Never its message, which
 *  may carry the person's content (the same rule as `failureLabel` of the chat service, not imported here
 *  so that the control layer does not pull the chat service in). */
const failureCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return err instanceof Error ? err.name : typeof err;
};

/** Logs a failed read of the groups by its label, never by a name. `console` only for a context built
 *  without the request's logger (a script, a test). */
function groupsUnavailable(ctx: ControlContext, where: string, err: unknown): void {
  const log: Pick<FastifyBaseLogger, 'warn'> = ctx.log ?? console;
  log.warn({ user_id: ctx.scope.user.id, code: failureCode(err) }, `${where}: project groups unavailable`);
}

/** The groups `wanted` names: by id first, then by name without case or accents (two groups of one
 *  name both count). None is a refusal: an empty list would read as "the group has no projects". */
function groupsNamed(groups: GroupView[], wanted: string): GroupView[] {
  const byId = groups.filter((g) => g.id === wanted);
  if (byId.length) return byId;
  const name = normalizeName(wanted);
  const byName = groups.filter((g) => normalizeName(g.name) === name);
  if (!byName.length) throw new ControlError('GROUP_NOT_FOUND', 'Grupo não encontrado');
  return byName;
}

export async function listProjects(ctx: ControlContext, input: { machine_id?: string; include_archived?: boolean; group?: string }) {
  if (input.machine_id) await ctx.scoped.machine(input.machine_id);
  const [projects, names] = await Promise.all([ctx.repos.projects.list({ machine_id: input.machine_id, owner: ctx.scope.ownerId }), machineNames(ctx)]);
  // Over the projects just listed, archived ones too: `include_archived` decides below, as for every
  // other project, and a member outside this list is not shown anyway. A failed read costs the groups,
  // not the list; but a group filter cannot be answered without them, and "no such group" would be a lie.
  let groups: GroupView[] = [];
  let favorites = new Set<string>();
  try {
    ({ groups, favorites } = await groupsOf(ctx, { archived: true, projects }));
  } catch (err) {
    groupsUnavailable(ctx, 'list_projects', err);
    if (input.group !== undefined) throw new ControlError('GROUPS_UNAVAILABLE', 'Não foi possível ler os grupos');
  }
  const only = input.group === undefined ? null : new Set(groupsNamed(groups, input.group).flatMap((g) => g.projects.map((p) => p.id)));
  const links = await ctx.repos.projectMachines.listByProjects(projects.map((p) => p.id));
  return {
    projects: projects
      .filter((p) => (input.include_archived || p.status !== 'archived') && (only === null || only.has(p.id)))
      .map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        status: p.status,
        description: p.description,
        // The person's own sidebar groups (spec 2026-09-30); Favoritos is a pin, not a group.
        groups: groups.filter((g) => g.projects.some((m) => m.id === p.id)).map((g) => ({ id: g.id, name: g.name })),
        favorite: favorites.has(p.id),
        machines: links.filter((l) => l.project_id === p.id).map((l) => ({ machine_id: l.machine_id, machine_name: names.get(l.machine_id) ?? null, cwd: l.cwd })),
      })),
  };
}

export interface TabSummary {
  id: string;
  name: string;
  kind: TabKind;
  project_id: string;
  machine_id: string;
  /** tmux session running now; null = unknown (machine unreachable) or not a terminal */
  alive: boolean | null;
  state: TabState | null;
  state_text: string | null;
  state_at: string | null;
  task: { id: string; title: string; status: string } | null;
}

export async function listTabs(ctx: ControlContext, input: { project_id?: string; machine_id?: string }): Promise<{ tabs: TabSummary[] }> {
  let tabs: Tab[];
  const machines = new Map<string, Machine>();
  if (input.project_id) {
    const r = await ctx.scoped.projectMachines(input.project_id);
    for (const { machine } of r.machines) machines.set(machine.id, machine);
    tabs = (await ctx.repos.tabs.listByProject(r.project.id)).filter((t) => machines.has(t.machine_id));
  } else if (input.machine_id) {
    const machine = await ctx.scoped.machine(input.machine_id);
    machines.set(machine.id, machine);
    const projectIds = (await ctx.repos.projects.list({ machine_id: machine.id, owner: ctx.scope.ownerId })).map((p) => p.id);
    tabs = await ctx.repos.tabs.listByProjectsOnMachine(projectIds, machine.id);
  } else {
    throw new ControlError('BAD_REQUEST', 'Informe project_id ou machine_id');
  }

  // One probe per machine. An offline agent's listTmuxSessions answers an empty set (not an error): that would read every tab as dead.
  const sessions = new Map<string, Set<string> | null>();
  for (const [id, machine] of machines) {
    sessions.set(id, machine.type === 'agent' && !(await agents.awaitHandover(machine)) ? null : await listTmuxSessions(machine).catch(() => null));
  }
  const byTab = new Map<string, { id: string; title: string; status: string }>();
  for (const pid of new Set(tabs.map((t) => t.project_id))) {
    for (const t of (await ctx.repos.tasks.listByProject(pid)).flatMap((x) => [x, ...(x.subtasks ?? [])])) if (t.tab_id) byTab.set(t.tab_id, { id: t.id, title: t.title, status: t.status });
  }
  return {
    tabs: tabs.map((t) => {
      const s = sessions.get(t.machine_id) ?? null;
      const alive = t.kind !== 'terminal' || !t.tmux_session || s === null ? null : s.has(t.tmux_session);
      return { id: t.id, name: t.name, kind: t.kind, project_id: t.project_id, machine_id: t.machine_id, alive, state: t.state, state_text: t.state_text, state_at: t.state_at, task: byTab.get(t.id) ?? null };
    }),
  };
}

export async function listAiAccounts(ctx: ControlContext, input: { machine_id?: string }) {
  if (input.machine_id) await ctx.scoped.machine(input.machine_id);
  const [accounts, names] = await Promise.all([ctx.repos.aiAccounts.list(ctx.scope.ownerId), machineNames(ctx)]);
  return {
    // never config_dir: it is a path on the user's machine and not needed to pick an account. `default`
    // is: the account without one is the machine's own login for that CLI (spec 2026-09-30 TER-499 D3).
    accounts: accounts
      .filter((a) => !input.machine_id || a.machine_id === input.machine_id)
      .map((a) => ({ id: a.id, provider: a.provider, label: a.label, machine_id: a.machine_id, machine_name: names.get(a.machine_id) ?? null, default: a.config_dir === null, exclusive_project: a.exclusive_project })),
  };
}

/** Lowercase, no diacritics, single spaces. */
export function normalizeName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 3 exact, 2 prefix, 1.5 substring, 1 every word present; 0 = no match. */
function score(name: string, query: string): number {
  const n = normalizeName(name);
  if (n === query) return 3;
  if (n.startsWith(query)) return 2;
  if (n.includes(query)) return 1.5;
  const words = query.split(' ');
  return words.every((w) => n.includes(w)) ? 1 : 0;
}

export type FindKind = 'machine' | 'project' | 'ai_account' | 'task' | 'ticket' | 'group';
export interface FindMatch {
  kind: FindKind;
  id: string;
  name: string;
  machine_id: string | null;
  machine_name: string | null;
  score: number;
  /** ai_account matches only: whether it is the machine's default login for its CLI (no config dir) */
  default?: boolean;
  /** ticket matches only: the project it belongs to (what import_tickets needs) */
  project_id?: string;
  /** ticket matches only: its card when imported, null when not yet */
  card?: { id: string; ref: string } | null;
}

const FIND_LIMIT = 10;

/** Resolves names ("MacBook Pro M4", "Hub Community", "pedrogoiania") and card refs ("TER-12") to ids in one call, within the owner's data,
 *  and the person's own project groups ("Triunfo"). */
export async function find(ctx: ControlContext, input: { query: string; kinds?: FindKind[] }): Promise<{ matches: FindMatch[] }> {
  const query = normalizeName(input.query);
  if (!query) throw new ControlError('BAD_REQUEST', 'Informe o que procurar');
  // tickets are opt-in: a machine named like a key must not drown in tickets
  const kinds = new Set<FindKind>(input.kinds?.length ? input.kinds : ['machine', 'project', 'ai_account', 'task', 'group']);
  const [canMachines, canProjects, canAccounts, canTasks, canTickets] = await Promise.all([
    ctx.can('machines', 'read'),
    ctx.can('projects', 'read'),
    ctx.can('ai_accounts', 'read'),
    ctx.can('tasks', 'read'),
    ctx.can('tickets', 'read'),
  ]);
  const machines = await ctx.repos.machines.list(ctx.scope.ownerId);
  const names = new Map(machines.map((m) => [m.id, m.name]));
  const matches: FindMatch[] = [];
  const add = (kind: FindKind, id: string, name: string, machineId: string | null, key?: string, extra?: Pick<FindMatch, 'default'>) => {
    const s = Math.max(score(name, query), key && normalizeName(key) === query ? 3 : 0);
    if (s > 0) matches.push({ kind, id, name, machine_id: machineId, machine_name: machineId ? (names.get(machineId) ?? null) : null, score: s, ...extra });
  };
  if (kinds.has('machine') && canMachines) for (const m of machines) add('machine', m.id, m.name, null);
  // Read once, only with the grant: the projects and the groups both need it.
  const projects = canProjects && (kinds.has('project') || kinds.has('group')) ? await ctx.repos.projects.list({ owner: ctx.scope.ownerId }) : [];
  if (kinds.has('project') && canProjects) for (const p of projects) add('project', p.id, p.name, null, p.key);
  // The person's own sidebar groups, by name. A failed read costs the groups, never the lookup: a
  // machine asked for by name must still resolve. Logged by its label, never by a name.
  if (kinds.has('group') && canProjects) {
    try {
      for (const g of (await groupsOf(ctx, { projects })).groups) add('group', g.id, g.name, null);
    } catch (err) {
      groupsUnavailable(ctx, 'find', err);
    }
  }
  if (kinds.has('ai_account') && canAccounts) for (const a of await ctx.repos.aiAccounts.list(ctx.scope.ownerId)) add('ai_account', a.id, a.label, a.machine_id, undefined, { default: a.config_dir === null });
  // A card only by its exact ref ("TER-12"): titles are not names. Another owner's card is simply no match.
  if (kinds.has('task') && canTasks && parseRef(input.query)) {
    try {
      const { task } = await ctx.scoped.taskByRef(input.query);
      matches.push({ kind: 'task', id: task.id, name: `${task.ref} ${task.title}`, machine_id: null, machine_name: null, score: 3 });
    } catch (e) {
      if (!(e instanceof HttpError && e.statusCode === 404)) throw e;
    }
  }
  // A ticket only by its exact key or URL ("EI-123", "owner/repo#12"), across the user's projects.
  if (kinds.has('ticket') && canTickets) {
    const projectIds = (await ctx.repos.projects.list({ owner: ctx.scope.ownerId })).map((p) => p.id);
    const found = await resolveTickets(ctx, input.query, projectIds, false);
    const cards = await cardsOf(ctx, found);
    for (const t of found) {
      const card = t.task_id ? cards.get(t.task_id) : undefined;
      matches.push({ kind: 'ticket', id: t.id, name: `${t.key} ${t.title}`, machine_id: null, machine_name: null, score: 3, project_id: t.project_id, card: card ? { id: card.id, ref: card.ref } : null });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { matches: matches.slice(0, FIND_LIMIT) };
}
