import type { AgentOnCard, CardProgress, EpicProgress, ProgressEstimate, ProgressScope, PullRequestBadge } from '@termhub/mobile-api';
import type { TabState } from '../db/repositories/types.js';
import { NEEDS_YOU } from '../monitor/state.js';
import { estimateCard } from './estimate.js';

type TaskStatus = 'backlog' | 'todo' | 'doing' | 'done';
type Range = Extract<ProgressEstimate, { kind: 'range' }>;

export interface ProgressTabRow {
  id: string;
  name: string;
  machine_name: string;
  state: TabState | null;
  state_at: Date | null;
  activity: string | null;
  activity_verb: string | null;
  rate_limited_at: Date | null;
}
export interface ProgressSubtaskRow { id: string; ref: string; status: TaskStatus; done_at: Date | null; tab: ProgressTabRow | null }
export interface ProgressCardRow {
  id: string;
  ref: string;
  title: string;
  type: string;
  status: TaskStatus;
  position: number;
  column_name: string | null;
  started_at: Date | null;
  done_at: Date | null;
  active_seconds: number;
  tab: ProgressTabRow | null;
  subtasks: ProgressSubtaskRow[];
  pull_requests: PullRequestBadge[];
}
export interface ProgressEpicRow { id: string; ref: string; title: string; project: { id: string; key: string; name: string }; cards: ProgressCardRow[] }

const STATUS_ORDER: Record<TaskStatus, number> = { doing: 0, todo: 1, done: 2, backlog: 3 };
const iso = (d: Date | null) => d?.toISOString() ?? null;
const percentOf = (u: { done: number; total: number }) => (u.total === 0 ? 0 : Math.round((u.done / u.total) * 100));

/** Each subtask is a unit; a card without subtasks is one; a done card has all its units done (spec D3). */
function unitsOf(card: ProgressCardRow): { done: number; total: number } {
  const total = card.subtasks.length || 1;
  if (card.status === 'done') return { done: total, total };
  if (card.subtasks.length === 0) return { done: 0, total };
  return { done: card.subtasks.filter((s) => s.status === 'done').length, total };
}

function agentOf(tab: ProgressTabRow, subtaskRef: string | null): AgentOnCard {
  return {
    tab_id: tab.id,
    tab_name: tab.name,
    machine_name: tab.machine_name,
    subtask_ref: subtaskRef,
    // the contract's state predates `waiting_background`: still at work, flagged (TER-644)
    state: tab.state === 'waiting_background' ? 'working' : tab.state,
    state_at: iso(tab.state_at),
    background: tab.state === 'waiting_background',
    needs_you: tab.state !== null && NEEDS_YOU.includes(tab.state),
    activity: tab.activity,
    activity_verb: tab.activity_verb,
    rate_limited: tab.rate_limited_at !== null,
  };
}

/** The card's own tab, then each subtask's, each tab once; the ones waiting for the user first. */
function agentsOf(card: ProgressCardRow): AgentOnCard[] {
  const byTab = new Map<string, AgentOnCard>();
  if (card.tab) byTab.set(card.tab.id, agentOf(card.tab, null));
  for (const s of card.subtasks) if (s.tab && !byTab.has(s.tab.id)) byTab.set(s.tab.id, agentOf(s.tab, s.ref));
  return [...byTab.values()].sort((a, b) => Number(b.needs_you) - Number(a.needs_you));
}

export function aggregateCard(card: ProgressCardRow, includeAgents: boolean): CardProgress {
  const units = unitsOf(card);
  const finished = (card.subtasks.length > 0 ? card.subtasks.map((s) => s.done_at) : [card.done_at]).filter((d): d is Date => d !== null);
  return {
    id: card.id,
    ref: card.ref,
    title: card.title,
    type: card.type,
    status: card.status,
    column_name: card.column_name,
    units,
    percent: percentOf(units),
    started_at: iso(card.started_at),
    done_at: iso(card.done_at),
    active_seconds: card.active_seconds,
    estimate: estimateCard({ status: card.status, units, active_seconds: card.active_seconds, started_at: card.started_at, unit_done_at: finished }),
    agents: includeAgents ? agentsOf(card) : null,
    pull_requests: card.pull_requests,
  };
}

