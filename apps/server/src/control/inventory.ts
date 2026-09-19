import { agents } from '../agent/registry.js';
import type { Machine, MachineType, TabKind, TabState } from '../db/repositories/types.js';
import { listTmuxSessions } from '../terminal/machine-exec.js';
import { ControlError, type ControlContext } from './context.js';

export interface MachineSummary {
  id: string;
  name: string;
  type: MachineType;
  os: string | null;
  /** agent: connected now; local: always; ssh: null = not checked (probing is slow) */
  online: boolean | null;
  capabilities: string[];
}

function online(m: Machine): boolean | null {
  if (m.type === 'agent') return agents.isOnline(m.id);
  if (m.type === 'local') return true;
  return null;
}

const summary = (m: Machine): MachineSummary => ({ id: m.id, name: m.name, type: m.type, os: m.os, online: online(m), capabilities: m.capabilities });

export async function listMachines(ctx: ControlContext): Promise<{ machines: MachineSummary[] }> {
  const machines = await ctx.repos.machines.list(ctx.scope.ownerId);
  return { machines: machines.map(summary) };
}

async function machineNames(ctx: ControlContext): Promise<Map<string, string>> {
  return new Map((await ctx.repos.machines.list(ctx.scope.ownerId)).map((m) => [m.id, m.name]));
}

export async function listProjects(ctx: ControlContext, input: { machine_id?: string; include_archived?: boolean }) {
  if (input.machine_id) await ctx.scoped.machine(input.machine_id);
  const [projects, names] = await Promise.all([ctx.repos.projects.list({ machine_id: input.machine_id, owner: ctx.scope.ownerId }), machineNames(ctx)]);
  return {
    projects: projects
      .filter((p) => input.include_archived || p.status !== 'archived')
      .map((p) => ({ id: p.id, name: p.name, cwd: p.cwd, status: p.status, description: p.description, machine_id: p.machine_id, machine_name: names.get(p.machine_id) ?? null })),
  };
}

export interface TabSummary {
  id: string;
  name: string;
  kind: TabKind;
  project_id: string;
  /** tmux session running now; null = unknown (machine unreachable) or not a terminal */
  alive: boolean | null;
  state: TabState | null;
  state_text: string | null;
  state_at: string | null;
  task: { id: string; title: string; status: string } | null;
}

export async function listTabs(ctx: ControlContext, input: { project_id?: string; machine_id?: string }): Promise<{ tabs: TabSummary[] }> {
  let machine: Machine;
  let projectIds: string[];
  if (input.project_id) {
    const r = await ctx.scoped.project(input.project_id);
    machine = r.machine;
    projectIds = [r.project.id];
  } else if (input.machine_id) {
    machine = await ctx.scoped.machine(input.machine_id);
    projectIds = (await ctx.repos.projects.list({ machine_id: machine.id, owner: ctx.scope.ownerId })).map((p) => p.id);
  } else {
    throw new ControlError('BAD_REQUEST', 'Informe project_id ou machine_id');
  }

  // An offline agent's listTmuxSessions answers an empty set (not an error): that would read every tab as dead.
  const sessions = machine.type === 'agent' && !agents.isOnline(machine.id) ? null : await listTmuxSessions(machine).catch(() => null);
  const out: TabSummary[] = [];
  for (const pid of projectIds) {
    const [tabs, tasks] = await Promise.all([ctx.repos.tabs.listByProject(pid), ctx.repos.tasks.listByProject(pid)]);
    const byTab = new Map<string, { id: string; title: string; status: string }>();
    for (const t of tasks.flatMap((x) => [x, ...(x.subtasks ?? [])])) if (t.tab_id) byTab.set(t.tab_id, { id: t.id, title: t.title, status: t.status });
    for (const t of tabs) {
      const alive = t.kind !== 'terminal' || !t.tmux_session || sessions === null ? null : sessions.has(t.tmux_session);
      out.push({ id: t.id, name: t.name, kind: t.kind, project_id: t.project_id, alive, state: t.state, state_text: t.state_text, state_at: t.state_at, task: byTab.get(t.id) ?? null });
    }
  }
  return { tabs: out };
}

export async function listAiAccounts(ctx: ControlContext, input: { machine_id?: string }) {
  if (input.machine_id) await ctx.scoped.machine(input.machine_id);
  const [accounts, names] = await Promise.all([ctx.repos.aiAccounts.list(ctx.scope.ownerId), machineNames(ctx)]);
  return {
    // never config_dir: it is a path on the user's machine and not needed to pick an account
    accounts: accounts
      .filter((a) => !input.machine_id || a.machine_id === input.machine_id)
      .map((a) => ({ id: a.id, provider: a.provider, label: a.label, machine_id: a.machine_id, machine_name: names.get(a.machine_id) ?? null })),
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

export type FindKind = 'machine' | 'project' | 'ai_account';
export interface FindMatch {
  kind: FindKind;
  id: string;
  name: string;
  machine_id: string | null;
  machine_name: string | null;
  score: number;
}

const FIND_LIMIT = 10;

/** Resolves names ("MacBook Pro M4", "Hub Community", "pedrogoiania") to ids in one call, within the owner's data. */
export async function find(ctx: ControlContext, input: { query: string; kinds?: FindKind[] }): Promise<{ matches: FindMatch[] }> {
  const query = normalizeName(input.query);
  if (!query) throw new ControlError('BAD_REQUEST', 'Informe o que procurar');
  const kinds = new Set<FindKind>(input.kinds?.length ? input.kinds : ['machine', 'project', 'ai_account']);
  const [canMachines, canProjects, canAccounts] = await Promise.all([ctx.can('machines', 'read'), ctx.can('projects', 'read'), ctx.can('ai_accounts', 'read')]);
  const machines = await ctx.repos.machines.list(ctx.scope.ownerId);
  const names = new Map(machines.map((m) => [m.id, m.name]));
  const matches: FindMatch[] = [];
  const add = (kind: FindKind, id: string, name: string, machineId: string | null) => {
    const s = score(name, query);
    if (s > 0) matches.push({ kind, id, name, machine_id: machineId, machine_name: machineId ? (names.get(machineId) ?? null) : null, score: s });
  };
  if (kinds.has('machine') && canMachines) for (const m of machines) add('machine', m.id, m.name, null);
  if (kinds.has('project') && canProjects) for (const p of await ctx.repos.projects.list({ owner: ctx.scope.ownerId })) add('project', p.id, p.name, p.machine_id);
  if (kinds.has('ai_account') && canAccounts) for (const a of await ctx.repos.aiAccounts.list(ctx.scope.ownerId)) add('ai_account', a.id, a.label, a.machine_id);
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { matches: matches.slice(0, FIND_LIMIT) };
}
