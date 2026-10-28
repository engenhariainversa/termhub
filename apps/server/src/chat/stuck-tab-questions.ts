import type { FastifyBaseLogger } from 'fastify';
import type { PaneForeground } from '@termhub/machine-ops';
import { agents } from '../agent/registry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { probeTmuxSessionsCached, type TmuxProbe } from '../terminal/machine-exec.js';
import { paneForeground } from '../terminal/session-ops.js';
import { failureLabel } from './service.js';
import { expireOrphanTabQuestions, publishTabQuestions } from './tab-questions.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/** How often the sweep runs. */
export const STUCK_SWEEP_MS = 60_000;
/** A card younger than this is left alone: its tab may still be starting, or a hook may still be on its way. */
export const STUCK_GRACE_MS = 2 * 60_000;
/** At most this many cards are checked per pass, oldest first. */
export const STUCK_SWEEP_LIMIT = 200;

export interface StuckSweepDeps {
  probe: (machine: Machine) => Promise<TmuxProbe>;
  /** What the pane runs in front; null when it cannot tell (an older agent, a failed call). */
  foreground: (machine: Machine, session: string) => Promise<PaneForeground | null>;
  isOnline: (machineId: string) => boolean;
}

export const defaultStuckSweepDeps: StuckSweepDeps = {
  probe: (machine) => probeTmuxSessionsCached(machine).catch((): TmuxProbe => ({ reachable: false, sessions: new Set(), cause: 'probe failed' })),
  foreground: (machine, session) => paneForeground(machine, session).catch(() => null),
  isOnline: (id) => agents.isOnline(id),
};

/**
 * Closes, as `expired`, the open question and permission cards that nothing can answer any more (TER-1140):
 * no hook says so when a tab's tmux session dies (a machine reboot, a killed tmux server, a pane closed by
 * hand) or its agent exits while it waits on the person (the stale-working sweep only reads working tabs).
 * Each pass: the cards whose tab row is gone (`expireOrphanTabQuestions`), then, for every card older than
 * STUCK_GRACE_MS, its tab's machine is asked — the tmux session missing, or a shell (or a dead pane) in front
 * of it, closes the card. A machine that cannot be asked (offline, a timed-out ssh) proves nothing and closes
 * nothing. Never throws; logs ids and counts only.
 */
export async function sweepStuckTabQuestions(repos: Repositories, log: Log, now = new Date(), deps: StuckSweepDeps = defaultStuckSweepDeps): Promise<number> {
  let count = await expireOrphanTabQuestions(repos, log);
  try {
    const cards = await repos.tabQuestions.listOpenQuestionsBefore(new Date(now.getTime() - STUCK_GRACE_MS), STUCK_SWEEP_LIMIT);
    const byTab = new Map<string, TabQuestion[]>();
    for (const card of cards) byTab.set(card.tab_id, [...(byTab.get(card.tab_id) ?? []), card]);
    const machines = new Map<string, Machine | undefined>();
    const probes = new Map<string, Promise<TmuxProbe>>();
    for (const [tabId, open] of byTab) {
      const tab = await repos.tabs.findById(tabId);
      // gone between the orphan sweep and here: the next pass closes it
      if (!tab?.tmux_session) continue;
      if (!machines.has(tab.machine_id)) machines.set(tab.machine_id, await repos.machines.findById(tab.machine_id));
      const machine = machines.get(tab.machine_id);
      if (!machine || (machine.type === 'agent' && !deps.isOnline(machine.id))) continue;
      if (!probes.has(machine.id)) probes.set(machine.id, deps.probe(machine));
      const why = await whyStuck(tab as Tab & { tmux_session: string }, machine, await probes.get(machine.id)!, deps);
      if (!why) continue;
      const closed: TabQuestion[] = [];
      for (const card of open) {
        const row = await repos.tabQuestions.expireOne(card.id, now);
        if (row) closed.push(row);
      }
      if (closed.length === 0) continue;
      await publishTabQuestions(repos, 'tab_question_closed', closed);
      log.info({ tabId: tab.id, machineId: machine.id, why, count: closed.length }, 'stuck tab questions expired');
      count += closed.length;
    }
  } catch (err) {
    log.warn({ code: failureLabel(err) }, 'stuck tab question sweep failed');
  }
  return count;
}

/** Why the tab can no longer answer its card, or null when it may: the session is gone, or the agent left it. */
async function whyStuck(tab: Tab & { tmux_session: string }, machine: Machine, probe: TmuxProbe, deps: StuckSweepDeps): Promise<'session_gone' | 'agent_exited' | null> {
  if (!probe.reachable) return null;
  if (!probe.sessions.has(tab.tmux_session)) return 'session_gone';
  const pane = await deps.foreground(machine, tab.tmux_session);
  return pane === 'shell' || pane === 'dead' ? 'agent_exited' : null;
}

/** Runs the sweep every STUCK_SWEEP_MS, one pass at a time. Returns the stop function. */
export function startStuckTabQuestionSweeper(repos: Repositories, log: Log, deps: StuckSweepDeps = defaultStuckSweepDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepStuckTabQuestions(repos, log, new Date(), deps).finally(() => (running = false));
  }, STUCK_SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
