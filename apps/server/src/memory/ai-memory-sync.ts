import type { FastifyBaseLogger } from 'fastify';
import { buildAiMemoryRulesScript, parseAiMemorySync, type AiMemorySyncInput } from '@termhub/machine-ops';
import { agentRpc, versionAtLeast } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import { memoryCode } from '../chat/embeddings.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { runOnMachineWithInput, shellQuote } from '../terminal/machine-exec.js';
import { aiMemoryUrlOf } from './ai-memory.js';
import { planSync, rulePages, type RulePage } from './ai-memory-rules.js';
import { RULES_LIMIT, ruleOf } from './current-rules.js';

/**
 * Current rules as pinned ai-memory pages (TER-1019, spec 2026-10-07 ai-memory rules): keeps the
 * `_rules/termhub-*.md` pages of each checkout of a project in step with `currentRules`, through the
 * `ai-memory` CLI on the machine. Opt-in per project (`setup.ai_memory.publish_rules`); a machine takes
 * part only when the checkout already has an `.ai-memory.toml` marker and the binary is on the PATH.
 * Logs carry ids, counts and codes only, never a rule's text or the script's output.
 */

/** First agent release that answers `ai_memory.rules.sync`. An older agent is skipped. */
export const AI_MEMORY_MIN_AGENT_VERSION = '0.23.0';
/** How often the sweeper syncs every project (catches expired rules and machines that came back). */
export const AI_MEMORY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** A checkout that answered "no ai-memory here" (no marker, no binary, no cwd) is not asked again for this long,
 *  unless the sync is `fresh` (the project setup was just saved). */
export const AI_MEMORY_SKIP_BACKOFF_MS = 60 * 60 * 1000;
/** One run deletes at most this many pages (the RPC's own cap); the rest go on the next run. */
const DELETES_PER_RUN = 64;
const SCRIPT_TIMEOUT_MS = 60_000;

/**
 * The ai-memory server a machine's CLI talks to: the machine's own server URL (TER-1018, Máquinas), else
 * ai-memory's default loopback one. TER-1018's "Usar ai-memory nesta máquina" flag only gates the
 * detection for now, so it does not gate publishing: the checkout's marker does.
 */
export function aiMemoryServerUrl(machine: Machine): string {
  return aiMemoryUrlOf(machine);
}

/** How the sync reaches a checkout. `sync` returns the script's raw stdout and throws (an `HttpError`
 *  with a `code`, ideally) when the machine cannot be reached. */
export interface AiMemoryExec {
  /** `ok`, or the code to log when the machine is not asked at all. */
  reach(machine: Machine): 'ok' | 'AGENT_OFFLINE' | 'AGENT_OUTDATED';
  sync(machine: Machine, input: AiMemorySyncInput): Promise<string>;
}

export const machineAiMemoryExec: AiMemoryExec = {
  reach(machine) {
    if (machine.type !== 'agent') return 'ok';
    if (!agents.isOnline(machine.id)) return 'AGENT_OFFLINE';
    const version = agents.info(machine.id)?.agent_version ?? machine.agent_version;
    return version && versionAtLeast(version, AI_MEMORY_MIN_AGENT_VERSION) ? 'ok' : 'AGENT_OUTDATED';
  },
  async sync(machine, input) {
    if (machine.type === 'agent') return (await agentRpc(machine, 'ai_memory.rules.sync', input)).stdout;
    const script = buildAiMemoryRulesScript(input);
    // Over ssh the remote command goes to the user's login shell, which may not be POSIX (fish): `sh -c` there too.
    const r = await runOnMachineWithInput(machine, { file: 'sh', args: ['-c', script] }, `sh -c ${shellQuote(script)}`, Buffer.alloc(0), SCRIPT_TIMEOUT_MS);
    if (r.timedOut) throw new HttpError(504, 'A máquina demorou para responder', 'MACHINE_TIMEOUT');
    if (r.code !== 0) throw new HttpError(502, 'Máquina inacessível', 'MACHINE_UNREACHABLE');
    return r.stdout;
  },
};

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface AiMemorySyncDeps {
  log: Log;
  exec?: AiMemoryExec;
  serverUrl?: (machine: Machine) => string;
  /** Ignore the no-ai-memory backoff (the setup was just saved). */
  fresh?: boolean;
  now?: () => number;
}

export interface AiMemorySyncSummary {
  written: number;
  deleted: number;
  /** checkouts the script ran in */
  ran: number;
}

