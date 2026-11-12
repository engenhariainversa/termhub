import { describe, expect, it } from 'vitest';
import type { TabState, TaskStatus } from '../../db/repositories/types.js';
import { classifyTab, PRESSURE_MIN_REST_MS, restStart, type GcAction, type GcFacts, type GcPressure, type GcReason } from './classify.js';

const HOUR = 60 * 60_000;
const NOW = Date.parse('2026-11-11T12:00:00Z');
const CFG = { idle_hours: 24, error_hours: 6 };
const ago = (h: number) => NOW - h * HOUR;

const facts = (over: Partial<GcFacts> = {}): GcFacts => ({
  agent: true,
  pinned: false,
  machineReachable: true,
  session: 'alive',
  runActive: false,
  rateLimited: false,
  state: 'finished',
  cardStatus: null,
  stateAt: ago(30),
  lastEventAt: ago(30),
  resetAt: null,
  ...over,
});

type Row = [state: TabState, card: TaskStatus | null, run: boolean, restHours: number, action: GcAction, reason: GcReason];

/* state × card × run × time → action (TER-1171 card, requirement 8) */
const TABLE: Row[] = [
  // finished / idle: X = 24 h, unless the card is in doing or a run is active
  ['finished', null, false, 30, 'candidate', 'idle'],
  ['finished', null, false, 23, 'keep', 'recent'],
  ['finished', 'done', false, 24, 'candidate', 'idle'],
  ['finished', 'done', false, 1, 'keep', 'recent'],
  ['finished', 'todo', false, 30, 'candidate', 'idle'],
  ['finished', 'backlog', false, 30, 'candidate', 'idle'],
  ['finished', 'doing', false, 300, 'keep', 'card_in_progress'],
  ['finished', 'done', true, 300, 'keep', 'run_active'],
  ['idle', null, false, 25, 'candidate', 'idle'],
  ['idle', 'doing', false, 300, 'keep', 'card_in_progress'],
  ['idle', 'done', true, 300, 'keep', 'run_active'],
  // error: Y = 6 h, card or not
  ['error', null, false, 7, 'candidate', 'error'],
  ['error', null, false, 5, 'keep', 'recent'],
  ['error', 'doing', false, 7, 'candidate', 'error'],
  ['error', 'done', true, 7, 'keep', 'run_active'],
  // never: busy or waiting on the person, however long
  ['working', null, false, 300, 'keep', 'busy'],
  ['waiting_background', 'done', false, 300, 'keep', 'busy'],
  ['blocked', 'doing', false, 300, 'keep', 'busy'],
  ['waiting_input', null, false, 300, 'keep', 'needs_you'],
  ['waiting_permission', 'done', false, 300, 'keep', 'needs_you'],
  ['auth_required', null, false, 300, 'keep', 'needs_you'],
  ['trust_prompt', null, false, 300, 'keep', 'needs_you'],
  ['cli_dialog', 'done', false, 300, 'keep', 'needs_you'],
];

describe('classifyTab (TER-1171): state × card × run × time', () => {
  it.each(TABLE)('%s, card %s, run %s, %d h at rest → %s (%s)', (state, card, run, hours, action, reason) => {
    const v = classifyTab(facts({ state, cardStatus: card, runActive: run, stateAt: ago(hours), lastEventAt: ago(hours) }), CFG, NOW);
    expect([v.action, v.reason]).toEqual([action, reason]);
  });
});

