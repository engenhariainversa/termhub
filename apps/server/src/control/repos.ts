import type { Repositories } from '../db/repositories/index.js';
import type { Machine, RepoStatus } from '../db/repositories/types.js';
import { defaultDiscoveryDeps, scanProject, scanTimes, type DiscoveryDeps, type LinkScan } from '../repos/discovery.js';
import type { AutonomyLevel } from '../setup/schema.js';
import type { ControlContext } from './context.js';

/** Where one repository of the project sits on one linked machine (spec 2026-10-07 multi-repo R5). */
export interface RepoMachineView {
  machine_id: string;
  machine: string;
  /** relative to the project's folder on that machine */
  dir: string;
  /** the folder was there and a later scan did not find it */
  missing: boolean;
  seen_at: string;
}

/** One repository of the project as the Setup screen and the concierge read it. */
export interface RepoView {
  /** null: named by hand in the Setup, discovery has not found it yet */
  key: string | null;
  full_name: string;
  description: string | null;
  status: RepoStatus;
  enabled: boolean;
  discovered: boolean;
  /** never above the project's (R7); a discovered repository with no override is `pr` (R6) */
  autonomy: AutonomyLevel;
  machines: RepoMachineView[];
}

/** One machine linked to the project, as discovery sees it. */
export interface ScanMachineView {
  machine_id: string;
  machine: string;
  cwd: string;
  /** when discovery last scanned the folder there; null = never */
  scanned_at: string | null;
  /** `ok`, or why discovery cannot scan it now */
  can_scan: ReturnType<DiscoveryDeps['canScan']>;
}

export interface ProjectReposView {
  project_id: string;
  repos: RepoView[];
  machines: ScanMachineView[];
}

/** The project's repositories and, per linked machine, the last scan (TER-1071). */
export async function projectReposView(repos: Repositories, projectId: string, deps: Pick<DiscoveryDeps, 'canScan'> = defaultDiscoveryDeps): Promise<ProjectReposView> {
  const [setup, links, scannedAt] = await Promise.all([repos.projectSetup.get(projectId), repos.projectMachines.listByProject(projectId), scanTimes(repos, projectId)]);
  const effective = await repos.projectRepositories.effective(projectId, setup.data);
  const machines = new Map<string, Machine>();
  for (const m of await Promise.all(links.map((l) => repos.machines.findById(l.machine_id)))) if (m) machines.set(m.id, m);
  const nameOf = (id: string) => machines.get(id)?.name ?? id;
  return {
    project_id: projectId,
    repos: effective.map((e) => ({
      key: e.key,
      full_name: e.full_name,
      description: e.description,
      status: e.status,
      enabled: e.enabled,
      discovered: e.discovered,
      autonomy: e.autonomy,
      machines: e.checkouts.map((c) => ({ machine_id: c.machine_id, machine: nameOf(c.machine_id), dir: c.dir, missing: c.missing_at !== null, seen_at: c.seen_at })),
    })),
    machines: links.map((l) => {
      const m = machines.get(l.machine_id);
      return { machine_id: l.machine_id, machine: nameOf(l.machine_id), cwd: l.cwd, scanned_at: scannedAt.get(l.machine_id) ?? null, can_scan: m ? deps.canScan(m) : 'not_agent' };
    }),
  };
}

/** `list_project_repos`. */
export async function listProjectRepos(ctx: ControlContext, input: { project_id: string }, deps?: Pick<DiscoveryDeps, 'canScan'>): Promise<ProjectReposView> {
  const { project } = await ctx.scoped.project(input.project_id);
  return projectReposView(ctx.repos, project.id, deps);
}

/** `scan_project_repos` and "Procurar agora": scans every linked machine now, then answers the list. */
export async function scanProjectRepos(ctx: ControlContext, input: { project_id: string }, deps: DiscoveryDeps = defaultDiscoveryDeps): Promise<ProjectReposView & { scans: LinkScan[] }> {
  const { project } = await ctx.scoped.project(input.project_id);
  const scans = await scanProject(ctx.repos, project.id, { force: true }, deps);
  return { ...(await projectReposView(ctx.repos, project.id, deps)), scans };
}
