import path from 'node:path';
import { CAPABILITY_REPO_SCAN, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { agents } from '../agent/registry.js';
import { agentRpc } from '../agent/errors.js';
import { recordEvent } from '../automation/events.js';
import { postAutomationLine } from '../automation/chat-line.js';
import type { Repositories } from '../db/repositories/index.js';
import type { DiscoveredCheckoutInput } from '../db/repositories/project-repositories.js';
import type { Machine, ProjectMachine, ProjectRepository, RepoStatus } from '../db/repositories/types.js';
import { t, type Locale } from '../i18n/index.js';
import { failure } from '../integrations/github-ci.js';
import { effectiveRepos } from '../setup/repos.js';
import { sameRepo, type ProjectSetupData } from '../setup/schema.js';
import { repoOfOrigin } from './origin.js';

/**
 * Repository discovery (spec 2026-10-07 multi-repo R2–R6, R10, §5): the server asks each machine linked to a
 * project which git checkouts sit in the project's folder, and keeps `project_repositories` and
 * `project_repository_checkouts` current. It only adds rows and marks checkouts gone (never deletes), and
 * nothing automatic acts on what it finds: a discovered repository starts at autonomy `pr` (R6, in
 * `effectiveRepos`). It reads folder names, the `origin` URL, the default branch and one description line —
 * never file contents or terminal output.
 */

/** The automatic triggers scan one project folder per machine at most this often (R3). */
export const SCAN_THROTTLE_MS = 60_000;
/** The loop over projects with automation on or with several repositories (R3). */
export const SCAN_LOOP_MS = 10 * 60_000;
/** An agent that just connected is scanned after this, once its hello and the deploy shuffle settled. */
export const ONLINE_SCAN_DELAY_MS = 20_000;
/** The `names` of a first scan's summary event stay under the event's string cap. */
const NAMES_MAX = 400;

/** Why a link was not scanned. */
export type ScanSkip = 'not_agent' | 'offline' | 'no_repo_scan' | 'throttled' | 'refused' | 'not_found' | 'failed';

/** What one scan of one project folder on one machine did. Names and counts only. */
export interface LinkScan {
  machine_id: string;
  scanned: boolean;
  skipped?: ScanSkip;
  /** the failure's code, when `skipped: failed` */
  error?: string;
  found: number;
  created: string[];
  missing: string[];
  /** further checkouts of a repository already found in this scan (spec §10), by folder */
  duplicates: string[];
  truncated: boolean;
  scanned_at: string | null;
}

/** How discovery reaches the machines and GitHub; tests swap it for a fake agent. */
export interface DiscoveryDeps {
  /** whether this machine can answer `git.repos.scan` now */
  canScan(machine: Machine): 'ok' | 'not_agent' | 'offline' | 'no_repo_scan';
  scan(machine: Machine, params: RpcParams<'git.repos.scan'>): Promise<RpcResult<'git.repos.scan'>>;
  /** `GET /repos/{full_name}` with the integration's token: `unknown` when GitHub could not say (rate limit, outage) */
  repoAccess(token: string, fullName: string): Promise<'ok' | 'no_access' | 'unknown'>;
  now(): number;
  log?: { warn: (o: object, m: string) => void };
}

/** The access check of spec §5 step 4. Only the HTTP status is read; the token is only ever a header. */
export function githubRepoAccess(fetchImpl: typeof fetch = fetch): DiscoveryDeps['repoAccess'] {
  return async (token, fullName) => {
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'termhub', 'x-github-api-version': '2022-11-28' },
      });
      if (res.ok) return 'ok';
      const kind = failure(res).kind;
      return kind === 'not_found' || kind === 'auth' ? 'no_access' : 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

export const defaultDiscoveryDeps: DiscoveryDeps = {
  canScan(machine) {
    if (machine.type !== 'agent') return 'not_agent';
    if (!agents.isOnline(machine.id)) return 'offline';
    return (agents.capabilities(machine.id) ?? []).includes(CAPABILITY_REPO_SCAN) ? 'ok' : 'no_repo_scan';
  },
  scan: (machine, params) => agentRpc(machine, 'git.repos.scan', params),
  repoAccess: githubRepoAccess(),
  now: () => Date.now(),
};

/** Per instance: when each `project:machine` scan last started and last finished here, and the scan going on now. */
const lastScan = new Map<string, number>();
const finishedAt = new Map<string, string>();
const inFlight = new Map<string, Promise<LinkScan>>();