describe('classifyTab (TER-1171): edge cases', () => {
  it('never touches a plain shell (no agent ever reported)', () => {
    expect(classifyTab(facts({ agent: false }), CFG, NOW).reason).toBe('not_agent');
    expect(classifyTab(facts({ state: null }), CFG, NOW).reason).toBe('not_agent');
  });

  it('never collects a pinned tab, not even with its session gone', () => {
    expect(classifyTab(facts({ pinned: true, stateAt: ago(500) }), CFG, NOW)).toMatchObject({ action: 'keep', reason: 'pinned' });
    expect(classifyTab(facts({ pinned: true, session: 'gone' }), CFG, NOW).action).toBe('keep');
  });

  it('removes a tab whose tmux session is gone at once, whatever its state or age', () => {
    for (const state of ['working', 'waiting_input', 'finished'] as const) {
      expect(classifyTab(facts({ state, session: 'gone', stateAt: ago(0) }), CFG, NOW)).toMatchObject({ action: 'remove', reason: 'session_gone' });
    }
  });

  it('touches nothing on a machine it cannot ask (offline), nor when the session could not be checked', () => {
    expect(classifyTab(facts({ machineReachable: false, session: 'gone', stateAt: ago(500) }), CFG, NOW).reason).toBe('machine_offline');
    expect(classifyTab(facts({ session: 'unknown', stateAt: ago(500) }), CFG, NOW).reason).toBe('machine_offline');
  });

  it('finished with subagents still in background is waiting_background: kept', () => {
    expect(classifyTab(facts({ state: 'waiting_background', stateAt: ago(48) }), CFG, NOW).reason).toBe('busy');
  });

  it('a monitor event after the last state change restarts the clock (a subagent hook after Stop)', () => {
    expect(classifyTab(facts({ stateAt: ago(30), lastEventAt: ago(1) }), CFG, NOW)).toMatchObject({ action: 'keep', reason: 'recent', rest_ms: HOUR });
  });

  it('"manter" (gc_reset_at) restarts the clock', () => {
    expect(classifyTab(facts({ stateAt: ago(30), lastEventAt: ago(30), resetAt: ago(2) }), CFG, NOW).reason).toBe('recent');
    expect(classifyTab(facts({ stateAt: ago(60), lastEventAt: ago(60), resetAt: ago(25) }), CFG, NOW).reason).toBe('idle');
  });

  it('keeps a tab stopped on a usage limit', () => {
    expect(classifyTab(facts({ rateLimited: true, stateAt: ago(48) }), CFG, NOW).reason).toBe('rate_limited');
  });

  it('follows the configured X and Y', () => {
    expect(classifyTab(facts({ stateAt: ago(3), lastEventAt: ago(3) }), { idle_hours: 2, error_hours: 6 }, NOW).reason).toBe('idle');
    expect(classifyTab(facts({ state: 'error', stateAt: ago(3), lastEventAt: ago(3) }), { idle_hours: 24, error_hours: 2 }, NOW).reason).toBe('error');
  });

  it.each<[GcPressure]>([['over_cap'], ['no_room']])('under %s pressure, collects idle/error tabs from 2 h, never protected ones', (pressure) => {
    const two = PRESSURE_MIN_REST_MS / HOUR;
    expect(classifyTab(facts({ stateAt: ago(two), lastEventAt: ago(two) }), CFG, NOW, pressure)).toMatchObject({ action: 'candidate', reason: pressure });
    expect(classifyTab(facts({ state: 'error', stateAt: ago(3), lastEventAt: ago(3) }), CFG, NOW, pressure).reason).toBe(pressure);
    expect(classifyTab(facts({ stateAt: ago(1), lastEventAt: ago(1) }), CFG, NOW, pressure).reason).toBe('recent');
    expect(classifyTab(facts({ cardStatus: 'doing', stateAt: ago(10) }), CFG, NOW, pressure).reason).toBe('card_in_progress');
    expect(classifyTab(facts({ state: 'waiting_input', stateAt: ago(10) }), CFG, NOW, pressure).reason).toBe('needs_you');
  });

  it('restStart is the newest mark', () => {
    expect(restStart({ stateAt: 1, lastEventAt: 3, resetAt: 2 })).toBe(3);
    expect(restStart({ stateAt: null, lastEventAt: null, resetAt: null })).toBeNull();
  });
});
