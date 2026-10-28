import type { CiState, PrState, ReleaseRun } from '../db/repositories/task-pull-requests.js';
import type { TaskStatus, TaskType } from '../db/repositories/types.js';
import type { ProjectSetupData } from '../setup/schema.js';
import { deliveryPending } from './delivery.js';
import type { MergeWait } from './merge-wait.js';

/*
 * TER-1150: an automatic epic is born and dies. It is born when its first card starts (the epic branch is
 * made and the epic goes to Fazendo); it lives while its cards are made and merged into the epic branch; it
 * integrates once they are all done (the integrator's PR, epic branch → base); it delivers once that PR is
 * merged (the deploy and release runs of the merge); and it dies only when that delivery is through: then it
 * goes to Feito by itself, its branch is deleted and its runs' worktrees and tabs are cleaned up. This file is
 * the pure reading of where an epic is; `epic-lifecycle.ts` acts on it.
 */

export type EpicPhase = 'not_started' | 'in_progress' | 'integrating' | 'delivering' | 'failed' | 'done';
export type EpicFailure = 'ci' | 'conflict' | 'deploy' | 'release';

/** What the phase reads of a PR row. */
export interface LifecyclePr {
  number: number;
  state: PrState;
  head_ref: string;
  ci_state: CiState;
  deploy_state: CiState;
  release_runs: ReleaseRun[];
  changed_level: string | null;
  mention_only?: boolean;
}

/** How a merged PR's delivery stands: its deploy and release runs (the ones the setup follows). */
export function deliveryOf(setup: ProjectSetupData, pr: LifecyclePr): { state: 'pending' | 'ok' | 'failed'; failure: EpicFailure | null } {
  if (pr.deploy_state === 'failed') return { state: 'failed', failure: 'deploy' };
  if (pr.release_runs.some((r) => r.state === 'failed')) return { state: 'failed', failure: 'release' };
  return { state: deliveryPending(setup, pr) ? 'pending' : 'ok', failure: null };
}

/** The epic's own PRs: the ones from its branch (every repository of a multi-repo project), never one that only cites it. */
export function epicPullsOf<T extends LifecyclePr>(prs: T[], branch: string | null): T[] {
  return prs.filter((p) => !p.mention_only && (branch === null || p.head_ref === branch));
}

/**
 * Where an automatic epic is (TER-1150). `wait` is the merge executor's wait on the epic's PR, when it holds
 * it: the conflict or red-CI caps mean the fixes ran out. An epic in Feito is done whatever its PRs say.
 */
export function epicPhaseOf<T extends LifecyclePr>(i: {
  status: TaskStatus;
  cards: Array<{ type: TaskType; status: TaskStatus }>;
  epicPrs: T[];
  setup: ProjectSetupData;
  wait?: MergeWait | null;
}): { phase: EpicPhase; failure: EpicFailure | null; pr: T | null } {
  if (i.status === 'done') return { phase: 'done', failure: null, pr: i.epicPrs.find((p) => p.state === 'merged') ?? null };
  const live = [...i.epicPrs].filter((p) => p.state !== 'closed').sort((a, b) => b.number - a.number);
  const open = live.filter((p) => p.state === 'open');
  if (open.length > 0) {
    const red = open.find((p) => p.ci_state === 'failed');
    if (red || i.wait === 'merge_ci_cap') return { phase: 'failed', failure: 'ci', pr: red ?? open[0]! };
    if (i.wait === 'merge_conflict_cap') return { phase: 'failed', failure: 'conflict', pr: open[0]! };
    return { phase: 'integrating', failure: null, pr: open[0]! };
  }
  if (live.length > 0) {
    for (const p of live) {
      const d = deliveryOf(i.setup, p);
      if (d.state === 'failed') return { phase: 'failed', failure: d.failure, pr: p };
    }
    return { phase: 'delivering', failure: null, pr: live[0]! };
  }
  const cards = i.cards.filter((c) => c.type !== 'epic');
  if (cards.length > 0 && cards.every((c) => c.status === 'done')) return { phase: 'integrating', failure: null, pr: null };
  if (i.status === 'doing' || cards.some((c) => c.status === 'doing' || c.status === 'done')) return { phase: 'in_progress', failure: null, pr: null };
  return { phase: 'not_started', failure: null, pr: null };
}

/**
 * Whether the epic may die (TER-1150): every card done, no PR of its cards still open, its own PR(s) merged
 * and every merge delivered. Never with a card out of Feito, an open PR or a delivery pending or failed.
 */
export function epicMayDie(i: { cards: Array<{ type: TaskType; status: TaskStatus }>; cardPrs: LifecyclePr[]; epicPrs: LifecyclePr[]; setup: ProjectSetupData }): boolean {
  const cards = i.cards.filter((c) => c.type !== 'epic');
  if (cards.length === 0 || cards.some((c) => c.status !== 'done')) return false;
  if (i.cardPrs.some((p) => !p.mention_only && p.state === 'open')) return false;
  const own = i.epicPrs.filter((p) => p.state !== 'closed');
  if (own.length === 0 || own.some((p) => p.state !== 'merged')) return false;
  return own.every((p) => deliveryOf(i.setup, p).state === 'ok');
}
