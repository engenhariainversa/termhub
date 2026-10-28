import type { FastifyBaseLogger } from 'fastify';
import type { PaneForeground } from '@termhub/machine-ops';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import { lastRoomOf, type RoomReading } from '../automation/machine-room.js';
import { recordEvent } from '../automation/events.js';
import { AGENT_EXITED_TEXT } from '../chat/agent-exited.js';
import { failureLabel } from '../chat/service.js';
import { controlContextFor, type ControlContext } from '../control/context.js';
import { closeTab as closeTabFn } from '../control/terminals.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { paneForeground } from '../terminal/session-ops.js';
import { SCREEN_STATE_LINES, claudeScreenState } from './screen-state.js';
import { classifyTurnEnd } from './turn-end.js';

/*
 * TER-1138: agent tabs left at rest for long are closed by themselves, on the machines whose owner set
 * "Fechar abas paradas" (`machines.idle_tab_close_hours`, off by default). Every tab counts — opened by hand,
 * by start_agent, "Start session" or an automatic run — as long as an agent reported its state there: a plain
 * shell never did, and is never touched. Closing kills the tmux session and removes the tab, as close_tab does;
 * the folder (a worktree included, with whatever it holds) and the agent's session on the machine stay, so the
 * work is resumed with the CLI's own "continue" in the same folder. Each close goes to the project's feed.
 */

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** The shortest setting: a lunch break is not "idle for long". */
export const IDLE_TAB_CLOSE_MIN_HOURS = 2;
export const IDLE_TAB_CLOSE_MAX_HOURS = 30 * 24;
/** What the switch in Máquinas proposes when it is turned on. */
export const IDLE_TAB_CLOSE_DEFAULT_HOURS = 24;
/** A tab waiting for input whose last answer is a report (an old turn end, before TER-972) waits this many times longer. */
export const WAITING_REPORT_FACTOR = 3;
/** How often the sweep runs. */
export const IDLE_SWEEP_MS = 10 * 60_000;
/**
 * A machine whose last room check failed on memory or load (fresher than this) has its idle tabs closed before
 * their time, from IDLE_TAB_CLOSE_MIN_HOURS, oldest first, at most NO_ROOM_CLOSE_PER_SWEEP a sweep: the next
 * room check (a minute later) tells whether it was enough.
 */
export const NO_ROOM_FRESH_MS = 15 * 60_000;
export const NO_ROOM_CLOSE_PER_SWEEP = 3;

const HOUR = 60 * 60_000;

/** Why a tab was closed: its time came, or its machine had no room and it was among the oldest. */
export type IdleCloseReason = 'idle' | 'no_room';

export interface IdleTabsDeps {
  foreground: (machine: Machine, session: string) => Promise<PaneForeground | null>;
  capture: (machine: Machine, session: string, lines: number) => Promise<string>;
  isOnline: (machineId: string) => boolean;
  /** The machine's last room check (machine-room.ts). */
  room: (machineId: string) => RoomReading | null;
  /** Closes the tab as the project's owner. Default: `closeTab` of the control layer, forced. */
  closeTab: (ctx: ControlContext, tabId: string) => Promise<void>;
}

export const defaultIdleTabsDeps: IdleTabsDeps = {
  foreground: (machine, session) => paneForeground(machine, session).catch(() => null),
  capture: captureScreen,
  isOnline: (id) => agents.isOnline(id),
  room: lastRoomOf,
  closeTab: async (ctx, tabId) => void (await closeTabFn(ctx, { tab_id: tabId, force: true })),
};

const roomShort = (r: RoomReading | null, now: Date) => !!r && !r.ok && (r.limit === 'memory' || r.limit === 'load') && now.getTime() - Date.parse(r.at) < NO_ROOM_FRESH_MS;

/** How long a tab must have been at rest on a machine closing after `hours`; null = its state never closes. */
function restNeededMs(tab: Tab, hours: number): number | null {
  if (tab.state === 'idle' || tab.state === 'finished') return hours * HOUR;
  if (tab.state === 'waiting_input') return hours * WAITING_REPORT_FACTOR * HOUR;
  return null;
}

/**
 * Whether nothing but the agent at rest holds the tab (the "never close" list of TER-1138, beyond the state):
 * no automatic run is active on it, it is not stopped on a usage limit, a `waiting_input` is a report and not a
 * real question, and what runs in front is the agent at its prompt or the bare shell — never a build or a server
 * started after the agent left. Codex, Cursor and Gemini have no screen rule: an agent still in front counts when
 * its last hook was a turn end, not a session end.
 */
