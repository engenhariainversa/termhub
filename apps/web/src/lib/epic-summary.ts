import { withLiveTab } from './progress';
import type { AgentOnCard, EpicProgress, Tab } from './types';

/** An epic as the empty terminal area shows it (TER-912): counted in cards, not in subtasks. */
export interface EpicSummary {
  id: string;
  ref: string;
  title: string;
  cards: { done: number; total: number };
  percent: number;
  /** cards in a `doing` column */
  doing: number;
  /** cards with at least one agent waiting for the person */
  waiting: number;
  /** agents on the epic's cards that are not done with their turn: working, waiting on background work, or waiting for you */
  agents: AgentOnCard[];
}

const active = (a: AgentOnCard) => a.needs_you || a.state === 'working';

/**
 * The epics with something going on — a card in `doing`, or an agent working on one of its cards —
 * from the progress panel's read (GET /progress?scope=all), with each agent's state taken live from
 * the monitor. The rest are left out. The server's order (needs you first, then working) is kept.
 */
export function epicsInProgress(epics: EpicProgress[], liveTab: (tabId: string) => Tab | undefined): EpicSummary[] {
  const out: EpicSummary[] = [];
  for (const epic of epics) {
    const cards = epic.cards.map((c) => ({ ...c, agents: (c.agents ?? []).map((a) => withLiveTab(a, liveTab(a.tab_id))) }));
    const doing = cards.filter((c) => c.status === 'doing').length;
    const agents = new Map<string, AgentOnCard>();
    for (const c of cards) for (const a of c.agents) if (active(a)) agents.set(a.tab_id, a);
    if (doing === 0 && agents.size === 0) continue;
    const done = cards.filter((c) => c.status === 'done').length;
    out.push({
      id: epic.id,
      ref: epic.ref,
      title: epic.title,
      cards: { done, total: cards.length },
      percent: cards.length === 0 ? 0 : Math.round((done / cards.length) * 100),
      doing,
      waiting: cards.filter((c) => c.agents.some((a) => a.needs_you)).length,
      agents: [...agents.values()],
    });
  }
  return out;
}
