import type { FastifyBaseLogger } from 'fastify';
import type { PaneForeground } from '@termhub/machine-ops';
import { agents } from '../../agent/registry.js';
import { captureScreen } from '../../agent/screen.js';
import { lastRoomOf, type RoomReading } from '../../automation/machine-room.js';
import { recordEvent } from '../../automation/events.js';
import { failureLabel } from '../../chat/service.js';
import { controlContextFor, type ControlContext } from '../../control/context.js';
import { closeTab as closeTabFn } from '../../control/terminals.js';
import type { Repositories } from '../../db/repositories/index.js';
import type { GcTab } from '../../db/repositories/tab-gc.js';
import type { Machine } from '../../db/repositories/types.js';
import { isEnabled } from '../../features/flags.js';
import { paneForeground } from '../../terminal/session-ops.js';
import { probeTmuxSessions, type TmuxProbe } from '../../terminal/machine-exec.js';
import { NO_ROOM_CLOSE_PER_SWEEP, quiet, roomShort } from '../idle-tabs.js';
import { classifyTab, type GcFacts, type GcPressure, type GcReason, type SessionPresence } from './classify.js';
import { resolveGcConfig, type TabGcConfig } from './config.js';

/*
 * TER-1171: one pass of the agent tab GC (spec docs/superpowers/specs/2026-11-11-agent-tab-gc-design.md).
 * Gathers the facts of each agent tab, classifies it (classify.ts), and — by mode — only reports (`plan`),
 * records what it would do without touching any tab (`dry`), or warns, keeps and collects for real (`live`).
 * Logs ids, states, reasons and counts only, never the screen nor an answer.
 */

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export type GcMode = 'plan' | 'dry' | 'live';

/** How often the job runs (the TER-1138 interval). */
export const TAB_GC_SWEEP_MS = 10 * 60_000;

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

export interface TabGcDeps {
  foreground: (machine: Machine, session: string) => Promise<PaneForeground | null>;
  capture: (machine: Machine, session: string, lines: number) => Promise<string>;
  isOnline: (machineId: string) => boolean;
  probe: (machine: Machine) => Promise<TmuxProbe>;
  room: (machineId: string) => RoomReading | null;
  closeTab: (ctx: ControlContext, tabId: string) => Promise<void>;
  /** the owner's flags: `tab_gc` (the GC runs for them) and `tab_gc_live` (it closes for real) */
  flags: (repos: Repositories, ownerId: string) => Promise<{ on: boolean; live: boolean }>;
}

export const defaultTabGcDeps: TabGcDeps = {
  foreground: (machine, session) => paneForeground(machine, session).catch(() => null),
  capture: captureScreen,
  isOnline: (id) => agents.isOnline(id),
  probe: probeTmuxSessions,
  room: lastRoomOf,
  closeTab: async (ctx, tabId) => void (await closeTabFn(ctx, { tab_id: tabId, force: true })),
  flags: async (repos, userId) => {
    const [on, live] = await Promise.all([isEnabled('tab_gc', { repos, userId }), isEnabled('tab_gc_live', { repos, userId })]);
    return { on, live };
  },
};

/** What the pass did (or, in `plan`, would do) with one tab. */
export type GcStep = 'keep' | 'warn' | 'warned' | 'collect' | 'remove';

export interface GcItem {
  tab_id: string;
  tab: string;
  project_id: string;
  machine_id: string;
  machine: string | null;
  state: string | null;
  tool: string | null;
  /** the linked card's id, if any */
  task_id: string | null;
  step: GcStep;
  reason: GcReason;
  /** hours at rest by the GC's clock, when the rule looked at time */
  rest_hours: number | null;
  /** when a warned tab will be collected (ISO); null when not warned */
  closes_at: string | null;
}

export interface GcResult {
  mode: GcMode;
  items: GcItem[];
  warned: number;
  kept: number;
  collected: number;
  removed: number;
}

export interface GcRunOptions {
  mode: GcMode;
  now?: Date;
  scope?: { ownerId?: string; projectId?: string; machineId?: string };
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

/** Per-pass caches: one machine lookup, tmux probe and tab count per machine; one setup per project; one level per person. */
class PassCache {
  private machines = new Map<string, Promise<{ machine: Machine | undefined; level: unknown; idle_hours: number | null }>>();
  private probes = new Map<string, Promise<TmuxProbe>>();
  private counts = new Map<string, Promise<number>>();
  private projects = new Map<string, Promise<unknown>>();
  private users = new Map<string, Promise<unknown>>();
  /** pressure collections left this pass, per machine */
  readonly budget = new Map<string, number>();

