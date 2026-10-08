import type { FastifyBaseLogger } from 'fastify';
import type { PaneForeground } from '@termhub/machine-ops';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import { AGENT_EXITED_TEXT, notifyAgentExited } from '../chat/agent-exited.js';
import { failureLabel } from '../chat/service.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab, TabState } from '../db/repositories/types.js';
import { paneForeground } from '../terminal/session-ops.js';
import { publishTabChange } from './ingest.js';
import { SCREEN_STATE_LINES, claudeScreenState, type ScreenState } from './screen-state.js';
import { AUTH_REQUIRED_TEXT, TRUST_PROMPT_TEXT } from './state.js';

/**
 * A Claude Code or Codex tab with no hook event for this long while `working` is looked at again
 * (TER-615, TER-643). A turn in progress keeps sending tool calls, and one quiet for longer (a long
 * build, a long think) still has its agent in front and, for Claude, its spinner on screen.
 */
export const STALE_WORKING_MS = 3 * 60_000;
/** How often the sweep looks for such tabs. */
export const STALE_SWEEP_MS = 60_000;

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export interface StaleWorkingDeps {
  capture: (machine: Machine, session: string, lines: number) => Promise<string>;
  /** What the pane runs in front; null when it cannot tell (an agent older than 0.14.0, a failed call). */
  foreground: (machine: Machine, session: string) => Promise<PaneForeground | null>;
  /** The card that tells the project's chat (`notifyAgentExited`). */
  exited: (repos: Repositories, log: Log, tab: Tab, machine: Machine, lastAt: string | null) => Promise<void>;
  isOnline: (machineId: string) => boolean;
  /** The last read of each tab: a busy one is read again only after STALE_WORKING_MS, or once its state moved. */
  checked: Map<string, { stateAt: string; at: number }>;
}

const defaultDeps = (): StaleWorkingDeps => ({
  capture: captureScreen,
  foreground: (machine, session) => paneForeground(machine, session).catch(() => null),
  exited: notifyAgentExited,
  isOnline: (id) => agents.isOnline(id),
  checked: new Map(),
});

/** The state a screen stands for, when it is a wait (on the person, or on the agent's own background work). */
const WAIT_OF: Partial<Record<ScreenState, TabState>> = {
  dialog: 'waiting_permission',
  background: 'waiting_background',
  prompt: 'waiting_input',
  trust: 'trust_prompt',
  auth: 'auth_required',
};

/** What the tab says for a state read off the screen that names something to do (TER-1046); the screen itself is never kept. */
const TEXT_OF: Partial<Record<ScreenState, string>> = { trust: TRUST_PROMPT_TEXT, auth: AUTH_REQUIRED_TEXT };

/** A tab that never reported a state is read once it is this old (TER-1046): the trust dialog or the login error holds it. */
export const UNREPORTED_AFTER_MS = 2 * 60_000;
/** Tabs older than this are no longer read: a plain shell stays unreported for ever. */
export const UNREPORTED_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** An unreported tab whose screen showed nothing is read again after this. */
export const UNREPORTED_RECHECK_MS = 5 * 60_000;

/**
 * One pass (TER-615). The hooks are the source of truth, but an event can go missing or arrive out of
 * order — a subagent's tool call after its main thread's Stop, a curl that timed out — and nothing
 * takes a tab out of `working` then: no card reaches the chat and nobody is told the agent stopped.
 * The screen settles it: a dialog is a wait for permission (a question looks the same to the hooks),
 * the input box with no spinner is a wait for input. The write is conditional on the tab's `state_at`
 * as it was read (`ifStateAt`), so a hook that lands during the capture wins. It alerts like the wait
 * the hooks missed. Never throws; logs ids and the derived state only, never the screen.
 *
 * Before the screen, the pane (TER-643): an agent killed or crashed (the OOM killer, a restart of the
 * service that owns the tmux server) sends no hook at all, and the pane falls back to its shell, which
 * no screen rule reads. The shell back in front (or a dead pane) means the agent exited: the tab becomes
 * `idle` with AGENT_EXITED_TEXT, under the same `ifStateAt` condition, and the project's chat gets a card
 * offering to resume it. Codex tabs only get this check; their screen has no rule here.
 */
export async function sweepStaleWorking(repos: Repositories, log: Log, now = new Date(), deps: StaleWorkingDeps = defaultDeps()): Promise<void> {
  const tabs = await repos.tabs.listStaleWorking(new Date(now.getTime() - STALE_WORKING_MS));
  const listed = new Set(tabs.map((t) => t.id));
  for (const id of deps.checked.keys()) if (!id.startsWith('unreported:') && !listed.has(id)) deps.checked.delete(id);
  for (const tab of tabs) {
    if (!tab.tmux_session || !tab.state_at) continue;
    const last = deps.checked.get(tab.id);
    if (last && last.stateAt === tab.state_at && now.getTime() - last.at < STALE_WORKING_MS) continue;
    deps.checked.set(tab.id, { stateAt: tab.state_at, at: now.getTime() });
    await checkTab(repos, log, tab as Tab & { tmux_session: string; state_at: string }, deps);
  }
}