/** `${machineId}\0${cwd}` → until when a checkout without ai-memory is left alone. */
const skipUntil = new Map<string, number>();
/** Test hook. */
export function clearAiMemorySkips(): void {
  skipUntil.clear();
}

interface Target {
  machineId: string;
  cwd: string;
  linked: boolean;
  published: { path: string; hash: string }[];
}

/**
 * Syncs one project's rule pages in every checkout it has (each linked machine's cwd) and in every
 * checkout it still has pages in but no longer uses (an unlinked machine, a changed cwd: deletes only).
 * Writes only new or changed pages, deletes the ones no longer current (or all of them when the option is
 * off), and runs nothing where nothing changed. An offline or outdated agent, an unreachable machine or a
 * checkout without ai-memory is skipped with a logged code; the table follows what the script reports
 * done. A checkout that cannot hold ai-memory pages at all (`skip …`) with only deletes pending has its
 * rows dropped — there is nothing left there to delete. Repository failures propagate.
 */
export async function syncAiMemoryRules(repos: Pick<Repositories, 'projects' | 'projectSetup' | 'projectMachines' | 'machines' | 'memoryItems' | 'aiMemoryPages'>, projectId: string, deps: AiMemorySyncDeps): Promise<AiMemorySyncSummary> {
  const summary: AiMemorySyncSummary = { written: 0, deleted: 0, ran: 0 };
  const exec = deps.exec ?? machineAiMemoryExec;
  const serverUrl = deps.serverUrl ?? aiMemoryServerUrl;
  const now = deps.now ?? Date.now;
  const project = await repos.projects.findById(projectId);
  if (!project) return summary;
  const setup = (await repos.projectSetup.get(projectId)).data;
  const enabled = setup.ai_memory.publish_rules && !!project.owner_id;
  // Read directly (not `currentRules`, which turns a failed read into "no rules"): a failed read must
  // never look like "every rule is gone" and delete every page.
  const wanted: RulePage[] = enabled ? rulePages((await repos.memoryItems.currentNotes(project.owner_id!, projectId, RULES_LIMIT)).map(ruleOf)) : [];

  const targets = new Map<string, Target>();
  const keyOf = (machineId: string, cwd: string) => `${machineId}\u0000${cwd}`;
  for (const link of await repos.projectMachines.listByProject(projectId)) {
    targets.set(keyOf(link.machine_id, link.cwd), { machineId: link.machine_id, cwd: link.cwd, linked: true, published: [] });
  }
  for (const row of await repos.aiMemoryPages.listByProject(projectId)) {
    const key = keyOf(row.machine_id, row.cwd);
    const t = targets.get(key) ?? { machineId: row.machine_id, cwd: row.cwd, linked: false, published: [] };
    t.published.push({ path: row.path, hash: row.hash });
    targets.set(key, t);
  }

  for (const [key, t] of targets) {
    const plan = planSync(t.linked ? wanted : [], t.published);
    const deletes = plan.deletes.slice(0, DELETES_PER_RUN);
    if (plan.writes.length === 0 && deletes.length === 0) continue;
    const base = { projectId, machineId: t.machineId };
    if (!deps.fresh && (skipUntil.get(key) ?? 0) > now()) continue;
    const machine = await repos.machines.findById(t.machineId);
    if (!machine) continue; // its rows go with it (cascade)
    const reach = exec.reach(machine);
    if (reach !== 'ok') {
      deps.log.info({ ...base, code: reach }, 'ai-memory rules skipped for a machine');
      continue;
    }
    let stdout: string;
    try {
      stdout = await exec.sync(machine, {
        cwd: t.cwd,
        server_url: serverUrl(machine),
        writes: plan.writes.map(({ path, title, body }) => ({ path, title, body })),
        deletes,
      });
    } catch (err) {
      deps.log.info({ ...base, code: memoryCode(err) }, 'ai-memory rules skipped for a machine');
      continue;
    }
    summary.ran++;
    const outcome = parseAiMemorySync(stdout);
    if (outcome.skip) {
      if (plan.writes.length === 0) await repos.aiMemoryPages.remove(projectId, t.machineId, t.cwd, deletes);
      else skipUntil.set(key, now() + AI_MEMORY_SKIP_BACKOFF_MS);
      deps.log.info({ ...base, code: `AI_MEMORY_${outcome.skip.toUpperCase()}`, dropped: plan.writes.length === 0 ? deletes.length : 0 }, 'ai-memory rules skipped for a machine');
      continue;
    }
    skipUntil.delete(key);
    const byPath = new Map(plan.writes.map((w) => [w.path, w]));
    for (const path of outcome.written) {
      const page = byPath.get(path);
      if (page) await repos.aiMemoryPages.upsert({ project_id: projectId, machine_id: t.machineId, cwd: t.cwd, path, hash: page.hash });
    }
    const deleted = outcome.deleted.filter((p) => deletes.includes(p));
    await repos.aiMemoryPages.remove(projectId, t.machineId, t.cwd, deleted);
    summary.written += outcome.written.length;
    summary.deleted += deleted.length;
    deps.log.info({ ...base, written: outcome.written.length, deleted: deleted.length, failed: outcome.failed, briefing: outcome.briefing }, 'ai-memory rules synced');
  }
  return summary;
}

