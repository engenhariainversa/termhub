import { describe, expect, it } from 'vitest';
import { epicsInProgress } from './epic-summary';
import type { AgentOnCard, CardProgress, EpicProgress, Tab } from './types';

const agent = (tab_id: string, over: Partial<AgentOnCard> = {}): AgentOnCard => ({
  tab_id, tab_name: tab_id, machine_name: 'jarvis', subtask_ref: null, state: 'working', state_at: null, background: false, needs_you: false, activity: null, activity_verb: null, rate_limited: false, ...over,
});
const card = (id: string, status: CardProgress['status'], agents: AgentOnCard[] | null = []): CardProgress => ({ id, status, agents }) as CardProgress;
const epic = (id: string, cards: CardProgress[]): EpicProgress => ({ id, ref: id, title: id, cards }) as EpicProgress;
const none = () => undefined;

describe('epicsInProgress', () => {
  it('counts cards, not subtasks, and keeps the backlog in the total', () => {
    const [e] = epicsInProgress([epic('E', [card('a', 'done'), card('b', 'doing'), card('c', 'backlog'), card('d', 'todo')])], none);
    expect(e).toMatchObject({ cards: { done: 1, total: 4 }, percent: 25, doing: 1, waiting: 0, agents: [] });
  });

  it('counts a card once however many of its agents wait, and lists an agent once across cards', () => {
    const waiting = agent('t1', { state: 'waiting_input', needs_you: true });
    const [e] = epicsInProgress([epic('E', [card('a', 'doing', [waiting, agent('t2', { state: 'waiting_permission', needs_you: true })]), card('b', 'doing', [agent('t3')]), card('c', 'todo', [agent('t3')])])], none);
    expect(e.waiting).toBe(1);
    expect(e.agents.map((a) => a.tab_id)).toEqual(['t1', 't2', 't3']);
  });

  it('lists the agents still at work (background included), not the ones that finished or never reported', () => {
    const [e] = epicsInProgress(
      [epic('E', [card('a', 'doing', [agent('w'), agent('bg', { background: true }), agent('idle', { state: 'idle' }), agent('silent', { state: null }), agent('err', { state: 'error' })])])],
      none,
    );
    expect(e.agents.map((a) => a.tab_id)).toEqual(['w', 'bg']);
  });

  it('leaves out epics with no card in doing and no agent at work, and keeps the server order', () => {
    const out = epicsInProgress(
      [epic('A', [card('a', 'todo', [agent('t1')])]), epic('B', [card('b', 'todo', [agent('t2', { state: 'idle' })]), card('c', 'done')]), epic('C', [card('d', 'doing', null)])],
      none,
    );
    expect(out.map((e) => e.id)).toEqual(['A', 'C']);
  });

  it('reads the state live from the monitor', () => {
    const live = { id: 't1', state: 'waiting_input', state_at: null, activity: null, activity_verb: null, rate_limited_at: null } as unknown as Tab;
    const [e] = epicsInProgress([epic('E', [card('a', 'todo', [agent('t1')])])], (id) => (id === 't1' ? live : undefined));
    expect(e.waiting).toBe(1);
    expect(e.agents[0]).toMatchObject({ tab_id: 't1', needs_you: true });
  });

  it('an epic with no cards is left out', () => {
    expect(epicsInProgress([epic('E', [])], none)).toEqual([]);
  });
});
