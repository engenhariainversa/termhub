import type { TabState, TaskStatus } from '../../db/repositories/types.js';
import type { TabGcConfig } from './config.js';

/*
 * TER-1171: what the tab GC does with one agent tab right now, from facts only (no I/O). The rules and their
 * order are the spec's (docs/superpowers/specs/2026-11-11-agent-tab-gc-design.md, "Classification"); the
 * sweep (sweep.ts) gathers the facts, runs the foreground check on candidates and applies the grace period.
 */

export type GcAction = 'keep' | 'candidate' | 'remove';

export type GcReason =
  /** the GC is off for this tab (a level of its settings turned it off) — set by the sweep */
  | 'disabled'
  | 'not_agent'
  | 'pinned'
  | 'machine_offline'
  | 'session_gone'
  | 'run_active'
  | 'busy'
  | 'needs_you'
  | 'rate_limited'
  | 'card_in_progress'
  | 'recent'
  | 'not_quiet'
  | 'idle'
  | 'error'
  | 'over_cap'
  | 'no_room';

/** The machine answered: the session is listed (`alive`) or not (`gone`); `unknown` = it could not be asked. */
export type SessionPresence = 'alive' | 'gone' | 'unknown';

/** Pressure on the tab's machine: more agent tabs than its cap, or short of memory/load (TER-1138). */
export type GcPressure = 'over_cap' | 'no_room' | null;

export interface GcFacts {
  /** a terminal tab where an agent reported its state at least once (`state_tool` set) */
  agent: boolean;
  pinned: boolean;
  /** the machine can be asked now (an agent machine online; local and ssh: the tmux probe answered) */
  machineReachable: boolean;
  session: SessionPresence;
  runActive: boolean;
  rateLimited: boolean;
  state: TabState | null;
  /** status of the card linked to the tab; null = no card */
  cardStatus: TaskStatus | null;
  /** ms since epoch; null = never */
  stateAt: number | null;
  lastEventAt: number | null;
  resetAt: number | null;
}

export interface GcVerdict {
  action: GcAction;
  reason: GcReason;
  /** how long the tab has rested, by the GC's clock (ms); null when the rule did not look at time */
  rest_ms: number | null;
}

const HOUR = 60 * 60_000;

/** Under pressure, a tab that rested this long may be collected before its X. */
export const PRESSURE_MIN_REST_MS = 2 * HOUR;

const BUSY: readonly TabState[] = ['working', 'waiting_background', 'blocked'];
const NEEDS_YOU: readonly TabState[] = ['waiting_input', 'waiting_permission', 'auth_required', 'trust_prompt', 'cli_dialog'];

const keep = (reason: GcReason, rest_ms: number | null = null): GcVerdict => ({ action: 'keep', reason, rest_ms });

/** When the GC's rest clock started: the newest of the last state change, the last monitor event and the last reset. */
export function restStart(f: Pick<GcFacts, 'stateAt' | 'lastEventAt' | 'resetAt'>): number | null {
  const marks = [f.stateAt, f.lastEventAt, f.resetAt].filter((v): v is number => typeof v === 'number');
  return marks.length ? Math.max(...marks) : null;
}

export function classifyTab(f: GcFacts, cfg: Pick<TabGcConfig, 'idle_hours' | 'error_hours'>, now: number, pressure: GcPressure = null): GcVerdict {
  if (!f.agent || f.state === null) return keep('not_agent');
  if (f.pinned) return keep('pinned');
  if (!f.machineReachable) return keep('machine_offline');
  if (f.session === 'gone') return { action: 'remove', reason: 'session_gone', rest_ms: null };
  if (f.session === 'unknown') return keep('machine_offline');
  if (f.runActive) return keep('run_active');
  if (BUSY.includes(f.state)) return keep('busy');
  if (NEEDS_YOU.includes(f.state)) return keep('needs_you');
  if (f.rateLimited) return keep('rate_limited');
  const resting = f.state === 'finished' || f.state === 'idle';
  if (resting && f.cardStatus === 'doing') return keep('card_in_progress');
  const start = restStart(f);
  if (start === null) return keep('recent');
  const rest = Math.max(0, now - start);
  if (resting && rest >= cfg.idle_hours * HOUR) return { action: 'candidate', reason: 'idle', rest_ms: rest };
  if (f.state === 'error' && rest >= cfg.error_hours * HOUR) return { action: 'candidate', reason: 'error', rest_ms: rest };
  if ((resting || f.state === 'error') && pressure && rest >= PRESSURE_MIN_REST_MS) return { action: 'candidate', reason: pressure, rest_ms: rest };
  return keep('recent', rest);
}