type SyncRepos = Parameters<typeof syncAiMemoryRules>[0];

/** Per project: the run in flight, and whether another was asked for meanwhile. */
const inFlight = new Map<string, { promise: Promise<void>; rerun: boolean; fresh: boolean }>();

/**
 * Runs `syncAiMemoryRules` for the project, one run at a time per project: a call while one is running
 * asks for one more run right after it (with the newest state), and returns the same promise. Never
 * rejects: a failure is logged with its code.
 */
export function runAiMemoryRules(repos: SyncRepos, projectId: string, deps: AiMemorySyncDeps): Promise<void> {
  const current = inFlight.get(projectId);
  if (current) {
    current.rerun = true;
    current.fresh ||= !!deps.fresh;
    return current.promise;
  }
  const state = { promise: Promise.resolve(), rerun: false, fresh: !!deps.fresh };
  state.promise = (async () => {
    try {
      do {
        const fresh = state.fresh;
        state.rerun = false;
        state.fresh = false;
        try {
          await syncAiMemoryRules(repos, projectId, { ...deps, fresh });
        } catch (err) {
          deps.log.warn({ projectId, code: memoryCode(err) }, 'ai-memory rules sync failed');
        }
      } while (state.rerun);
    } finally {
      inFlight.delete(projectId);
    }
  })();
  inFlight.set(projectId, state);
  return state.promise;
}

/** Fire and forget after a project's rules or setup changed: never blocks, never throws. */
export function nudgeAiMemoryRules(repos: SyncRepos, projectId: string, log: Log, opts: { fresh?: boolean; exec?: AiMemoryExec } = {}): void {
  void runAiMemoryRules(repos, projectId, { log, ...opts });
}

/** The projects the sync has anything to do for: the option on, or pages still published. */
async function projectsToSync(repos: Pick<Repositories, 'projectSetup' | 'aiMemoryPages'>): Promise<Set<string>> {
  return new Set([...(await repos.projectSetup.listWithAiMemoryRules()), ...(await repos.aiMemoryPages.projectIds())]);
}

/**
 * After an account-wide rule changed (a `record_decision` with no project, a mark on the Memória screen):
 * nudges each of the owner's projects that publishes rules or still has pages. Fire and forget.
 */
export function nudgeAiMemoryRulesForOwner(repos: SyncRepos & Pick<Repositories, 'aiMemoryPages'>, ownerId: string, log: Log, opts: { exec?: AiMemoryExec } = {}): void {
  void (async () => {
    try {
      const candidates = await projectsToSync(repos);
      if (candidates.size === 0) return;
      for (const p of await repos.projects.list({ owner: ownerId })) {
        if (p.owner_id === ownerId && candidates.has(p.id)) nudgeAiMemoryRules(repos, p.id, log, opts);
      }
    } catch (err) {
      log.warn({ code: memoryCode(err) }, 'ai-memory rules nudge failed');
    }
  })();
}

/**
 * Every `intervalMs` (and once at start), syncs each project that publishes rules or still has pages, one
 * after the other. Catches what no nudge sees: a rule that expired, a machine that came back online, a
 * link added or removed. The timer is `unref`'d; returns the stop function.
 */
export function startAiMemoryRulesSweeper(repos: Repositories, log: Log, intervalMs = AI_MEMORY_SWEEP_INTERVAL_MS, exec?: AiMemoryExec): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const projectId of await projectsToSync(repos)) await runAiMemoryRules(repos, projectId, { log, exec });
    } catch (err) {
      log.warn({ code: memoryCode(err) }, 'ai-memory rules sweep failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