/** The longest range among the cards in doing: they run in parallel, so never a sum (spec D5). */
function epicEstimate(cards: CardProgress[]): ProgressEstimate {
  if (cards.length > 0 && cards.every((c) => c.status === 'done')) return { kind: 'done' };
  const doing = cards.filter((c) => c.status === 'doing');
  const ranges = doing.map((c) => c.estimate).filter((e): e is Range => e.kind === 'range');
  if (ranges.length === 0) return { kind: 'none', reason: doing.length > 0 ? 'few_samples' : 'not_started' };
  return {
    kind: 'range',
    low_s: Math.max(...ranges.map((r) => r.low_s)),
    high_s: Math.max(...ranges.map((r) => r.high_s)),
    basis: ranges.every((r) => r.basis === 'agent_time') ? 'agent_time' : 'wall_clock',
    samples: Math.min(...ranges.map((r) => r.samples)),
  };
}

function agentCounts(cards: CardProgress[]): { working: number; needs_you: number; idle: number } {
  const byTab = new Map<string, AgentOnCard>();
  for (const c of cards) for (const a of c.agents ?? []) byTab.set(a.tab_id, a);
  const counts = { working: 0, needs_you: 0, idle: 0 };
  for (const a of byTab.values()) {
    if (a.needs_you) counts.needs_you++;
    else if (a.state === 'working') counts.working++;
    else counts.idle++;
  }
  return counts;
}

/** Each PR counted once by number across the epic's cards (spec 2026-09-26 progress-panel §5.2). */
function ciSummary(cards: CardProgress[]): EpicProgress['ci'] {
  const byNumber = new Map<number, PullRequestBadge>();
  for (const c of cards) for (const p of c.pull_requests) byNumber.set(p.number, p);
  if (byNumber.size === 0) return null;
  const ci = { open: 0, failed: 0, running: 0, deployed: 0 };
  for (const p of byNumber.values()) {
    if (p.state === 'open') ci.open++;
    if ((p.state === 'open' && p.ci_state === 'failed') || p.deploy_state === 'failed') ci.failed++;
    if ((p.state === 'open' && p.ci_state === 'running') || p.deploy_state === 'running') ci.running++;
    if (p.deploy_state === 'passed') ci.deployed++;
  }
  return ci;
}

export function aggregateEpic(epic: ProgressEpicRow, includeAgents: boolean): EpicProgress {
  const ordered = [...epic.cards].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.position - b.position);
  const cards = ordered.map((c) => aggregateCard(c, includeAgents));
  const units = { done: 0, total: 0, backlog_total: 0 };
  for (const c of cards) {
    units.done += c.units.done;
    units.total += c.units.total;
    if (c.status === 'backlog') units.backlog_total += c.units.total;
  }
  return {
    id: epic.id,
    ref: epic.ref,
    title: epic.title,
    project: epic.project,
    units,
    percent: percentOf(units),
    estimate: epicEstimate(cards),
    cards_without_estimate: cards.filter((c) => (c.status === 'todo' || c.status === 'doing') && c.estimate.kind === 'none').length,
    agents: includeAgents ? agentCounts(cards) : null,
    cards,
    ci: ciSummary(cards),
    ci_error: null,
  };
}

/** active: epics with a card in doing; all: every epic with cards, finished last. Needs-you first, then working agents, then ref. */
export function selectEpics(epics: EpicProgress[], scope: ProgressScope): EpicProgress[] {
  const kept = epics.filter((e) => e.cards.length > 0 && (scope === 'all' || e.cards.some((c) => c.status === 'doing')));
  const finished = (e: EpicProgress) => Number(e.estimate.kind === 'done');
  return kept.sort(
    (a, b) =>
      finished(a) - finished(b) ||
      (b.agents?.needs_you ?? 0) - (a.agents?.needs_you ?? 0) ||
      (b.agents?.working ?? 0) - (a.agents?.working ?? 0) ||
      a.ref.localeCompare(b.ref, undefined, { numeric: true }),
  );
}
