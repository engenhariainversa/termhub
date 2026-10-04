import { describe, expect, it } from 'vitest';
import { agentOnCard, progressResponse, type PullRequestBadge } from '@termhub/mobile-api';
import { aggregateCard, aggregateEpic, selectEpics, type ProgressCardRow, type ProgressEpicRow, type ProgressTabRow } from './aggregate.js';

const at = (min: number) => new Date(Date.UTC(2026, 8, 27, 12, 0) + min * 60_000);
const tab = (id: string, state: ProgressTabRow['state']): ProgressTabRow => ({ id, name: `aba ${id}`, machine_name: 'jarvis', state, state_at: at(0), activity: null, activity_verb: null, rate_limited_at: null });
const card = (over: Partial<ProgressCardRow> & { id: string }): ProgressCardRow => ({
  ref: `TER-${over.id}`, title: over.id, type: 'story', status: 'doing', position: 0, column_name: 'Fazendo',
  started_at: null, done_at: null, active_seconds: 0, tab: null, subtasks: [], pull_requests: [], ...over,
});
const sub = (id: string, status: 'todo' | 'done', extra: { done_at?: Date; tab?: ProgressTabRow } = {}) => ({ id, ref: `TER-${id}`, status, done_at: extra.done_at ?? null, tab: extra.tab ?? null });
const epic = (cards: ProgressCardRow[], id = 'e1'): ProgressEpicRow => ({ id, ref: `TER-${id}`, title: `Épico ${id}`, project: { id: 'p1', key: 'TER', name: 'termhub' }, cards });

describe('aggregateCard', () => {
  it('counts subtasks as units', () => {
    const c = aggregateCard(card({ id: '2', subtasks: [sub('3', 'done'), sub('4', 'todo'), sub('5', 'todo')] }), true);
    expect(c.units).toEqual({ done: 1, total: 3 });
    expect(c.percent).toBe(33);
  });
  it('counts a card without subtasks as one unit', () => {
    expect(aggregateCard(card({ id: '2' }), true).units).toEqual({ done: 0, total: 1 });
    expect(aggregateCard(card({ id: '2', status: 'done' }), true).percent).toBe(100);
  });
  it('reads a done card with unfinished subtasks as 100 % and done', () => {
    const c = aggregateCard(card({ id: '2', status: 'done', subtasks: [sub('3', 'done'), sub('4', 'todo')] }), true);
    expect(c.units).toEqual({ done: 2, total: 2 });
    expect(c.percent).toBe(100);
    expect(c.estimate).toEqual({ kind: 'done' });
  });
  it('lists the tabs of the card and of its subtasks once, needs-you first', () => {
    const t1 = tab('t1', 'working');
    const t2 = tab('t2', 'waiting_permission');
    const c = aggregateCard(card({ id: '2', tab: t1, subtasks: [sub('3', 'todo', { tab: t2 }), sub('4', 'todo', { tab: t1 })] }), true);
    expect(c.agents?.map((a) => [a.tab_id, a.subtask_ref, a.needs_you])).toEqual([
      ['t2', 'TER-3', true],
      ['t1', null, false],
    ]);
  });
  it('hides agents when the caller cannot read terminals', () => {
    expect(aggregateCard(card({ id: '2', tab: tab('t1', 'working') }), false).agents).toBeNull();
  });
  it('estimates from the subtasks finish times', () => {
    const c = aggregateCard(card({ id: '2', started_at: at(0), subtasks: [sub('3', 'done', { done_at: at(10) }), sub('4', 'done', { done_at: at(20) }), sub('5', 'todo')] }), true);
    expect(c.estimate).toMatchObject({ kind: 'range', basis: 'wall_clock', samples: 2 });
  });
});