/** Tests only. */
export function resetDiscoveryState(): void {
  lastScan.clear();
  finishedAt.clear();
  inFlight.clear();
}

/**
 * When each linked machine's folder was last scanned (spec §5 step 1): the latest `seen_at` of the project's
 * checkouts there, which every scan that finds something writes (either colour), or this instance's own
 * finished scan when it is later (a scan that found nothing writes no row).
 */
export async function scanTimes(repos: Repositories, projectId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const later = (machineId: string, at: string) => {
    const was = out.get(machineId);
    if (!was || Date.parse(at) > Date.parse(was)) out.set(machineId, at);
  };
  for (const r of await repos.projectRepositories.listByProject(projectId)) for (const c of r.checkouts) later(c.machine_id, c.seen_at);
  for (const [key, at] of finishedAt) if (key.startsWith(`${projectId}:`)) later(key.slice(projectId.length + 1), at);
  return out;
}

const linkKey = (projectId: string, machineId: string) => `${projectId}:${machineId}`;
const skipped = (machineId: string, why: ScanSkip, error?: string): LinkScan => ({
  machine_id: machineId,
  scanned: false,
  skipped: why,
  ...(error ? { error } : {}),
  found: 0,
  created: [],
  missing: [],
  duplicates: [],
  truncated: false,
  scanned_at: null,
});

/** One checkout of the agent's answer as the repository stores it: a non-GitHub origin is `unsupported` (R4). */
function checkoutOf(r: RpcResult<'git.repos.scan'>['repos'][number], cwd: string): DiscoveredCheckoutInput {
  const origin = repoOfOrigin(r.origin);
  const folder = r.dir === '.' ? path.posix.basename(cwd.replace(/\\/g, '/').replace(/\/+$/, '')) || 'repo' : r.dir;
  return {
    // with no origin to name it, the folder does; the `local/` prefix never reads as a GitHub owner
    full_name: origin?.full_name ?? `local/${folder}`,
    dir: r.dir,
    default_branch: r.default_branch,
    has_commits: r.has_commits,
    description: r.description,
    ...(origin?.github ? {} : { status: 'unsupported' as const }),
  };
}

/**
 * The access check (spec §5 step 4) for the repositories this scan created and for those already marked
 * `no_access` (so one the person gave access to recovers). The token is the repository's integration, else
 * the project's (`setup.repo`); it must be a GitHub integration of the project's owner, as the CI sync asks.
 * With no such integration, or when GitHub cannot say, the status stays as it is.
 */
async function checkAccess(repos: Repositories, deps: DiscoveryDeps, ownerId: string | null, setup: ProjectSetupData, rows: ProjectRepository[], createdIds: Set<string>): Promise<void> {
  const list = effectiveRepos(setup, rows);
  const tokens = new Map<string, string | null>();
  const tokenOf = async (integrationId: string): Promise<string | null> => {
    if (!tokens.has(integrationId)) {
      const integration = await repos.integrations.findById(integrationId);
      const allowed = !!integration && integration.provider === 'github' && ownerId !== null && integration.owner_id === ownerId;
      tokens.set(integrationId, allowed ? ((await repos.integrations.getSecret(integrationId)) ?? null) : null);
    }
    return tokens.get(integrationId) ?? null;
  };
  for (const row of rows) {
    if (row.status === 'unsupported' || (!createdIds.has(row.id) && row.status !== 'no_access')) continue;
    const integrationId = list.find((e) => sameRepo(e.full_name, row.full_name))?.integration_id ?? setup.repo?.integration_id ?? null;
    const token = integrationId ? await tokenOf(integrationId) : null;
    if (!token) continue;
    const access = await deps.repoAccess(token, row.full_name);
    const status: RepoStatus | null = access === 'ok' ? 'ok' : access === 'no_access' ? 'no_access' : null;
    if (status && status !== row.status) {
      await repos.projectRepositories.setStatus(row.id, status);
      row.status = status;
    }
  }
}

/** The chat line of one new repository, in the owner's language (R3). */
function newRepoLine(repo: ProjectRepository, level: string): (locale: Locale) => string {
  return (locale) =>
    repo.status === 'unsupported'
      ? t(locale, 'Novo repositório na pasta do projeto: {{repo}} (fora do GitHub, fica de fora do automático).', { repo: repo.full_name })
      : t(locale, 'Novo repositório na pasta do projeto: {{repo}} (nível {{level}}).', { repo: repo.full_name, level });
}