async function quiet(repos: Repositories, deps: IdleTabsDeps, tab: Tab & { tmux_session: string }, machine: Machine): Promise<boolean> {
  if (tab.rate_limited_at) return false;
  if (await repos.automationRuns.activeByTab(tab.id)) return false;
  if (tab.state === 'waiting_input') {
    const answer = await repos.tabs.readLastAnswer(tab.id);
    if (!answer || answer.stale || classifyTurnEnd(answer.text) !== 'finished') return false;
  }
  const pane = await deps.foreground(machine, tab.tmux_session);
  if (pane === null) return false;
  const exited = tab.state_text === AGENT_EXITED_TEXT;
  if (pane === 'shell' || pane === 'dead') return true;
  // something runs in front: the agent at its prompt, unless the agent had already left (then it is something else)
  if (exited) return false;
  const [last] = await repos.tabs.listEvents(tab.id, 1);
  const event = typeof last?.meta.event === 'string' ? last.meta.event : null;
  if (!last || event === 'SessionEnd' || event === 'sessionEnd') return false;
  if (tab.state_tool !== 'claude') return true;
  return claudeScreenState(await deps.capture(machine, tab.tmux_session, SCREEN_STATE_LINES + 20)) === 'prompt';
}

/**
 * One pass. Never throws for one tab; logs ids, states and counts only, never the screen. Tabs of a machine
 * offline are left for later (closing kills a tmux session the server could not reach).
 */
export async function sweepIdleTabs(repos: Repositories, log: Log, now = new Date(), deps: IdleTabsDeps = defaultIdleTabsDeps): Promise<{ closed: number }> {
  const tabs = await repos.tabs.listIdleOnClosingMachines(new Date(now.getTime() - IDLE_TAB_CLOSE_MIN_HOURS * HOUR));
  const machines = new Map<string, Machine | undefined>();
  const noRoomLeft = new Map<string, number>();
  let closed = 0;
  // oldest first (the list's order): with no room, the oldest go first
  for (const tab of tabs) {
    if (!tab.tmux_session || !tab.state_at) continue;
    try {
      if (!machines.has(tab.machine_id)) machines.set(tab.machine_id, await repos.machines.findById(tab.machine_id));
      const machine = machines.get(tab.machine_id);
      if (!machine || machine.idle_tab_close_hours === null) continue;
      if (machine.type === 'agent' && !deps.isOnline(machine.id)) continue;
      const need = restNeededMs(tab, machine.idle_tab_close_hours);
      if (need === null) continue;
      const rest = now.getTime() - Date.parse(tab.state_at);
      let reason: IdleCloseReason | null = rest >= need ? 'idle' : null;
      if (!reason && rest >= IDLE_TAB_CLOSE_MIN_HOURS * HOUR && roomShort(deps.room(machine.id), now) && (noRoomLeft.get(machine.id) ?? NO_ROOM_CLOSE_PER_SWEEP) > 0) reason = 'no_room';
      if (!reason) continue;
      if (!(await quiet(repos, deps, { ...tab, tmux_session: tab.tmux_session }, machine))) continue;
      const project = await repos.projects.findById(tab.project_id);
      const owner = project?.owner_id ? await repos.users.findById(project.owner_id) : undefined;
      if (!owner) continue;
      await deps.closeTab(controlContextFor(repos, owner), tab.id);
      closed++;
      if (reason === 'no_room') noRoomLeft.set(machine.id, (noRoomLeft.get(machine.id) ?? NO_ROOM_CLOSE_PER_SWEEP) - 1);
      const hours = Math.floor(rest / HOUR);
      log.info({ tabId: tab.id, machineId: machine.id, state: tab.state, tool: tab.state_tool, reason, hours }, 'monitor: idle tab closed');
      await recordEvent(repos, {
        project_id: tab.project_id,
        kind: 'tab_auto_closed',
        payload: { tab_id: tab.id, tab: tab.name, machine_id: machine.id, machine: machine.name, tool: tab.state_tool, state: tab.state, reason, hours, session_id: tab.agent_session_id },
      }).catch((e: unknown) => log.warn({ tabId: tab.id, code: failureLabel(e) }, 'monitor: tab_auto_closed not recorded'));
    } catch (err) {
      log.warn({ tabId: tab.id, code: failureLabel(err) }, 'monitor: idle tab check failed');
    }
  }
  return { closed };
}

/** Runs the sweep every IDLE_SWEEP_MS, one pass at a time. Returns the stop function. */
export function startIdleTabsSweeper(repos: Repositories, log: Log): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepIdleTabs(repos, log)
      .catch((err) => log.warn({ code: failureLabel(err) }, 'monitor: idle tabs sweep failed'))
      .finally(() => (running = false));
  }, IDLE_SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