describe('aggregateEpic', () => {
  const ranged = (id: string, active: number) => card({ id, active_seconds: active, subtasks: [sub(`${id}a`, 'done'), sub(`${id}b`, 'done'), sub(`${id}c`, 'todo')] });

  it('sums units across cards, backlog included and reported apart', () => {
    const e = aggregateEpic(epic([card({ id: '2', subtasks: [sub('3', 'done'), sub('4', 'todo')] }), card({ id: '5', status: 'backlog', column_name: null })]), true);
    expect(e.units).toEqual({ done: 1, total: 3, backlog_total: 1 });
    expect(e.percent).toBe(33);
  });
  it('orders cards doing, todo, done, backlog, then by position', () => {
    const e = aggregateEpic(epic([card({ id: 'b', status: 'backlog' }), card({ id: 'd', status: 'done' }), card({ id: 't', status: 'todo' }), card({ id: 'x', position: 1 }), card({ id: 'y', position: 0 })]), true);
    expect(e.cards.map((c) => c.id)).toEqual(['y', 'x', 't', 'd', 'b']);
  });
  it('takes the longest range among doing cards, never the sum', () => {
    const e = aggregateEpic(epic([ranged('2', 1200), ranged('6', 2400)]), true);
    // card 6: 1200 s per unit, 1 left → [600, 2400]; card 2: [300, 1200]
    expect(e.estimate).toEqual({ kind: 'range', low_s: 600, high_s: 2400, basis: 'agent_time', samples: 2 });
  });
  it('counts open cards without an estimate', () => {
    const e = aggregateEpic(epic([ranged('2', 1200), card({ id: '7', status: 'todo' }), card({ id: '8' }), card({ id: '9', status: 'backlog' })]), true);
    expect(e.cards_without_estimate).toBe(2);
  });
  it('is done when every card is done', () => {
    expect(aggregateEpic(epic([card({ id: '2', status: 'done' })]), true).estimate).toEqual({ kind: 'done' });
  });
  it('counts distinct agents by state', () => {
    const t1 = tab('t1', 'working');
    const e = aggregateEpic(epic([card({ id: '2', tab: t1 }), card({ id: '3', tab: tab('t2', 'waiting_input'), subtasks: [sub('4', 'todo', { tab: t1 })] }), card({ id: '5', tab: tab('t3', null) })]), true);
    expect(e.agents).toEqual({ working: 1, needs_you: 1, idle: 1 });
  });
});

describe('CI summary', () => {
  const badge = (over: Partial<PullRequestBadge>): PullRequestBadge => ({
    number: 1, url: 'u', title: 't', state: 'open', draft: false, ci_state: 'passed',
    ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'none', deploy_url: null, ...over,
  });
  it('is null when no card has a PR', () => {
    expect(aggregateEpic(epic([card({ id: '2' })]), true).ci).toBeNull();
  });
  it('counts PRs once per number across cards', () => {
    const shared = badge({ number: 7, ci_state: 'failed' });
    const e = aggregateEpic(epic([
      card({ id: '2', pull_requests: [shared, badge({ number: 8, ci_state: 'running' })] }),
      card({ id: '3', pull_requests: [shared, badge({ number: 9, state: 'merged', deploy_state: 'passed' }), badge({ number: 10, state: 'merged', deploy_state: 'failed' })] }),
    ]), true);
    expect(e.ci).toEqual({ open: 2, failed: 2, running: 1, deployed: 1 });
    expect(e.cards[0].pull_requests.map((p) => p.number)).toEqual([7, 8]);
  });
});

describe('selectEpics', () => {
  const doing = aggregateEpic(epic([card({ id: '2' })], 'a'), true);
  const todoOnly = aggregateEpic(epic([card({ id: '3', status: 'todo' })], 'b'), true);
  const empty = aggregateEpic(epic([], 'c'), true);
  const finished = aggregateEpic(epic([card({ id: '4', status: 'done' })], 'd'), true);
  const waiting = aggregateEpic(epic([card({ id: '5', tab: tab('t9', 'waiting_input') })], 'e'), true);

  it('active keeps epics with a card in doing, needs-you first', () => {
    expect(selectEpics([doing, todoOnly, empty, finished, waiting], 'active').map((e) => e.id)).toEqual(['e', 'a']);
  });
  it('all keeps every epic with cards, finished ones last', () => {
    expect(selectEpics([finished, todoOnly, doing, empty], 'all').map((e) => e.id)).toEqual(['a', 'b', 'd']);
  });
});

describe('an agent waiting on its own background work (TER-644)', () => {
  it('is sent as working with background: true, so an app that predates the state still parses it, and counts as working', () => {
    const e = aggregateEpic(epic([card({ id: '2', tab: tab('t1', 'waiting_background') }), card({ id: '3', tab: tab('t2', 'working') })]), true);
    expect(e.cards[0]!.agents![0]).toMatchObject({ state: 'working', background: true, needs_you: false });
    expect(e.cards[1]!.agents![0]).toMatchObject({ state: 'working', background: false });
    expect(e.agents).toEqual({ working: 2, needs_you: 0, idle: 0 });
    // the shared contract accepts it, and an older payload without the flag reads as false
    expect(() => progressResponse.parse({ epics: [e], generated_at: at(0).toISOString() })).not.toThrow();
    const { background: _b, ...older } = e.cards[0]!.agents![0]!;
    expect(agentOnCard.parse(older).background).toBe(false);
  });
});