/** The scan itself, once the link may be scanned. */
async function runScan(repos: Repositories, deps: DiscoveryDeps, link: ProjectMachine, machine: Machine): Promise<LinkScan> {
  const projectId = link.project_id;
  const setup = (await repos.projectSetup.get(projectId)).data;
  let answer: RpcResult<'git.repos.scan'>;
  try {
    answer = await deps.scan(machine, { dir: link.cwd, depth: setup.repo_defaults.scan_depth });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const c = typeof code === 'string' ? code : 'FAILED';
    // `/` or the home folder (the agent refuses both), or a folder that is not there
    if (c === 'MACHINE_INVALID') return skipped(machine.id, 'refused', c);
    if (c === 'MACHINE_NOT_FOUND') return skipped(machine.id, 'not_found', c);
    deps.log?.warn({ projectId, machineId: machine.id, code: c }, 'repo discovery: scan failed');
    return skipped(machine.id, 'failed', c);
  }

  const found = answer.repos.map((r) => checkoutOf(r, link.cwd));
  const before = await repos.projectRepositories.listByProject(projectId);
  const { repositories, created, duplicates } = await repos.projectRepositories.upsertDiscovered(projectId, machine.id, found);
  const present = repositories.filter((r) => found.some((f) => sameRepo(f.full_name, r.full_name))).map((r) => r.id);
  // a truncated answer did not look everywhere: what it left out is not gone
  const missing = answer.truncated ? [] : await repos.projectRepositories.markMissing(projectId, machine.id, present);

  const project = await repos.projects.findById(projectId);
  const createdIds = new Set(created.map((r) => r.id));
  await checkAccess(repos, deps, project?.owner_id ?? null, setup, repositories, createdIds);
  const at = new Date(deps.now());
  finishedAt.set(linkKey(projectId, machine.id), at.toISOString());

  // The repository the project already had is not news (spec §3.1), and neither is the folder of a project
  // whose first scan finds one repository: a single-repo project sees nothing, with or without `setup.repo`.
  const first = before.length === 0;
  const news = first && repositories.length < 2 ? [] : repositories.filter((r) => createdIds.has(r.id) && !sameRepo(r.full_name, setup.repo?.full_name));
  const levels = effectiveRepos(setup, repositories);
  const levelOf = (r: ProjectRepository) => levels.find((e) => sameRepo(e.full_name, r.full_name))?.autonomy ?? 'pr';
  const where = { machine_id: machine.id, machine: machine.name };
  if (first && news.length > 1) {
    // a project's first scan: one summary, not one line per repository (R3)
    const names = news.map((r) => r.full_name).join(', ');
    const shown = names.length > NAMES_MAX ? `${names.slice(0, NAMES_MAX - 1)}…` : names;
    await recordEvent(repos, { project_id: projectId, kind: 'repo_discovered', payload: { first_scan: true, count: news.length, names: shown, ...where } });
    await postAutomationLine(
      repos,
      projectId,
      (locale) => t(locale, '{{n}} repositórios encontrados na pasta do projeto: {{names}}. Cada um começa no nível pr; ajuste em Setup.', { n: news.length, names: shown }),
      deps.log,
    );
  } else {
    for (const r of news) {
      await recordEvent(repos, { project_id: projectId, kind: 'repo_discovered', payload: { full_name: r.full_name, key: r.key, autonomy: levelOf(r), status: r.status, ...where } });
      await postAutomationLine(repos, projectId, newRepoLine(r, levelOf(r)), deps.log);
    }
  }
  for (const r of missing) {
    await recordEvent(repos, { project_id: projectId, kind: 'repo_missing', payload: { full_name: r.full_name, key: r.key, ...where } });
  }

  return {
    machine_id: machine.id,
    scanned: true,
    found: found.length,
    created: created.map((r) => r.full_name),
    missing: missing.map((r) => r.full_name),
    duplicates: duplicates.map((d) => d.dir),
    truncated: answer.truncated,
    scanned_at: at.toISOString(),
  };
}