async function checkTab(repos: Repositories, log: Log, tab: Tab & { tmux_session: string; state_at: string }, deps: StaleWorkingDeps): Promise<void> {
  try {
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine || (machine.type === 'agent' && !deps.isOnline(machine.id))) return;
    const pane = await deps.foreground(machine, tab.tmux_session);
    if (pane === 'shell' || pane === 'dead') {
      const tool = tab.state_tool ?? 'claude';
      const { tab: updated, event } = await repos.tabs.recordEvent(tab.id, { kind: 'idle', tool, text: AGENT_EXITED_TEXT, meta: { event: 'AgentExited', pane }, ifStateAt: tab.state_at });
      log.info({ tabId: tab.id, machineId: machine.id, tool, pane, recorded: event !== null }, 'monitor: agent exited without a hook');
      if (!event) return;
      publishTabChange(updated, tab.project_id, machine);
      await deps.exited(repos, log, updated, machine, tab.state_at);
      return;
    }
    // A tab that waits on its background work (TER-644) only gets the check above: its hooks went quiet on
    // purpose, and a screen without the background line (a shell runs in the background) proves nothing.
    if (tab.state_tool !== 'claude' || tab.state === 'waiting_background') return;
    const screen = claudeScreenState(await deps.capture(machine, tab.tmux_session, SCREEN_STATE_LINES + 20));
    const kind = screen ? WAIT_OF[screen] : undefined;
    if (!screen || !kind) return;
    const { tab: updated, event } = await repos.tabs.recordEvent(tab.id, { kind, tool: 'claude', text: TEXT_OF[screen] ?? null, meta: { event: 'ScreenCheck', screen }, ifStateAt: tab.state_at });
    log.info({ tabId: tab.id, machineId: machine.id, screen, recorded: event !== null }, 'monitor: stale working tab read from the screen');
    if (event) publishTabChange(updated, tab.project_id, machine);
  } catch (err) {
    log.warn({ tabId: tab.id, code: failureLabel(err) }, 'monitor: stale working check failed');
  }
}

/**
 * One pass over the tabs that never reported a state (TER-1046). Claude Code's folder trust dialog, and its
 * login error on a fresh session, come before any hook: such a tab showed no indicator at all and sat there
 * unnoticed. A tab open for UNREPORTED_AFTER_MS with Claude Code in front has its screen read; the dialog
 * becomes `trust_prompt`, the login error `auth_required` (both need the person), conditional on the tab
 * still having no state. Anything else (a plain shell, a Claude Code at its prompt with no hooks installed)
 * is left as it is and read again after UNREPORTED_RECHECK_MS. Never throws; logs ids and the derived
 * state only, never the screen.
 */
export async function sweepUnreported(repos: Repositories, log: Log, now = new Date(), deps: StaleWorkingDeps = defaultDeps()): Promise<void> {
  const tabs = await repos.tabs.listUnreported(new Date(now.getTime() - UNREPORTED_WINDOW_MS), new Date(now.getTime() - UNREPORTED_AFTER_MS));
  for (const tab of tabs) {
    if (!tab.tmux_session) continue;
    const key = `unreported:${tab.id}`;
    const last = deps.checked.get(key);
    if (last && now.getTime() - last.at < UNREPORTED_RECHECK_MS) continue;
    deps.checked.set(key, { stateAt: '', at: now.getTime() });
    try {
      const machine = await repos.machines.findById(tab.machine_id);
      if (!machine || (machine.type === 'agent' && !deps.isOnline(machine.id))) continue;
      // a shell in front (or a dead pane) is not Claude Code: nothing to read
      const pane = await deps.foreground(machine, tab.tmux_session);
      if (pane === 'shell' || pane === 'dead') continue;
      const screen = claudeScreenState(await deps.capture(machine, tab.tmux_session, SCREEN_STATE_LINES + 20));
      if (screen !== 'trust' && screen !== 'auth') continue;
      const kind = WAIT_OF[screen]!;
      const { tab: updated, event } = await repos.tabs.recordEvent(tab.id, { kind, tool: 'claude', text: TEXT_OF[screen]!, meta: { event: 'ScreenCheck', screen }, ifStateAt: null, ifStateIn: [null] });
      log.info({ tabId: tab.id, machineId: machine.id, screen, recorded: event !== null }, 'monitor: unreported tab read from the screen');
      if (event) publishTabChange(updated, tab.project_id, machine);
    } catch (err) {
      log.warn({ tabId: tab.id, code: failureLabel(err) }, 'monitor: unreported tab check failed');
    }
  }
  // the map holds both sweeps' entries: drop this sweep's that left the list
  const listed = new Set(tabs.map((t) => `unreported:${t.id}`));
  for (const key of deps.checked.keys()) if (key.startsWith('unreported:') && !listed.has(key)) deps.checked.delete(key);
}

/** Runs the sweep every STALE_SWEEP_MS, one pass at a time. Returns the stop function. */
export function startStaleWorkingSweeper(repos: Repositories, log: Log): () => void {
  const deps = defaultDeps();
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepStaleWorking(repos, log, new Date(), deps)
      .then(() => sweepUnreported(repos, log, new Date(), deps))
      .catch((err) => log.warn({ code: failureLabel(err) }, 'monitor: stale working sweep failed'))
      .finally(() => (running = false));
  }, STALE_SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
