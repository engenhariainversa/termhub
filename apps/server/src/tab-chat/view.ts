import type { TTabSummary } from '@termhub/mobile-api';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { needsYou } from '../monitor/state.js';
import type { TabChatAvailability } from './reader.js';

/** A terminal tab as the phone's Sessões list and session header show it (spec 2026-10-01 tab chat §5.4). */
export function tabSummaryOf(
  tab: Tab,
  project: Pick<Project, 'id' | 'key' | 'name'>,
  machine: Pick<Machine, 'id' | 'name'>,
  availability: TabChatAvailability,
): TTabSummary {
  return {
    id: tab.id,
    name: tab.name,
    project: { id: project.id, key: project.key, name: project.name },
    machine: { id: machine.id, name: machine.name },
    // the contract's state predates `waiting_background` (still at work, flagged, TER-644) and `finished`
    // (stopped, flagged, TER-972), as progress.ts does
    state: tab.state === 'waiting_background' ? 'working' : tab.state === 'finished' ? 'idle' : tab.state,
    background: tab.state === 'waiting_background',
    finished: tab.state === 'finished',
    state_at: tab.state_at,
    needs_you: needsYou(tab),
    activity: tab.activity,
    activity_verb: tab.activity_verb,
    availability,
  };
}