  constructor(private repos: Repositories, private deps: TabGcDeps) {}

  machine(id: string) {
    if (!this.machines.has(id)) {
      this.machines.set(id, (async () => {
        const [machine, lvl] = await Promise.all([this.repos.machines.findById(id), this.repos.tabGc.machineLevel(id)]);
        return { machine, level: lvl.level, idle_hours: lvl.idle_hours };
      })());
    }
    return this.machines.get(id)!;
  }

  probe(machine: Machine) {
    if (!this.probes.has(machine.id)) this.probes.set(machine.id, this.deps.probe(machine).catch((): TmuxProbe => ({ reachable: false, sessions: new Set() })));
    return this.probes.get(machine.id)!;
  }

  agentTabCount(machineId: string) {
    if (!this.counts.has(machineId)) this.counts.set(machineId, this.repos.tabGc.listAgentTabs({ machineId }).then((t) => t.length));
    return this.counts.get(machineId)!;
  }

  projectLevel(projectId: string) {
    if (!this.projects.has(projectId)) this.projects.set(projectId, this.repos.projectSetup.get(projectId).then((s) => s.data.tab_gc ?? null).catch(() => null));
    return this.projects.get(projectId)!;
  }

  userLevel(userId: string) {
    if (!this.users.has(userId)) this.users.set(userId, this.repos.tabGc.userLevel(userId).catch(() => null));
    return this.users.get(userId)!;
  }
}

function presenceOf(probe: TmuxProbe, session: string): SessionPresence {
  if (!probe.reachable) return 'unknown';
  return probe.sessions.has(session) ? 'alive' : 'gone';
}

/**
 * The pressure on the tab's machine and whether this tab may still use it: over its cap (by the tab's
 * resolved `max_agent_tabs`) or short of room (TER-1138), with a budget of NO_ROOM_CLOSE_PER_SWEEP per pass.
 */
async function pressureOf(cache: PassCache, deps: TabGcDeps, machine: Machine, cfg: TabGcConfig, now: Date): Promise<GcPressure> {
  if ((cache.budget.get(machine.id) ?? NO_ROOM_CLOSE_PER_SWEEP) <= 0) return null;
  if (cfg.max_agent_tabs !== null && (await cache.agentTabCount(machine.id)) > cfg.max_agent_tabs) return 'over_cap';
  if (roomShort(deps.room(machine.id), now)) return 'no_room';
  return null;
}

/**
 * One pass. Tabs are taken oldest state first, so under pressure the oldest idle ones go first. Never throws
 * for one tab. In `live` and `dry`, owners with `tab_gc` off are skipped; `dry` is forced for owners without
 * `tab_gc_live`. `plan` reports for every owner in scope and writes nothing.
 */
export async function runTabGc(repos: Repositories, log: Log, opts: GcRunOptions, deps: TabGcDeps = defaultTabGcDeps): Promise<GcResult> {
  const now = opts.now ?? new Date();
  const result: GcResult = { mode: opts.mode, items: [], warned: 0, kept: 0, collected: 0, removed: 0 };
  const tabs = await repos.tabGc.listAgentTabs(opts.scope ?? {});
  const cache = new PassCache(repos, deps);
  const ownerModes = new Map<string, GcMode | null>();

  for (const tab of tabs) {
    try {
      if (!tab.owner_id) continue;
      if (!ownerModes.has(tab.owner_id)) {
        if (opts.mode === 'plan') ownerModes.set(tab.owner_id, 'plan');
        else {
          const f = await deps.flags(repos, tab.owner_id);
          ownerModes.set(tab.owner_id, !f.on ? null : opts.mode === 'live' && f.live ? 'live' : 'dry');
        }
      }
      const mode = ownerModes.get(tab.owner_id);
      if (!mode) continue;
      const item = await handleTab(repos, log, deps, cache, tab, mode, now);
      if (!item) continue;
      result.items.push(item);
      if (item.step === 'warn') result.warned++;
      if (item.step === 'collect') result.collected++;
      if (item.step === 'remove') result.removed++;
    } catch (err) {
      log.warn({ tabId: tab.id, code: failureLabel(err) }, 'tab gc: tab check failed');
    }
  }
  result.kept = result.items.filter((i) => i.step === 'keep').length;
  if (opts.mode !== 'plan' && (result.warned || result.collected || result.removed)) {
    log.info({ mode: opts.mode, tabs: tabs.length, warned: result.warned, collected: result.collected, removed: result.removed }, 'tab gc: pass');
  }
  return result;
}

async function handleTab(repos: Repositories, log: Log, deps: TabGcDeps, cache: PassCache, tab: GcTab, mode: GcMode, now: Date): Promise<GcItem | null> {
  const m = await cache.machine(tab.machine_id);
  const machine = m.machine;
  if (!machine) return null;
  const cfg = resolveGcConfig({ user: await cache.userLevel(tab.owner_id!), project: await cache.projectLevel(tab.project_id), machine: m.level, machineIdleHours: m.idle_hours });
  const item = (step: GcStep, reason: GcReason, rest_ms: number | null = null, closes_at: string | null = null): GcItem => ({
    tab_id: tab.id,
    tab: tab.name,
    project_id: tab.project_id,
    machine_id: machine.id,
    machine: machine.name,
    state: tab.state,
    tool: tab.state_tool,
    task_id: tab.task?.id ?? null,
    step,
    reason,
    rest_hours: rest_ms === null ? null : Math.floor(rest_ms / HOUR),
    closes_at,
  });

  if (!cfg.enabled) return dropWarning(repos, log, tab, mode, item('keep', 'disabled'));

  const reachable = machine.type !== 'agent' || deps.isOnline(machine.id);
  const session: SessionPresence = reachable ? presenceOf(await cache.probe(machine), tab.tmux_session) : 'unknown';
  const facts: GcFacts = {
    agent: true,
    pinned: tab.gc_pinned,
    machineReachable: reachable,
    session,
    runActive: false, // looked up below, only for a candidate (one query per candidate, not per tab)
    rateLimited: !!tab.rate_limited_at,
    state: tab.state,
    cardStatus: tab.task?.status ?? null,
    stateAt: ms(tab.state_at),
    lastEventAt: ms(tab.last_event_at),
    resetAt: ms(tab.gc_reset_at),
  };
  const pressure = await pressureOf(cache, deps, machine, cfg, now);
  let verdict = classifyTab(facts, cfg, now.getTime(), pressure);

  if (verdict.action === 'remove') {
    if (mode === 'plan') return item('remove', verdict.reason);
    if (mode === 'dry') {
      // reported once per X: the clock restarts as if it had been removed
      const reset = ms(tab.gc_reset_at);
      if (reset !== null && now.getTime() - reset < cfg.idle_hours * HOUR) return item('keep', 'recent');
      await repos.tabGc.reset(tab.id, now);
      await collectedEvent(repos, log, tab, machine, verdict.reason, null, null, true);
      return item('remove', verdict.reason);
    }
    await collect(repos, log, deps, tab, machine, verdict.reason, null);
    return item('remove', verdict.reason);
  }

  if (verdict.action === 'candidate') {
    if (await repos.automationRuns.activeByTab(tab.id)) verdict = { action: 'keep', reason: 'run_active', rest_ms: verdict.rest_ms };
    else if (!(await quiet(repos, deps, tab, machine))) verdict = { action: 'keep', reason: 'not_quiet', rest_ms: verdict.rest_ms };
  }
  if (verdict.action === 'keep') return dropWarning(repos, log, tab, mode, item('keep', verdict.reason, verdict.rest_ms));

  // a candidate: warn, wait the grace period, collect
  const usesBudget = verdict.reason === 'over_cap' || verdict.reason === 'no_room';
  const spend = () => usesBudget && cache.budget.set(machine.id, (cache.budget.get(machine.id) ?? NO_ROOM_CLOSE_PER_SWEEP) - 1);
  const grace = cfg.grace_minutes * MINUTE;
  const warnedAt = ms(tab.gc_warned_at);

  if (mode === 'dry') {
    // nothing is marked in a dry run: one would-be collection, then the clock restarts
    spend();
    await repos.tabGc.reset(tab.id, now);
    await collectedEvent(repos, log, tab, machine, verdict.reason, verdict.rest_ms, null, true);
    return item('collect', verdict.reason, verdict.rest_ms);
  }
  if (warnedAt === null) {
    if (mode === 'plan') return item('warn', verdict.reason, verdict.rest_ms, new Date(now.getTime() + grace).toISOString());
    spend();
    if (!(await repos.tabGc.warn(tab.id, now, tab.state_at ? new Date(tab.state_at) : null))) return item('warned', verdict.reason, verdict.rest_ms);
    await event(repos, log, tab, 'tab_gc_warned', {
      tab_id: tab.id, tab: tab.name, machine_id: machine.id, machine: machine.name, tool: tab.state_tool, state: tab.state,
      reason: verdict.reason, hours: Math.floor((verdict.rest_ms ?? 0) / HOUR), minutes: cfg.grace_minutes, dry_run: false,
    });
    return item('warn', verdict.reason, verdict.rest_ms, new Date(now.getTime() + grace).toISOString());
  }
  if (tab.gc_warned_state_at !== tab.state_at) {
    // the agent ran again since the warning: start over
    if (mode === 'live' && (await repos.tabGc.clearWarning(tab.id))) await event(repos, log, tab, 'tab_gc_kept', { tab_id: tab.id, tab: tab.name, why: 'activity' });
    return item('keep', 'recent', verdict.rest_ms);
  }
  const closesAt = new Date(warnedAt + grace).toISOString();
  if (now.getTime() - warnedAt < grace) return item('warned', verdict.reason, verdict.rest_ms, closesAt);
  if (mode === 'plan') return item('collect', verdict.reason, verdict.rest_ms, closesAt);
  spend();
  await collect(repos, log, deps, tab, machine, verdict.reason, verdict.rest_ms);
  return item('collect', verdict.reason, verdict.rest_ms, closesAt);
}

/** A kept tab that carried a warning: the warning goes (live only) and the feed says why. */
async function dropWarning(repos: Repositories, log: Log, tab: GcTab, mode: GcMode, item: GcItem): Promise<GcItem> {
  if (mode !== 'live' || !tab.gc_warned_at) return item;
  if (await repos.tabGc.clearWarning(tab.id)) {
    const why = item.reason === 'pinned' ? 'pinned' : item.reason === 'disabled' ? 'disabled' : 'activity';
    await event(repos, log, tab, 'tab_gc_kept', { tab_id: tab.id, tab: tab.name, why });
  }
  return item;
}

/**
 * Collects a tab for real: keeps the agent's last answer and the tab's metadata in the archive, closes the
 * tab as the project's owner (kills tmux, removes the row) and records `tab_collected`. The answer is read
 * before the close, which deletes it with the row.
 */
async function collect(repos: Repositories, log: Log, deps: TabGcDeps, tab: GcTab, machine: Machine, reason: GcReason, rest_ms: number | null): Promise<void> {
  const owner = tab.owner_id ? await repos.users.findById(tab.owner_id) : undefined;
  if (!owner) return;
  const answer = await repos.tabs.readLastAnswer(tab.id).catch(() => null);
  await deps.closeTab(controlContextFor(repos, owner), tab.id);
  const archive = await repos.tabGc
    .archive({
      project_id: tab.project_id,
      task_id: tab.task?.id ?? null,
      tab_id: tab.id,
      tab_name: tab.name,
      machine_id: machine.id,
      machine_name: machine.name,
      tool: tab.state_tool,
      state: tab.state,
      reason,
      agent_session_id: tab.agent_session_id,
      cwd: tab.cwd,
      last_answer: answer?.text ?? null,
      last_answer_at: answer?.at ?? null,
    })
    .catch((e: unknown) => {
      log.warn({ tabId: tab.id, code: failureLabel(e) }, 'tab gc: archive not written');
      return null;
    });
  log.info({ tabId: tab.id, machineId: machine.id, state: tab.state, tool: tab.state_tool, reason }, 'tab gc: tab collected');
  await collectedEvent(repos, log, tab, machine, reason, rest_ms, archive?.id ?? null, false);
}

async function collectedEvent(repos: Repositories, log: Log, tab: GcTab, machine: Machine, reason: GcReason, rest_ms: number | null, archiveId: string | null, dry: boolean): Promise<void> {
  await event(repos, log, tab, 'tab_collected', {
    tab_id: tab.id, tab: tab.name, machine_id: machine.id, machine: machine.name, tool: tab.state_tool, state: tab.state, reason,
    hours: rest_ms === null ? null : Math.floor(rest_ms / HOUR), archive_id: archiveId, session_id: tab.agent_session_id, dry_run: dry,
  });
}

async function event(repos: Repositories, log: Log, tab: GcTab, kind: 'tab_gc_warned' | 'tab_gc_kept' | 'tab_collected', payload: Record<string, string | number | boolean | null>): Promise<void> {
  await recordEvent(repos, { project_id: tab.project_id, task_id: tab.task?.id ?? null, kind, payload }).catch((e: unknown) => log.warn({ tabId: tab.id, kind, code: failureLabel(e) }, 'tab gc: event not recorded'));
}

/** Runs the GC every TAB_GC_SWEEP_MS, one pass at a time. Returns the stop function. */
export function startTabGc(repos: Repositories, log: Log): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runTabGc(repos, log, { mode: 'live' })
      .catch((err) => log.warn({ code: failureLabel(err) }, 'tab gc: pass failed'))
      .finally(() => (running = false));
  }, TAB_GC_SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
