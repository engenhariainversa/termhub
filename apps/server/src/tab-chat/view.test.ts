import { describe, expect, it } from 'vitest';
import { tabSummary } from '@termhub/mobile-api';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { tabSummaryOf } from './view.js';

const project = { id: 'p1', key: 'TH', name: 'termhub' } as Project;
const machine = { id: 'm1', name: 'box' } as Machine;
const tab = (o: Partial<Tab>) =>
  ({ id: 't1', name: 'api', state: 'working', state_at: '2026-10-01T10:00:00.000Z', state_seen_at: null, activity: null, activity_verb: null, ...o }) as Tab;

describe('tabSummaryOf', () => {
  it('carries the tab, its project, its machine and the availability', () => {
    expect(tabSummaryOf(tab({ activity: 'coding', activity_verb: 'Moonwalking' }), project, machine, 'ready')).toEqual({
      id: 't1',
      name: 'api',
      project: { id: 'p1', key: 'TH', name: 'termhub' },
      machine: { id: 'm1', name: 'box' },
      state: 'working',
      background: false,
      finished: false,
      state_at: '2026-10-01T10:00:00.000Z',
      needs_you: false,
      activity: 'coding',
      activity_verb: 'Moonwalking',
      availability: 'ready',
    });
  });

  it('a tab waiting on its own background work travels as working, flagged', () => {
    expect(tabSummaryOf(tab({ state: 'waiting_background' }), project, machine, 'ready')).toMatchObject({ state: 'working', background: true, needs_you: false });
  });

  it('a tab that ended its turn with a report travels as idle, flagged, and never needs you (TER-972)', () => {
    const summary = tabSummaryOf(tab({ state: 'finished' }), project, machine, 'ready');
    expect(summary).toMatchObject({ state: 'idle', finished: true, background: false, needs_you: false });
    // an older payload without the flag reads as false
    const { finished: _f, ...older } = summary;
    expect(tabSummary.parse(older).finished).toBe(false);
  });

  it('needs you while waiting and not seen since the state began', () => {
    const at = '2026-10-01T10:00:00.000Z';
    for (const state of ['waiting_input', 'waiting_permission'] as const) {
      expect(tabSummaryOf(tab({ state, state_at: at }), project, machine, 'ready').needs_you).toBe(true);
      expect(tabSummaryOf(tab({ state, state_at: at, state_seen_at: '2026-10-01T09:00:00.000Z' }), project, machine, 'ready').needs_you).toBe(true);
      expect(tabSummaryOf(tab({ state, state_at: at, state_seen_at: '2026-10-01T11:00:00.000Z' }), project, machine, 'ready').needs_you).toBe(false);
    }
    // the same rule as the progress panel and the web (monitor/state.ts `needsYou`): an error is not a wait
    expect(tabSummaryOf(tab({ state: 'error' }), project, machine, 'ready').needs_you).toBe(false);
    expect(tabSummaryOf(tab({ state: 'idle' }), project, machine, 'ready').needs_you).toBe(false);
  });
});
