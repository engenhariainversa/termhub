import type { FastifyBaseLogger } from 'fastify';
import { agents } from '../agent/registry.js';
import { captureScreen } from '../agent/screen.js';
import { failureLabel } from '../chat/service.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { SCREEN_STATE_LINES, claudeScreenState } from './screen-state.js';
import { AUTH_REQUIRED_TEXT, type Interpreted } from './state.js';

/*
 * What the attention indicator needs beyond the hook payload (TER-1046): how the automatic run of the tab
 * ended, and Claude Code's login error, which only the screen shows when the turn's Stop carried no message.
 */

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** A run's report counts for the Stop that follows it only if the run ended this recently. */
export const RUN_SETTLED_MS = 15 * 60_000;

/**
 * A Claude main-thread turn end in a tab whose automatic run just reported (TER-1046). The run's own report
 * says more than the wording of the last message: `done` (the PR is open, termhub follows it) is `finished`
 * whatever "próximos passos" the report lists, and `blocked` is `blocked` — automation or the chat acts on it,
 * the person was told through the escalation. A login error stays what it is. Pure.
 */
export function withRunOutcome(i: Interpreted, run: Pick<AutomationRun, 'status' | 'ended_at'> | null, now = new Date()): Interpreted {
  if (!run || (i.kind !== 'finished' && i.kind !== 'waiting_input')) return i;
  if (!run.ended_at || now.getTime() - run.ended_at.getTime() > RUN_SETTLED_MS) return i;
  if (run.status === 'done') return { ...i, kind: 'finished' };
  if (run.status === 'blocked') return { ...i, kind: 'blocked' };
  return i;
}

/** Only a Claude main-thread Stop is a turn end a run's report applies to. */
export const isMainStop = (tool: string, i: Interpreted): boolean => tool === 'claude' && i.meta.event === 'Stop' && i.meta.subagent !== true;

export async function applyRunOutcome(repos: Repositories, tab: Tab, tool: string, i: Interpreted): Promise<Interpreted> {
  if (!isMainStop(tool, i) || (i.kind !== 'finished' && i.kind !== 'waiting_input')) return i;
  return withRunOutcome(i, await repos.automationRuns.latestByTab(tab.id));
}

export interface AuthScreenDeps {
  capture: (machine: Machine, session: string, lines: number) => Promise<string>;
  isOnline: (machineId: string) => boolean;
  publish: (tab: Tab, projectId: string, machine: Machine) => void;
}

/**
 * Claude's idle reminder ("Claude is waiting for your input") on a wait: the turn may have ended on Claude
 * Code's login error with no message in its Stop (TER-1046, three tabs on 2026-10-08). The screen tells: its
 * last answer is "Login expired · Please run /login". Then the wait becomes `auth_required`, conditional on
 * the tab still being in that wait. Never throws; logs ids only, never the screen.
 */
export async function checkAuthOnScreen(repos: Repositories, log: Log, tab: Tab, deps: AuthScreenDeps): Promise<void> {
  try {
    if (!tab.tmux_session || tab.state !== 'waiting_input' || !tab.state_at) return;
    const machine = await repos.machines.findById(tab.machine_id);
    if (!machine || (machine.type === 'agent' && !deps.isOnline(machine.id))) return;
    const screen = claudeScreenState(await deps.capture(machine, tab.tmux_session, SCREEN_STATE_LINES + 20));
    if (screen !== 'auth') return;
    const { tab: updated, event } = await repos.tabs.recordEvent(tab.id, {
      kind: 'auth_required',
      tool: 'claude',
      text: AUTH_REQUIRED_TEXT,
      meta: { event: 'ScreenCheck', screen },
      ifStateAt: tab.state_at,
      ifStateIn: ['waiting_input'],
    });
    log.info({ tabId: tab.id, machineId: machine.id, screen, recorded: event !== null }, 'monitor: login error read from the screen');
    if (event) deps.publish(updated, tab.project_id, machine);
  } catch (err) {
    log.warn({ tabId: tab.id, code: failureLabel(err) }, 'monitor: login screen check failed');
  }
}

export const defaultAuthScreenDeps = (publish: AuthScreenDeps['publish']): AuthScreenDeps => ({
  capture: captureScreen,
  isOnline: (id) => agents.isOnline(id),
  publish,
});