/**
 * Scans one project folder on one machine. The automatic triggers (`force` off) scan a link at most once per
 * `SCAN_THROTTLE_MS`, by this instance's map and by the checkouts' `seen_at`, which the other colour writes too;
 * an on-demand scan (`force`) skips the throttle but shares a scan already going on. Two colours scanning at
 * once is harmless: the upsert is idempotent and hands out keys under the project lock. Never throws for a
 * machine problem: the result says why it was skipped.
 */
export async function scanLink(repos: Repositories, link: ProjectMachine, opts: { force?: boolean } = {}, deps: DiscoveryDeps = defaultDiscoveryDeps): Promise<LinkScan> {
  const machine = await repos.machines.findById(link.machine_id);
  if (!machine) return skipped(link.machine_id, 'not_agent');
  const can = deps.canScan(machine);
  if (can !== 'ok') return skipped(machine.id, can);
  const key = linkKey(link.project_id, machine.id);
  const going = inFlight.get(key);
  if (going) return going;
  if (!opts.force) {
    const now = deps.now();
    if (now - (lastScan.get(key) ?? 0) < SCAN_THROTTLE_MS) return skipped(machine.id, 'throttled');
    // claimed before the read below, so two triggers at once here do not both scan
    lastScan.set(key, now);
    const seen = (await scanTimes(repos, link.project_id)).get(machine.id);
    if (seen && now - Date.parse(seen) < SCAN_THROTTLE_MS) return skipped(machine.id, 'throttled');
    const started = inFlight.get(key);
    if (started) return started;
  }
  lastScan.set(key, deps.now());
  const run = runScan(repos, deps, link, machine).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/** Scans a project's folder on every linked machine (one at a time: a scan is a `readdir` and a few `git` calls). */
export async function scanProject(repos: Repositories, projectId: string, opts: { force?: boolean } = {}, deps: DiscoveryDeps = defaultDiscoveryDeps): Promise<LinkScan[]> {
  const out: LinkScan[] = [];
  for (const link of await repos.projectMachines.listByProject(projectId)) out.push(await scanLink(repos, link, opts, deps));
  return out;
}

/** The Setup screen opened (R3): a throttled scan in the background; the screen does not wait for it. */
export function scanOnSetupOpen(repos: Repositories, projectId: string, deps: DiscoveryDeps = defaultDiscoveryDeps): void {
  void scanProject(repos, projectId, {}, deps).catch((err: unknown) => deps.log?.warn({ projectId, err: err instanceof Error ? err.message : String(err) }, 'repo discovery: setup scan failed'));
}

/** The projects the 10-minute loop scans (R3): automation on, or more than one repository. */
export async function loopProjects(repos: Repositories): Promise<string[]> {
  const [auto, several] = await Promise.all([repos.projectSetup.listWithAutomation(), repos.projectRepositories.projectsWithSeveral()]);
  return [...new Set([...auto.filter((s) => s.data.automation.enabled).map((s) => s.project_id), ...several])];
}

/**
 * Starts discovery's automatic triggers (R3): an agent that connects (each of its project folders, after a
 * short delay), and the 10-minute loop. A draining colour starts nothing (`active`). Returns the stop.
 */
export function startRepoDiscovery(repos: Repositories, log: { warn: (o: object, m: string) => void }, active: () => boolean = () => true, deps: DiscoveryDeps = { ...defaultDiscoveryDeps, log }): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const report = (what: string) => (err: unknown) => log.warn({ err: err instanceof Error ? err.message : String(err) }, `repo discovery: ${what} failed`);
  const onOnline = (machineId: string, hello?: { capabilities?: string[] }) => {
    if (hello?.capabilities && !hello.capabilities.includes(CAPABILITY_REPO_SCAN)) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!active()) return;
      void (async () => {
        for (const link of await repos.projectMachines.listByMachine(machineId)) await scanLink(repos, link, {}, deps);
      })().catch(report('connect scan'));
    }, ONLINE_SCAN_DELAY_MS);
    timer.unref();
    timers.add(timer);
  };
  agents.on('online', onOnline);
  let looping = false;
  const loop = setInterval(() => {
    if (looping || !active()) return;
    looping = true;
    void (async () => {
      for (const projectId of await loopProjects(repos)) await scanProject(repos, projectId, {}, deps);
    })()
      .catch(report('loop'))
      .finally(() => {
        looping = false;
      });
  }, SCAN_LOOP_MS);
  loop.unref();
  return () => {
    agents.off('online', onOnline);
    clearInterval(loop);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
